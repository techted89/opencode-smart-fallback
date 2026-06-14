/**
 * opencode-smart-fallback — Multi-API-key rotation, model fallback,
 * rate-limit-smart system plugin for OpenCode.
 *
 * Two-Tier Fallback Strategy:
 *  1. Free Model Pool: Fall back to opencode/nim/mistral free models first
 *  2. Key Rotation: When all free models rate-limited, rotate API keys across providers
 *
 * Features:
 *   - Multi API Key Rotation (round-robin per provider with health tracking)
 *   - Free Model Pool Fallback (cross-provider fallback for free tiers)
 *   - Rate Limit Smart Handling (Retry-After parsing, exponential backoff + jitter)
 *   - Per-Model Cooldown (exponential penalty for repeated failures)
 *   - Large Context Auto-Switch (context overflow detection)
 *   - Per-Agent Configuration with inheritance
 *   - State Persistence across restarts
 *
 * Register in opencode.json:
 *   { "plugin": ["./plugins/opencode-smart-fallback.ts"] }
 *
 * Config auto-generated at ~/.config/opencode/opencode-smart-fallback.json
 */

import type { Plugin, Config, Hooks, PluginOptions } from "@opencode-ai/plugin";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { createSignal } from "solid-js";
import type { JSX } from "@opentui/solid/jsx-runtime";

// ─── Types ───────────────────────────────────────────────────────────────────

interface BackoffConfig {
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
}

interface AgentFallbackConfig {
  /** Primary fallback chain (can be free models or any models) */
  fallbackModels: string[];
  /** API keys per provider for key rotation */
  apiKeys: Record<string, string[]>;
  /** Free model pool for rate-limit fallback { providerId: [modelIds] } */
  providerFreeModels?: Record<string, string[]>;
  /** Large context model override */
  largeContextModel?: string;
  contextThreshold: number;
  cooldownSeconds: number;
  maxRetries: number;
  backoff: BackoffConfig;
}

interface SmartFallbackConfig {
  defaults: AgentFallbackConfig;
  agents: Record<string, Partial<AgentFallbackConfig>>;
  statePath?: string;
  notifications: boolean;
  /** Minimum log level to display. Default: "info" */
  logLevel?: "error" | "warn" | "info" | "debug";
}

interface ModelCooldown {
  until: number;
  penalty: number;
}

interface KeyState {
  currentIndex: number;
  keys: string[];
  failures: number[];
  until: number[];
}

interface ProviderCooldown {
  until: number;
  consecutiveFailures: number;
}

interface PersistedState {
  models: Record<string, ModelCooldown>;
  keys: Record<string, KeyState>;
  /** Provider-level cooldowns: when a provider shows repeated failures, avoid it entirely */
  providerCooldowns: Record<string, ProviderCooldown>;
  version: number;
}

type ErrorClass = "auth" | "rate_limit" | "retryable" | "context" | "non_retryable" | "unknown";

// ─── Model Discovery Types ────────────────────────────────────────────────────

interface ModelInfo {
  id: string;
  provider: string;
  isFree: boolean;
  name: string;
  contextWindow?: number;
}

interface ModelDiscoveryCache {
  models: ModelInfo[];
  fetchedAt: number;
  ttlMs: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const CONFIG_PATH = join(homedir(), ".config", "opencode", "opencode-smart-fallback.json");
const DEFAULT_STATE_PATH = join(homedir(), ".config", "opencode", "opencode-smart-fallback-state.json");
const STATE_VERSION = 1;

/** Default free model pool ordered by preference (used when fallbackModels is empty) */
const DEFAULT_FREE_MODEL_POOL: string[] = [
  "opencode/nemotron-3-ultra-free",
  "opencode/mimo-v2.5-free",
  "opencode/deepseek-v4-flash-free",
  "opencode/north-mini-code-free",
  "openrouter/nvidia/nemotron-3-nano-30b-a3b:free",
  "openrouter/nvidia/nemotron-mini-4b-instruct:free",
  "openrouter/google/gemma-4-26b-a4b-it:free",
  "openrouter/meta-llama/llama-3.3-70b-instruct:free",
  "openrouter/openai/gpt-oss-20b:free",
  "openrouter/qwen/qwen3-coder:free",
];

/** Default free models per provider for key rotation context */
const DEFAULT_PROVIDER_FREE_MODELS: Record<string, string[]> = {
  opencode: ["opencode/nemotron-3-ultra-free", "opencode/mimo-v2.5-free", "opencode/deepseek-v4-flash-free"],
  nvidia: ["openrouter/nvidia/nemotron-3-nano-30b-a3b:free", "openrouter/nvidia/nemotron-mini-4b-instruct:free"],
  openrouter: DEFAULT_FREE_MODEL_POOL,
  mistral: ["openrouter/meta-llama/llama-3.3-70b-instruct:free", "mistral/mistral-small-3.1-latest", "mistral/mistral-small-3.0-latest", "mistral/mistral-nemo-latest"],
};

/** Comprehensive known models registry with provider and free/paid metadata */
const KNOWN_MODELS: ModelInfo[] = [
  // ── OpenCode Free ──
  { id: "opencode/nemotron-3-ultra-free", provider: "opencode", isFree: true, name: "Nemotron 3 Ultra Free", contextWindow: 128000 },
  { id: "opencode/mimo-v2.5-free", provider: "opencode", isFree: true, name: "Mimo v2.5 Free", contextWindow: 128000 },
  { id: "opencode/deepseek-v4-flash-free", provider: "opencode", isFree: true, name: "DeepSeek V4 Flash Free", contextWindow: 128000 },
  { id: "opencode/north-mini-code-free", provider: "opencode", isFree: true, name: "North Mini Code Free", contextWindow: 128000 },
  // ── OpenRouter Free ──
  { id: "openrouter/nvidia/nemotron-3-nano-30b-a3b:free", provider: "openrouter", isFree: true, name: "Nemotron 3 Nano 30B A3B (free)", contextWindow: 128000 },
  { id: "openrouter/nvidia/nemotron-mini-4b-instruct:free", provider: "openrouter", isFree: true, name: "Nemotron Mini 4B (free)", contextWindow: 32000 },
  { id: "openrouter/google/gemma-4-26b-a4b-it:free", provider: "openrouter", isFree: true, name: "Gemma 4 26B (free)", contextWindow: 32000 },
  { id: "openrouter/meta-llama/llama-3.3-70b-instruct:free", provider: "openrouter", isFree: true, name: "Llama 3.3 70B (free)", contextWindow: 128000 },
  { id: "openrouter/openai/gpt-oss-20b:free", provider: "openrouter", isFree: true, name: "GPT-OSS 20B (free)", contextWindow: 32000 },
  { id: "openrouter/qwen/qwen3-coder:free", provider: "openrouter", isFree: true, name: "Qwen3 Coder (free)", contextWindow: 32000 },
  // ── OpenRouter Paid ──
  { id: "openrouter/anthropic/claude-3.5-sonnet", provider: "openrouter", isFree: false, name: "Claude 3.5 Sonnet", contextWindow: 200000 },
  { id: "openrouter/anthropic/claude-3-opus", provider: "openrouter", isFree: false, name: "Claude 3 Opus", contextWindow: 200000 },
  { id: "openrouter/anthropic/claude-3-haiku", provider: "openrouter", isFree: false, name: "Claude 3 Haiku", contextWindow: 200000 },
  { id: "openrouter/anthropic/claude-3.5-haiku", provider: "openrouter", isFree: false, name: "Claude 3.5 Haiku", contextWindow: 200000 },
  { id: "openrouter/openai/gpt-4o", provider: "openrouter", isFree: false, name: "GPT-4o", contextWindow: 128000 },
  { id: "openrouter/openai/gpt-4o-mini", provider: "openrouter", isFree: false, name: "GPT-4o Mini", contextWindow: 128000 },
  { id: "openrouter/openai/gpt-4-turbo", provider: "openrouter", isFree: false, name: "GPT-4 Turbo", contextWindow: 128000 },
  { id: "openrouter/openai/o1-mini", provider: "openrouter", isFree: false, name: "o1 Mini", contextWindow: 128000 },
  { id: "openrouter/openai/o3-mini", provider: "openrouter", isFree: false, name: "o3 Mini", contextWindow: 200000 },
  { id: "openrouter/google/gemini-2.0-flash", provider: "openrouter", isFree: false, name: "Gemini 2.0 Flash", contextWindow: 1048576 },
  { id: "openrouter/google/gemini-2.0-pro", provider: "openrouter", isFree: false, name: "Gemini 2.0 Pro", contextWindow: 1048576 },
  { id: "openrouter/meta-llama/llama-3.1-405b", provider: "openrouter", isFree: false, name: "Llama 3.1 405B", contextWindow: 128000 },
  { id: "openrouter/meta-llama/llama-3.1-70b", provider: "openrouter", isFree: false, name: "Llama 3.1 70B", contextWindow: 128000 },
  { id: "openrouter/mistral/mistral-large-2", provider: "openrouter", isFree: false, name: "Mistral Large 2", contextWindow: 128000 },
  { id: "openrouter/mistral/mistral-small-2", provider: "openrouter", isFree: false, name: "Mistral Small 2", contextWindow: 32000 },
  { id: "openrouter/deepseek/deepseek-r1", provider: "openrouter", isFree: false, name: "DeepSeek R1", contextWindow: 128000 },
  { id: "openrouter/deepseek/deepseek-v3", provider: "openrouter", isFree: false, name: "DeepSeek V3", contextWindow: 128000 },
  // ── OpenCode Paid / Inference ──
  { id: "opencode/nemotron-3-ultra", provider: "opencode", isFree: false, name: "Nemotron 3 Ultra", contextWindow: 128000 },
  { id: "opencode/deepseek-v4", provider: "opencode", isFree: false, name: "DeepSeek V4", contextWindow: 128000 },
  { id: "opencode/north-mixtral", provider: "opencode", isFree: false, name: "North Mixtral", contextWindow: 32000 },
  // ── Nvidia NIM Free ──
  { id: "nvidia/nemotron-4-340b-instruct", provider: "nvidia", isFree: true, name: "Nemotron 4 340B (NIM free)", contextWindow: 4096 },
  { id: "nvidia/llama-3.1-nemotron-70b-instruct", provider: "nvidia", isFree: true, name: "Llama Nemotron 70B (NIM free)", contextWindow: 128000 },
  // ── Mistral API (via direct API / opencode proxy) ──
  { id: "mistral/mistral-small-3.1-latest", provider: "mistral", isFree: true, name: "Mistral Small 3.1 (free tier)", contextWindow: 32000 },
  { id: "mistral/mistral-small-3.0-latest", provider: "mistral", isFree: true, name: "Mistral Small 3.0 (free tier)", contextWindow: 32000 },
  { id: "mistral/mistral-nemo-latest", provider: "mistral", isFree: true, name: "Mistral Nemo (free tier)", contextWindow: 128000 },
  { id: "mistral/mistral-large-2", provider: "mistral", isFree: false, name: "Mistral Large 2", contextWindow: 128000 },
  { id: "mistral/mistral-small-2", provider: "mistral", isFree: false, name: "Mistral Small 2", contextWindow: 32000 },
  { id: "mistral/codestral-latest", provider: "mistral", isFree: false, name: "Codestral", contextWindow: 32000 },
  { id: "mistral/mixtral-8x22b-instruct", provider: "mistral", isFree: false, name: "Mixtral 8x22B", contextWindow: 64000 },
  { id: "mistral/mixtral-8x7b-instruct", provider: "mistral", isFree: false, name: "Mixtral 8x7B", contextWindow: 32000 },
];

/** Fetch available models from OpenRouter API, falling back to KNOWN_MODELS */
let _modelCache: ModelDiscoveryCache | null = null;

async function fetchAvailableModels(): Promise<ModelInfo[]> {
  // Return cached result if still fresh
  if (_modelCache && Date.now() - _modelCache.fetchedAt < _modelCache.ttlMs) {
    return _modelCache.models;
  }

  const providers = [...new Set(KNOWN_MODELS.map((m) => m.provider))];

  try {
    const resp = await fetch("https://openrouter.ai/api/v1/models", {
      signal: AbortSignal.timeout(8000),
    });
    if (resp.ok) {
      const body = (await resp.json()) as {
        data?: Array<{ id: string; name?: string; pricing?: { prompt?: string; completion?: string }; context_length?: number }>;
      };
      if (body?.data && Array.isArray(body.data)) {
        const liveModels: ModelInfo[] = body.data.map((m) => {
          const promptPrice = parseFloat(m.pricing?.prompt ?? "999");
          const completionPrice = parseFloat(m.pricing?.completion ?? "999");
          const isFree = promptPrice === 0 && completionPrice === 0;
          // Extract provider from model id (e.g. "openai/gpt-4" → "openai")
          const provider = m.id.includes("/") ? m.id.split("/")[0] : "unknown";
          return {
            id: m.id,
            provider,
            isFree,
            name: m.name ?? m.id,
            contextWindow: m.context_length ?? undefined,
          };
        });
        // Merge with known models to ensure our curated metadata is included
        const knownMap = new Map<string, ModelInfo>();
        for (const km of KNOWN_MODELS) knownMap.set(km.id, km);
        for (const lm of liveModels) {
          const existing = knownMap.get(lm.id);
          if (existing) {
            // Keep our curated isFree/provider but update name/context from live data
            knownMap.set(lm.id, { ...existing, name: lm.name, contextWindow: lm.contextWindow ?? existing.contextWindow });
          } else {
            knownMap.set(lm.id, lm);
          }
        }
        const merged = [...knownMap.values()];
        _modelCache = { models: merged, fetchedAt: Date.now(), ttlMs: 300_000 }; // 5 min cache
        return merged;
      }
    }
  } catch {
    // Network error — use cached or fallback
  }

  // Fallback to known models
  _modelCache = { models: [...KNOWN_MODELS], fetchedAt: Date.now(), ttlMs: 60_000 };
  return [...KNOWN_MODELS];
}

/** Get unique providers from a model list, sorted */
function getModelProviders(models: ModelInfo[]): string[] {
  return [...new Set(models.map((m) => m.provider))].sort();
}

/** Sort models by the given strategy */
function sortModels(models: ModelInfo[], strategy: "free-first" | "alpha" | "provider" | "context"): ModelInfo[] {
  const sorted = [...models];
  switch (strategy) {
    case "free-first":
      sorted.sort((a, b) => {
        if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
        return a.id.localeCompare(b.id);
      });
      break;
    case "alpha":
      sorted.sort((a, b) => a.id.localeCompare(b.id));
      break;
    case "provider":
      sorted.sort((a, b) => {
        const pc = a.provider.localeCompare(b.provider);
        if (pc !== 0) return pc;
        return a.id.localeCompare(b.id);
      });
      break;
    case "context":
      sorted.sort((a, b) => {
        const ca = a.contextWindow ?? 0;
        const cb = b.contextWindow ?? 0;
        if (ca !== cb) return cb - ca; // largest first
        return a.id.localeCompare(b.id);
      });
      break;
  }
  return sorted;
}

/** Filter models by provider (null = all) */
function filterModelsByProvider(models: ModelInfo[], provider: string | null): ModelInfo[] {
  return provider ? models.filter((m) => m.provider === provider) : models;
}

/** Extract the provider prefix from a model ID (e.g. "openrouter/gpt-4" → "openrouter") */
function extractProvider(modelId: string): string {
  const parts = modelId.split("/");
  return parts.length >= 2 ? parts[0] : "unknown";
}

/**
 * Interleave a model list so consecutive models are from different providers.
 * This prevents cascading failures when a single provider is rate-limited.
 *
 * Algorithm: groups models by provider, then round-robins across groups.
 *
 * Example:
 *   Input:  [opencode/a, opencode/b, openrouter/c, opencode/d]
 *   Output: [opencode/a, openrouter/c, opencode/b, opencode/d]
 */
function interleaveProviders(models: string[]): string[] {
  if (models.length <= 1) return [...models];

  // Group by provider, preserving original order within each group
  const groups = new Map<string, string[]>();
  for (const m of models) {
    const provider = extractProvider(m);
    if (!groups.has(provider)) groups.set(provider, []);
    groups.get(provider)!.push(m);
  }

  // If all same provider, no interleaving needed
  if (groups.size <= 1) return [...models];

  // Round-robin across provider groups
  const result: string[] = [];
  const entries = [...groups.entries()]; // [[provider, [models]]]
  const indices = new Array(entries.length).fill(0);
  let remaining = models.length;

  while (remaining > 0) {
    for (let i = 0; i < entries.length; i++) {
      const [, groupModels] = entries[i];
      if (indices[i] < groupModels.length) {
        result.push(groupModels[indices[i]++]);
        remaining--;
      }
    }
  }
  return result;
}

const DEFAULT_CONFIG: SmartFallbackConfig = {
  defaults: {
    fallbackModels: [],
    apiKeys: {},
    providerFreeModels: DEFAULT_PROVIDER_FREE_MODELS,
    contextThreshold: 0.85,
    cooldownSeconds: 30,
    maxRetries: 3,
    backoff: { initialDelayMs: 1000, maxDelayMs: 60000, multiplier: 2 },
  },
  agents: {},
  notifications: true,
  logLevel: "info",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function deepMerge<T extends Record<string, any>>(a: T, b: Partial<T>): T {
  const result: Record<string, any> = { ...a };
  for (const key of Object.keys(b)) {
    const bVal = (b as any)[key];
    if (bVal === undefined) continue;
    if (
      typeof bVal === "object" && bVal !== null && !Array.isArray(bVal) &&
      typeof result[key] === "object" && result[key] !== null && !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], bVal);
    } else {
      result[key] = bVal;
    }
  }
  return result as T;
}

function loadConfig(): SmartFallbackConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = readFileSync(CONFIG_PATH, "utf-8");
      const parsed = JSON.parse(raw) as Partial<SmartFallbackConfig>;
      return deepMerge(DEFAULT_CONFIG, parsed);
    }
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function writeDefaultConfig(): void {
  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
    log("info", "Config created", `Default config written to ${CONFIG_PATH}`);
  }
}

let notificationsEnabled = true;
let minLogLevel = 1; // 0=error, 1=warn, 2=info, 3=debug
const LOG_LEVEL_MAP: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3 };
const LOG_LEVEL_NAMES = ["error", "warn", "info", "debug"] as const;

function setLogLevel(level: string): void {
  const idx = LOG_LEVEL_MAP[level];
  if (idx !== undefined) minLogLevel = idx;
}

function log(level: "info" | "warn" | "error" | "debug", tag: string, message: string): void {
  if (!notificationsEnabled) return;
  if (LOG_LEVEL_MAP[level] > minLogLevel) return;
  const prefix = `[smart-fallback:${level}]`;
  switch (level) {
    case "error": console.error(`${prefix} ${tag}: ${message}`); break;
    case "warn": console.warn(`${prefix} ${tag}: ${message}`); break;
    default: console.log(`${prefix} ${tag}: ${message}`);
  }
}

function parseRetryAfter(header: string | undefined): number | null {
  if (!header) return null;

  // Trim whitespace
  const trimmed = header.trim();

  // 1. Numeric seconds (including decimals, leading zeros)
  const num = Number(trimmed);
  if (!isNaN(num) && num >= 0) {
    // Cap at 1 hour to prevent absurd wait times
    return Math.min(num * 1000, 3600000);
  }

  // 2. Human-readable: "X seconds", "X minutes", "X second", "X minute"
  const humanMatch = trimmed.match(/^(\d+)\s*(second|seconds|minute|minutes|sec|min)$/i);
  if (humanMatch) {
    const value = parseInt(humanMatch[1], 10);
    const unit = humanMatch[2].toLowerCase();
    if (unit.startsWith("min")) return Math.min(value * 60000, 3600000);
    return Math.min(value * 1000, 3600000);
  }

  // 3. HTTP-date format (e.g., "Wed, 21 Oct 2015 07:28:00 GMT")
  const parsed = Date.parse(trimmed);
  if (!isNaN(parsed)) {
    const delay = parsed - Date.now();
    return delay > 0 ? Math.min(delay, 3600000) : null;
  }

  return null;
}

function withJitter(delayMs: number): number {
  return delayMs + (Math.random() * delayMs * 0.4 - delayMs * 0.2);
}

function classifyError(error: { name: string; data?: { statusCode?: number; isRetryable?: boolean; responseHeaders?: Record<string, string>; [key: string]: any } }): ErrorClass {
  switch (error.name) {
    case "ProviderAuthError":
      return "auth";
    case "MessageOutputLengthError":
      return "context";
    case "MessageAbortedError":
      return "non_retryable";
    case "UnknownError":
      return "unknown";
    case "APIError": {
      const status = error.data?.statusCode;
      if (status === 429) return "rate_limit";
      if (status && status >= 500 && status < 600) return "retryable";
      if (error.data?.isRetryable) return "retryable";
      if (status && status >= 400 && status < 500 && status !== 429) return "non_retryable";
      return "retryable";
    }
    default:
      return "unknown";
  }
}

const COOLDOWN_BY_CLASS: Record<ErrorClass, number> = {
  auth: 5 * 60 * 1000, rate_limit: 60 * 1000, retryable: 30 * 1000,
  context: 10 * 1000, non_retryable: 0, unknown: 30 * 1000,
};

function getCooldownDuration(errorClass: ErrorClass, error: { data?: { responseHeaders?: Record<string, string> } }, baseSeconds: number): number {
  if (errorClass === "rate_limit" && error.data?.responseHeaders?.["retry-after"]) {
    const retryAfter = parseRetryAfter(error.data.responseHeaders["retry-after"]);
    if (retryAfter !== null) return retryAfter;
  }
  return COOLDOWN_BY_CLASS[errorClass] ?? baseSeconds * 1000;
}

function isModelOnCooldown(state: PersistedState, modelId: string): boolean {
  const cd = state.models[modelId];
  return cd ? Date.now() < cd.until : false;
}

function getModelCooldownRemaining(state: PersistedState, modelId: string): number {
  const cd = state.models[modelId];
  return cd ? Math.max(0, cd.until - Date.now()) : 0;
}

function setModelCooldown(state: PersistedState, modelId: string, durationMs: number, statePath?: string): void {
  const existing = state.models[modelId];
  const penaltyMultiplier = existing ? Math.pow(1.5, existing.penalty + 1) : 1;
  state.models[modelId] = { until: Date.now() + durationMs * penaltyMultiplier, penalty: existing ? existing.penalty + 1 : 1 };
  if (statePath) {
    saveState(state, statePath);
  }
}

function clearModelCooldown(state: PersistedState, modelId: string, statePath?: string): void {
  delete state.models[modelId];
  if (statePath) {
    saveState(state, statePath);
  }
}

// ── Provider-level Cooldown ──────────────────────────────────────────────────

/** Set a provider-wide cooldown — prevents any model from this provider being used */
function setProviderCooldown(state: PersistedState, providerId: string, durationMs: number, statePath?: string): void {
  const existing = state.providerCooldowns[providerId];
  // Exponential escalation: each consecutive failure multiplies the penalty
  const penaltyMultiplier = existing ? Math.pow(2, existing.consecutiveFailures + 1) : 1;
  const effectiveDuration = durationMs * penaltyMultiplier;
  state.providerCooldowns[providerId] = {
    until: Date.now() + effectiveDuration,
    consecutiveFailures: existing ? existing.consecutiveFailures + 1 : 1,
  };
  log("warn", "Provider Cooldown", `Provider ${providerId} on cooldown for ${Math.round(effectiveDuration / 1000)}s (failure #${state.providerCooldowns[providerId].consecutiveFailures})`);
  if (statePath) {
    saveState(state, statePath);
  }
}

/** Check if a provider is currently on cooldown */
function isProviderOnCooldown(state: PersistedState, providerId: string): boolean {
  const cd = state.providerCooldowns[providerId];
  return cd ? Date.now() < cd.until : false;
}

/** Clear provider cooldown (e.g., after successful request) */
function clearProviderCooldown(state: PersistedState, providerId: string, statePath?: string): void {
  delete state.providerCooldowns[providerId];
  if (statePath) {
    saveState(state, statePath);
  }
}

/** Filter out models from providers that are currently on cooldown */
function filterCooldownProviders(state: PersistedState, models: string[]): string[] {
  const cooledProviders = new Set<string>();
  for (const [providerId, cd] of Object.entries(state.providerCooldowns)) {
    if (Date.now() < cd.until) {
      cooledProviders.add(providerId);
    }
  }
  if (cooledProviders.size === 0) return models;
  const filtered = models.filter((m) => !cooledProviders.has(extractProvider(m)));
  // Fallback to unfiltered chain if all providers are cooled down
  return filtered.length > 0 ? filtered : models;
}

/** Remove expired provider cooldowns from state to prevent unbounded growth */
function cleanStaleCooldowns(state: PersistedState): void {
  const now = Date.now();
  for (const [providerId, cd] of Object.entries(state.providerCooldowns)) {
    if (now >= cd.until) {
      delete state.providerCooldowns[providerId];
    }
  }
}

// ── Key Exhaustion Notification ──────────────────────────────────────────────

interface KeyHealthReport {
  providerId: string;
  totalKeys: number;
  healthyKeys: number;
  exhaustedKeys: number;
  allExhausted: boolean;
  nextKeyAvailableIn: number; // ms until next healthy key (0 if healthy exist)
}

/** Evaluate key health for all configured providers */
function checkKeyHealth(state: PersistedState, merged: AgentFallbackConfig): KeyHealthReport[] {
  const reports: KeyHealthReport[] = [];
  for (const [providerId, keys] of Object.entries(merged.apiKeys)) {
    if (!keys || keys.length === 0) continue;
    const ks = state.keys[providerId];
    let healthyCount = 0;
    let exhaustedCount = 0;
    let minRemaining = Infinity;
    const now = Date.now();

    for (let i = 0; i < keys.length; i++) {
      const until = ks?.until[i] || 0;
      if (now >= until) {
        healthyCount++;
      } else {
        exhaustedCount++;
        const remaining = until - now;
        if (remaining < minRemaining) minRemaining = remaining;
      }
    }

    reports.push({
      providerId,
      totalKeys: keys.length,
      healthyKeys: healthyCount,
      exhaustedKeys: exhaustedCount,
      allExhausted: healthyCount === 0,
      nextKeyAvailableIn: minRemaining === Infinity ? 0 : minRemaining,
    });
  }
  return reports;
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "now";
  if (ms < 1000) return "<1s";
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  const hours = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  return `${hours}h ${mins}m`;
}

/**
 * Check key health and notify the user if additional keys are needed.
 * Shows a toast notification if toastFn is provided (TUI context).
 * Always logs warnings.
 */
function notifyKeyHealth(
  state: PersistedState,
  merged: AgentFallbackConfig,
  alreadyNotified: Set<string>,
  logFn: (level: "info" | "warn" | "error" | "debug", tag: string, message: string) => void,
  toastFn?: (opts: { variant: string; message: string }) => void,
): void {
  const reports = checkKeyHealth(state, merged);
  for (const r of reports) {
    // Skip if no keys configured
    if (r.totalKeys === 0) continue;

    if (r.allExhausted) {
      const key = `exhausted:${r.providerId}`;
      if (alreadyNotified.has(key)) continue;
      alreadyNotified.add(key);

      const msg = `⚠️ All ${r.totalKeys} API key(s) for "${r.providerId}" are exhausted. ` +
        `Next key available in ${formatDuration(r.nextKeyAvailableIn)}. ` +
        `Agent usage may stall — add more API keys to "${r.providerId}" for continuous agent operation.`;
      logFn("error", "Key Exhaustion", msg);
      if (toastFn) toastFn({ variant: "error", message: msg });
    } else if (r.healthyKeys <= 1 && r.totalKeys > 1) {
      const key = `low:${r.providerId}`;
      if (alreadyNotified.has(key)) continue;
      alreadyNotified.add(key);

      const msg = `⚠️ Only ${r.healthyKeys}/${r.totalKeys} API key(s) healthy for "${r.providerId}". ` +
        `Add more API keys to ensure uninterrupted agent operation when rate limits are hit.`;
      logFn("warn", "Key Shortage", msg);
      if (toastFn) toastFn({ variant: "warn", message: msg });
    } else if (r.healthyKeys === 0 && r.totalKeys === 1) {
      const key = `single:${r.providerId}`;
      if (alreadyNotified.has(key)) continue;
      alreadyNotified.add(key);

      const msg = `⚠️ The only API key for "${r.providerId}" is on cooldown. ` +
        `Add a second API key to "${r.providerId}" for failover and continuous agent usage.`;
      logFn("warn", "Single Key Exhausted", msg);
      if (toastFn) toastFn({ variant: "warn", message: msg });
    }
  }
}

function loadState(configPath: string): PersistedState {
  try {
    if (existsSync(configPath)) {
      const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as PersistedState;
      if (parsed.version === STATE_VERSION) return parsed;
    }
  } catch {}
  return { models: {}, keys: {}, providerCooldowns: {}, version: STATE_VERSION };
}

function saveState(state: PersistedState, configPath: string): void {
  try {
    const dir = dirname(configPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(state, null, 2), "utf-8");
  } catch {}
}

function getNextKey(state: PersistedState, providerId: string, keys: string[]): string {
  let ks = state.keys[providerId];
  if (!ks || ks.keys.length === 0) {
    state.keys[providerId] = { currentIndex: 0, keys: [...keys], failures: keys.map(() => 0), until: keys.map(() => 0) };
    ks = state.keys[providerId]!;
  }
  if (ks.keys.length !== keys.length || ks.keys.some((k, i) => k !== keys[i])) {
    ks.keys = [...keys];
    ks.failures = keys.map((_, i) => ks!.failures[i] || 0);
    ks.until = keys.map((_, i) => ks!.until[i] || 0);
    if (ks.currentIndex >= keys.length) ks.currentIndex = 0;
  }
  let attempts = 0;
  const startIndex = ks.currentIndex;
  while (attempts < ks.keys.length) {
    const idx = ks.currentIndex % ks.keys.length;
    ks.currentIndex = (ks.currentIndex + 1) % ks.keys.length;
    if (Date.now() >= (ks.until[idx] || 0)) return ks.keys[idx];
    attempts++;
  }
  // All keys on cooldown — pick the one expiring soonest (oldest) and advance past it
  const now = Date.now();
  let bestIdx = startIndex;
  let bestRemaining = Infinity;
  for (let i = 0; i < ks.keys.length; i++) {
    const idx = (startIndex + i) % ks.keys.length;
    const remaining = (ks.until[idx] || 0) - now;
    if (remaining < bestRemaining) { bestRemaining = remaining; bestIdx = idx; }
  }
  ks.currentIndex = (bestIdx + 1) % ks.keys.length;
  return ks.keys[bestIdx];
}

function markKeyFailed(state: PersistedState, providerId: string, key: string, errorClass: ErrorClass, cooldownSeconds: number, statePath?: string): void {
  const ks = state.keys[providerId];
  if (!ks) return;
  const idx = ks.keys.indexOf(key);
  if (idx === -1) return;
  ks.failures[idx] = (ks.failures[idx] || 0) + 1;
  let penalty: number;
  switch (errorClass) {
    case "auth": penalty = 5 * 60 * 1000; break;
    case "rate_limit": penalty = 60 * 1000; break;
    default: penalty = cooldownSeconds * 1000;
  }
  penalty = penalty * Math.pow(1.5, ks.failures[idx] - 1);
  ks.until[idx] = Date.now() + penalty;
  if (statePath) {
    saveState(state, statePath);
  }
}

function getAgentConfig(cfg: SmartFallbackConfig, agentName: string): AgentFallbackConfig {
  const overrides = cfg.agents[agentName];
  return overrides ? deepMerge(JSON.parse(JSON.stringify(cfg.defaults)), overrides) : JSON.parse(JSON.stringify(cfg.defaults));
}

// ─── TUI Plugin Types (local — not exported from @opencode-ai/plugin) ────────

type TuiPluginApi = {
  ui: {
    dialog: {
      replace(render: () => any): void;
      clear(): void;
    };
    Dialog: (props: Record<string, any>) => any;
    DialogPrompt: (props: Record<string, any>) => any;
    toast(opts: { variant: string; message: string }): void;
  };
  route: {
    register(routes: Array<{ name: string; render: () => any }>): void;
    navigate(route: string): void;
  };
  keymap: {
    registerLayer(layer: any): void;
  };
};

type TuiPlugin = (api: TuiPluginApi, options?: PluginOptions, meta?: any) => void | Promise<void>;

// ─── Plugin ──────────────────────────────────────────────────────────────────

// CLI entry point: `bun run plugins/opencode-smart-fallback.tsx --test`
// Only runs when executed directly (not when imported as a module)
if (typeof process !== "undefined" && Array.isArray(process.argv) && process.argv.includes("--test")) {
  runAllTests()
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch((e) => { console.error("Test runner error:", e); process.exit(1); });
}

const plugin: Plugin = async (input) => {
  const config = loadConfig();
  notificationsEnabled = config.notifications;
  if (config.logLevel) setLogLevel(config.logLevel);
  writeDefaultConfig();
  // Use project directory for shared state across agents in the same project
  const projectStatePath = join(input.directory, ".opencode", "smart-fallback-state.json");
  const statePath = config.statePath || projectStatePath;
  let state = loadState(statePath);
  // Prune expired cooldowns on startup to prevent stale entries accumulating
  cleanStaleCooldowns(state);
  const retryCounters: Record<string, number> = {};
  // Track which key was used for each session
  const sessionKeyMap: Record<string, { providerId: string, key: string }> = {};
  // Track agents flagged for context overflow for large model switching
  const contextOverflowAgents = new Set<string>();
  // Track which key-exhaustion warnings have been sent (to avoid spam)
  const alreadyNotified = new Set<string>();

  // Ensure state directory exists
  try {
    const dir = dirname(statePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch {}

  const hooks: Hooks = {
    // ── config hook: inject fallback chains + check key health ──────────
    async config(cfg: Config) {
      const agents = (cfg as any).agent || {};
      const freePool = config.defaults.providerFreeModels
        ? Object.values(config.defaults.providerFreeModels).flat()
        : DEFAULT_FREE_MODEL_POOL;

      // Check key health at startup — warn if any provider has exhausted or low keys
      if (Object.keys(config.defaults.apiKeys).length > 0) {
        notifyKeyHealth(state, config.defaults, alreadyNotified, log);
      }
      for (const agentName of Object.keys(config.agents)) {
        const merged = getAgentConfig(config, agentName);
        if (Object.keys(merged.apiKeys).length > 0) {
          notifyKeyHealth(state, merged, alreadyNotified, log);
        }
      }

      for (const [agentName, agentCfg] of Object.entries(agents)) {
        if (!agentCfg) continue;
        const merged = getAgentConfig(config, agentName);
        const ac = agentCfg as Record<string, any>;
        if (!ac.options) ac.options = {};

        // Use free model pool as primary fallback if no custom chain
        let fallbackChain = merged.fallbackModels.length > 0 ? merged.fallbackModels : freePool;
        // Remove models from providers currently on cooldown
        fallbackChain = filterCooldownProviders(state, fallbackChain);
        // If all models filtered out, fall back to unfiltered chain
        if (fallbackChain.length === 0) {
          fallbackChain = merged.fallbackModels.length > 0 ? merged.fallbackModels : freePool;
        }
        // Interleave providers so consecutive models aren't from the same provider
        fallbackChain = interleaveProviders(fallbackChain);
        ac.options.fallbackModels = fallbackChain;

        if (merged.largeContextModel) ac.options.largeContextModel = merged.largeContextModel;
        if (merged.maxRetries > 0) ac.options.chatMaxRetries = merged.maxRetries;
      }
    },

    // ── event hook: handle errors, cooldowns, key rotation ─────────────
    async event(evt) {
      const event = evt.event as any;
      const props = event.properties || {};

      if (event.type === "session.error") {
        const error = props.error;
        if (!error || typeof error !== "object") return;
        const errorClass = classifyError(error);
        const agentName = props.agent || "unknown";
        const modelId = props.model?.id || props.modelId || "unknown";
        const merged = getAgentConfig(config, agentName);

        const duration = getCooldownDuration(errorClass, error, merged.cooldownSeconds);
        setModelCooldown(state, modelId, duration, statePath);

        if (errorClass === "auth") {
          const providerId = (error as any).data?.providerID || "unknown";
          log("warn", "Auth Failure", `Model ${modelId} auth failed. Provider: ${providerId}. Rotating keys.`);
          // Mark the key as failed for auth errors
          const keys = merged.apiKeys[providerId];
          if (keys && keys.length > 0) {
            // Use the key that was actually used for this session
            const sessionKeyInfo = sessionKeyMap[props.sessionID];
            const keyToMark = sessionKeyInfo?.providerId === providerId ? sessionKeyInfo.key : keys[0];
            markKeyFailed(state, providerId, keyToMark, errorClass, merged.cooldownSeconds, statePath);
            // Check if all keys for this provider are now exhausted
            notifyKeyHealth(state, merged, alreadyNotified, log);
          }
        } else if (errorClass === "rate_limit") {
          log("warn", "Rate Limited", `Model ${modelId} rate limited.`);
          const providerId = error.data?.providerID || "unknown";
          const keys = merged.apiKeys[providerId];
          if (keys && keys.length > 0) {
            const sessionKeyInfo = sessionKeyMap[props.sessionID];
            const keyToMark = sessionKeyInfo?.providerId === providerId ? sessionKeyInfo.key : keys[0];
            markKeyFailed(state, providerId, keyToMark, errorClass, merged.cooldownSeconds, statePath);
            // Check if all keys for this provider are now exhausted
            notifyKeyHealth(state, merged, alreadyNotified, log);
          }
        } else if (errorClass === "context") {
          log("warn", "Context Overflow", `Model ${modelId} context overflow. Will use large context model for ${agentName}.`);
          contextOverflowAgents.add(agentName);
        }

        // ── Provider-level cooldown learning ──
        // When models from the same provider fail repeatedly, cool the whole provider
        const providerId =
          (error as any).data?.providerID ||
          (error as any).data?.providerId ||
          extractProvider(modelId);
        if (errorClass === "auth" || errorClass === "rate_limit" || errorClass === "retryable") {
          const providerDuration = getCooldownDuration(errorClass, error, merged.cooldownSeconds);
          setProviderCooldown(state, providerId, providerDuration, statePath);
        }
      }

      // ── On session status: handle success/retry/idle + provider cooldown ──
      if (event.type === "session.status") {
        const status = props.status;
        if (status?.type === "success") {
          const modelId = props.model?.id || props.modelId;
          if (modelId) {
            const successProvider = extractProvider(modelId);
            if (state.providerCooldowns[successProvider]) {
              clearProviderCooldown(state, successProvider, statePath);
              log("info", "Provider Cooldown Cleared", `Provider ${successProvider} succeeded, cooldown cleared.`);
            }
          }
        } else if (status?.type === "retry") {
          const { attempt, message: errorMsg } = status;
          const agentName = props.agent || "unknown";
          const modelId = props.model?.id || props.modelId || "unknown";

          const retryKey = `${agentName}:${modelId}`;
          retryCounters[retryKey] = (retryCounters[retryKey] || 0) + 1;
        } else if (status?.type === "idle") {
          // Clean up session-scoped tracking when session goes idle
          const sessionID = props.sessionID as string | undefined;
          if (sessionID) {
            delete sessionKeyMap[sessionID];
          }
        }
      }

      // Limit retryCounters size to prevent unbounded growth
      if (Object.keys(retryCounters).length > 1000) {
        const entries = Object.entries(retryCounters);
        // Keep only the 500 most recent entries (sorted alphabetically = insertion order proxy)
        const toDelete = entries.slice(0, entries.length - 500);
        for (const [k] of toDelete) delete retryCounters[k];
      }
    },

    // ── chat.params: tune on retry ──────────────────────────────────────
    async "chat.params"(input, output) {
      const { agent: agentName, model } = input;
      const retryKey = `${agentName}:${model.id}`;
      const retryCount = retryCounters[retryKey] || 0;
      const merged = getAgentConfig(config, agentName);

      if (retryCount > 0) {
        output.temperature = Math.max(0.1, (output.temperature ?? 0.7) - retryCount * 0.1);
        // Clear model cooldown since the system is retrying this model
        clearModelCooldown(state, model.id, statePath);
        // Also clear provider cooldown on retry (the system decided to retry)
        const providerId = extractProvider(model.id);
        if (state.providerCooldowns[providerId]) {
          clearProviderCooldown(state, providerId, statePath);
        }
      }
      if (contextOverflowAgents.has(agentName) && merged.largeContextModel) {
        output.maxOutputTokens = Math.max(output.maxOutputTokens ?? 0, 16384);
      } else if (merged.largeContextModel && model.id === merged.largeContextModel) {
        output.maxOutputTokens = Math.max(output.maxOutputTokens ?? 0, 16384);
      }
    },

    // ── chat.headers: rotate API keys ───────────────────────────────────
    async "chat.headers"(input, output) {
      const { agent: agentName, provider, sessionID } = input;
      const merged = getAgentConfig(config, agentName);
      const providerId = provider.info.id;
      const keys = merged.apiKeys[providerId];
      if (keys && keys.length > 0) {
        const nextKey = getNextKey(state, providerId, keys);
        output.headers = { ...output.headers, Authorization: `Bearer ${nextKey}` };
        sessionKeyMap[sessionID] = { providerId, key: nextKey };
      }
    },

    async "experimental.session.compacting"(_input, output) {
      output.context = [...(output.context || []), "Preserve architectural decisions during compaction."];
    },

    async "experimental.compaction.autocontinue"(_input, output) {
      output.enabled = true;
    },

    async dispose() {
      cleanStaleCooldowns(state);
      saveState(state, statePath);
    },
  };

  return hooks;
};

// Test function to verify state persistence
async function testStatePersistence() {
  const testStatePath = join(homedir(), ".config", "opencode", "smart-fallback-test-state.json");
  const testState: PersistedState = {
    models: {
      "test-model": { until: Date.now() + 10000, penalty: 1 }
    },
    keys: {
      "test-provider": {
        currentIndex: 0,
        keys: ["test-key-1", "test-key-2"],
        failures: [1, 0],
        until: [Date.now() + 10000, 0]
      }
    },
    providerCooldowns: {},
    version: STATE_VERSION
  };
  
  // Save test state
  saveState(testState, testStatePath);
  console.log("Test state saved to", testStatePath);
  
  // Load test state
  const loadedState = loadState(testStatePath);
  console.log("Test state loaded:", JSON.stringify(loadedState, null, 2));
  
  // Verify state
  if (loadedState.models["test-model"] && 
      loadedState.keys["test-provider"] &&
      loadedState.version === STATE_VERSION) {
    console.log("✓ State persistence test PASSED");
    return true;
  } else {
    console.log("✗ State persistence test FAILED");
    return false;
  }
}

// Integration test to verify fallback workflow with orchestrator agents
async function testOrchestratorIntegration() {
  console.log("\n=== Testing Orchestrator Integration ===");
  
  // Test with different agent types
  const agentTypes = ["Commander", "Planner", "Worker", "Reviewer"];
  
  for (const agentName of agentTypes) {
    console.log(`\nTesting agent: ${agentName}`);
    
    // Test getAgentConfig
    const agentConfig = getAgentConfig(DEFAULT_CONFIG, agentName);
    console.log(`  Fallback models: ${agentConfig.fallbackModels.length > 0 ? agentConfig.fallbackModels.join(", ") : "default pool"}`);
    console.log(`  Max retries: ${agentConfig.maxRetries}`);
    
    // Test error classification
    const authError = { name: "ProviderAuthError", data: { providerID: "test-provider" } };
    const rateLimitError = { name: "APIError", data: { statusCode: 429, providerID: "test-provider" } };
    const contextError = { name: "MessageOutputLengthError" };
    
    console.log(`  Auth error classification: ${classifyError(authError)}`);
    console.log(`  Rate limit error classification: ${classifyError(rateLimitError)}`);
    console.log(`  Context error classification: ${classifyError(contextError)}`);
  }
  
  console.log("\n✓ Orchestrator integration test completed");
  return true;
}

// Regression test to verify no regressions in existing functionality
async function testRegression() {
  console.log("\n=== Running Regression Tests ===");
  
  // Test 1: Key rotation logic
  console.log("\n1. Testing key rotation logic...");
  const testState: PersistedState = {
    models: {},
    keys: {
      "test-provider": {
        currentIndex: 0,
        keys: ["key-1", "key-2", "key-3"],
        failures: [0, 0, 0],
        until: [0, 0, 0]
      }
    },
    providerCooldowns: {},
    version: STATE_VERSION
  };
  
  // Test round-robin rotation
  const key1 = getNextKey(testState, "test-provider", ["key-1", "key-2", "key-3"]);
  const key2 = getNextKey(testState, "test-provider", ["key-1", "key-2", "key-3"]);
  const key3 = getNextKey(testState, "test-provider", ["key-1", "key-2", "key-3"]);
  const key4 = getNextKey(testState, "test-provider", ["key-1", "key-2", "key-3"]);
  
  if (key1 === "key-1" && key2 === "key-2" && key3 === "key-3" && key4 === "key-1") {
    console.log("  ✓ Key rotation: PASSED");
  } else {
    console.log("  ✗ Key rotation: FAILED");
    return false;
  }
  
  // Test 2: Error classification
  console.log("\n2. Testing error classification...");
  const authError = { name: "ProviderAuthError", data: { providerID: "test-provider" } };
  const rateLimitError = { name: "APIError", data: { statusCode: 429, providerID: "test-provider" } };
  const contextError = { name: "MessageOutputLengthError" };
  const retryableError = { name: "APIError", data: { statusCode: 500 } };
  const nonRetryableError = { name: "MessageAbortedError" };
  
  if (classifyError(authError) === "auth" &&
      classifyError(rateLimitError) === "rate_limit" &&
      classifyError(contextError) === "context" &&
      classifyError(retryableError) === "retryable" &&
      classifyError(nonRetryableError) === "non_retryable") {
    console.log("  ✓ Error classification: PASSED");
  } else {
    console.log("  ✗ Error classification: FAILED");
    return false;
  }
  
  // Test 3: Model cooldown
  console.log("\n3. Testing model cooldown...");
  const cooldownState: PersistedState = { models: {}, keys: {}, providerCooldowns: {}, version: STATE_VERSION };
  setModelCooldown(cooldownState, "test-model", 1000);
  
  if (isModelOnCooldown(cooldownState, "test-model") &&
      !isModelOnCooldown(cooldownState, "other-model")) {
    console.log("  ✓ Model cooldown: PASSED");
  } else {
    console.log("  ✗ Model cooldown: FAILED");
    return false;
  }
  
  // Test 4: Agent configuration
  console.log("\n4. Testing agent configuration...");
  const customConfig: SmartFallbackConfig = {
    ...DEFAULT_CONFIG,
    agents: {
      "TestAgent": {
        fallbackModels: ["model-1", "model-2"],
        apiKeys: { "test-provider": ["key-1", "key-2"] },
        cooldownSeconds: 60
      }
    }
  };
  
  const testAgentConfig = getAgentConfig(customConfig, "TestAgent");
  if (testAgentConfig.fallbackModels.length === 2 &&
      testAgentConfig.apiKeys["test-provider"]?.length === 2 &&
      testAgentConfig.cooldownSeconds === 60) {
    console.log("  ✓ Agent configuration: PASSED");
  } else {
    console.log("  ✗ Agent configuration: FAILED");
    return false;
  }
  
  // Test 5: State persistence
  console.log("\n5. Testing state persistence...");
  const testStatePath = join(homedir(), ".config", "opencode", "smart-fallback-regression-test.json");
  const testState2: PersistedState = {
    models: { "test-model": { until: Date.now() + 10000, penalty: 1 } },
    keys: { "test-provider": { currentIndex: 1, keys: ["key-1"], failures: [0], until: [0] } },
    providerCooldowns: {},
    version: STATE_VERSION
  };
  
  saveState(testState2, testStatePath);
  const loadedState = loadState(testStatePath);
  
  if (loadedState.models["test-model"] && 
      loadedState.keys["test-provider"] &&
      loadedState.version === STATE_VERSION) {
    console.log("  ✓ State persistence: PASSED");
  } else {
    console.log("  ✗ State persistence: FAILED");
    return false;
  }
  
  console.log("\n✓ All regression tests PASSED");
  return true;
}

// ─── New Feature Unit Tests ───────────────────────────────────────────────────

/** Test provider cooldown (set, check, clear) */
function testProviderCooldown(): boolean {
  console.log("\n6. Testing provider cooldown...");
  const state: PersistedState = { models: {}, keys: {}, providerCooldowns: {}, version: STATE_VERSION };

  // Initially no cooldown
  if (isProviderOnCooldown(state, "openrouter")) {
    console.log("  ✗ Provider initially should not be on cooldown");
    return false;
  }

  // Set cooldown for 1 hour
  setProviderCooldown(state, "openrouter", 3600000);

  if (!isProviderOnCooldown(state, "openrouter")) {
    console.log("  ✗ Provider should be on cooldown after setProviderCooldown");
    return false;
  }

  // Non-cooldowned provider should still be unaffected
  if (isProviderOnCooldown(state, "opencode")) {
    console.log("  ✗ Unrelated provider should not be on cooldown");
    return false;
  }

  // Clear cooldown
  clearProviderCooldown(state, "openrouter");
  if (isProviderOnCooldown(state, "openrouter")) {
    console.log("  ✗ Provider should not be on cooldown after clear");
    return false;
  }

  // Test exponential escalation
  setProviderCooldown(state, "test-provider", 1000);
  const firstDuration = state.providerCooldowns["test-provider"].until - Date.now();
  if (firstDuration < 800) {
    console.log(`  ✗ First cooldown duration should be ~1000ms, got ${firstDuration}ms`);
    return false;
  }
  setProviderCooldown(state, "test-provider", 1000);
  const secondDuration = state.providerCooldowns["test-provider"].until - Date.now();
  if (secondDuration < firstDuration * 1.5) {
    console.log(`  ✗ Second cooldown should escalate (>${firstDuration}ms, got ${secondDuration}ms)`);
    return false;
  }
  // Consecutive failures
  if (state.providerCooldowns["test-provider"].consecutiveFailures !== 2) {
    console.log(`  ✗ Expected 2 consecutive failures, got ${state.providerCooldowns["test-provider"].consecutiveFailures}`);
    return false;
  }

  console.log("  ✓ Provider cooldown: PASSED");
  return true;
}

/** Test filterCooldownProviders */
function testFilterCooldownProviders(): boolean {
  console.log("\n7. Testing filterCooldownProviders...");
  const state: PersistedState = { models: {}, keys: {}, providerCooldowns: {}, version: STATE_VERSION };

  const models = ["openrouter/a", "opencode/b", "openrouter/c", "mistral/d"];

  // No cooldowns → all models pass through
  const allPass = filterCooldownProviders(state, models);
  if (allPass.length !== 4) {
    console.log("  ✗ All models should pass when no cooldowns");
    return false;
  }

  // Cool down openrouter provider
  state.providerCooldowns["openrouter"] = { until: Date.now() + 60000, consecutiveFailures: 1 };
  const filtered = filterCooldownProviders(state, models);
  if (filtered.length !== 2 || filtered.includes("openrouter/a") || filtered.includes("openrouter/c")) {
    console.log("  ✗ OpenRouter models should be filtered out, got:", filtered);
    return false;
  }
  if (filtered[0] !== "opencode/b" || filtered[1] !== "mistral/d") {
    console.log("  ✗ Remaining models should preserve order: opencode/b, mistral/d, got:", filtered);
    return false;
  }

  // All providers on cooldown → fallback to unfiltered
  state.providerCooldowns["opencode"] = { until: Date.now() + 60000, consecutiveFailures: 1 };
  state.providerCooldowns["mistral"] = { until: Date.now() + 60000, consecutiveFailures: 1 };
  const allCooled = filterCooldownProviders(state, models);
  if (!allCooled.includes("openrouter/a")) {
    console.log("  ✗ Should fallback to original list when all providers cooled, got:", allCooled);
    return false;
  }

  // Expired cooldown → models pass through naturally
  state.providerCooldowns = {};  // clean slate
  state.providerCooldowns["openrouter"] = { until: Date.now() - 1000, consecutiveFailures: 1 };
  const expiredPass = filterCooldownProviders(state, models);
  if (expiredPass.length !== 4) {
    console.log("  ✗ Expired cooldowns should not filter");
    return false;
  }

  console.log("  ✓ filterCooldownProviders: PASSED");
  return true;
}

/** Test interleaveProviders */
function testInterleaveProviders(): boolean {
  console.log("\n8. Testing interleaveProviders...");

  // Single element
  const single = interleaveProviders(["opencode/a"]);
  if (single.length !== 1 || single[0] !== "opencode/a") {
    console.log("  ✗ Single element interleave failed");
    return false;
  }

  // Empty
  const empty = interleaveProviders([]);
  if (empty.length !== 0) {
    console.log("  ✗ Empty interleave should return empty");
    return false;
  }

  // Single provider group (no interleaving needed)
  const sameProvider = interleaveProviders(["opencode/a", "opencode/b", "opencode/c"]);
  if (sameProvider.length !== 3) {
    console.log("  ✗ Same provider interleave should preserve order");
    return false;
  }

  // Two providers round-robin
  const twoProviders = ["opencode/a", "opencode/b", "openrouter/c", "openrouter/d"];
  const interl = interleaveProviders(twoProviders);
  // Expected: opencode/a, openrouter/c, opencode/b, openrouter/d
  if (interl.length !== 4) {
    console.log("  ✗ Length should be 4, got", interl.length);
    return false;
  }
  if (interl[0] !== "opencode/a" || interl[1] !== "openrouter/c" || interl[2] !== "opencode/b" || interl[3] !== "openrouter/d") {
    console.log("  ✗ Interleave pattern wrong, expected [opencode/a, openrouter/c, opencode/b, openrouter/d], got", interl);
    return false;
  }

  // Three providers round-robin with uneven groups
  const threeProviders = ["openrouter/x", "openrouter/y", "opencode/a", "mistral/1", "opencode/b"];
  const interl3 = interleaveProviders(threeProviders);
  // Expected: openrouter/x, opencode/a, mistral/1, openrouter/y, opencode/b
  if (interl3.length !== 5) {
    console.log("  ✗ 3-provider interleave length should be 5, got", interl3.length);
    return false;
  }
  if (interl3[0] !== "openrouter/x" || interl3[1] !== "opencode/a" || interl3[2] !== "mistral/1" || interl3[3] !== "openrouter/y" || interl3[4] !== "opencode/b") {
    console.log("  ✗ 3-provider interleave pattern wrong, got", interl3);
    return false;
  }

  console.log("  ✓ interleaveProviders: PASSED");
  return true;
}

/** Test sortModels with all strategies */
function testSortModels(): boolean {
  console.log("\n9. Testing sortModels...");
  const models: ModelInfo[] = [
    { id: "opencode/z", provider: "opencode", isFree: false, name: "Z Paid" },
    { id: "opencode/a-free", provider: "opencode", isFree: true, name: "A Free" },
    { id: "openrouter/b-paid", provider: "openrouter", isFree: false, name: "B Paid" },
    { id: "openrouter/c-free", provider: "openrouter", isFree: true, name: "C Free" },
  ];

  // Alpha sort  
  const alpha = sortModels(models, "alpha");
  const alphaIds = alpha.map(m => m.id);
  if (alphaIds[0] !== "opencode/a-free" || alphaIds[alphaIds.length - 2] !== "openrouter/b-paid" || alphaIds[alphaIds.length - 1] !== "openrouter/c-free") {
    console.log("  ✗ Alpha sort failed, got:", alphaIds);
    return false;
  }

  // Free-first sort
  const freeFirst = sortModels(models, "free-first");
  if (freeFirst[0].isFree !== true || freeFirst[1].isFree !== true || freeFirst[2].isFree !== false) {
    console.log("  ✗ Free-first sort failed, got:", freeFirst.map(m => `${m.id}(${m.isFree})`));
    return false;
  }

  // Provider sort
  const byProvider = sortModels(models, "provider");
  // opencode models first (alphabetically), then openrouter
  if (byProvider[0].provider !== "opencode" || byProvider[byProvider.length - 1].provider !== "openrouter") {
    console.log("  ✗ Provider sort failed, got:", byProvider.map(m => `${m.id}(${m.provider})`));
    return false;
  }

  // Context sort (largest first)
  const ctxModels: ModelInfo[] = [
    { id: "a", provider: "opencode", isFree: true, name: "A", contextWindow: 8000 },
    { id: "b", provider: "opencode", isFree: true, name: "B" },
    { id: "c", provider: "opencode", isFree: true, name: "C", contextWindow: 128000 },
  ];
  const byContext = sortModels(ctxModels, "context");
  if (byContext[0].id !== "c" || byContext[1].id !== "a" || byContext[2].id !== "b") {
    console.log("  ✗ Context sort failed, got:", byContext.map(m => `${m.id}(${m.contextWindow ?? 0})`));
    return false;
  }

  console.log("  ✓ sortModels: PASSED");
  return true;
}

/** Test filterModelsByProvider and extractProvider */
function testFilterAndExtract(): boolean {
  console.log("\n10. Testing filterModelsByProvider and extractProvider...");
  const models: ModelInfo[] = [
    { id: "opencode/a", provider: "opencode", isFree: true, name: "A" },
    { id: "openrouter/b", provider: "openrouter", isFree: true, name: "B" },
  ];

  // No filter returns all
  if (filterModelsByProvider(models, null).length !== 2) {
    console.log("  ✗ Null filter should return all");
    return false;
  }

  // Filter by provider
  const filtered = filterModelsByProvider(models, "opencode");
  if (filtered.length !== 1 || filtered[0].id !== "opencode/a") {
    console.log("  ✗ Provider filter failed");
    return false;
  }

  // extractProvider
  if (extractProvider("openrouter/nvidia/nemotron:free") !== "openrouter") {
    console.log("  ✗ extractProvider failed for multi-part ID");
    return false;
  }
  if (extractProvider("opencode/deepseek") !== "opencode") {
    console.log("  ✗ extractProvider failed for simple ID");
    return false;
  }
  if (extractProvider("unknown") !== "unknown") {
    console.log("  ✗ extractProvider should return 'unknown' for no-prefix ID");
    return false;
  }

  console.log("  ✓ filterModelsByProvider and extractProvider: PASSED");
  return true;
}

/** Test checkKeyHealth and notifyKeyHealth */
function testKeyHealth(): boolean {
  console.log("\n11. Testing key health monitoring...");
  const state: PersistedState = {
    models: {},
    keys: {
      "provider-a": { currentIndex: 0, keys: ["key-1", "key-2"], failures: [0, 0], until: [0, 0] },
      "provider-b": { currentIndex: 0, keys: ["key-1", "key-2", "key-3"], failures: [3, 2, 0], until: [Date.now() + 60000, Date.now() + 30000, 0] },
    },
    providerCooldowns: {},
    version: STATE_VERSION,
  };
  const config: AgentFallbackConfig = {
    apiKeys: {
      "provider-a": ["key-1", "key-2"],
      "provider-b": ["key-1", "key-2", "key-3"],
    },
    fallbackModels: [],
    maxRetries: 3,
    cooldownSeconds: 30,
    contextThreshold: 0.85,
    backoff: { initialDelayMs: 1000, maxDelayMs: 60000, multiplier: 2 },
    providerFreeModels: {},
  };

  // Test checkKeyHealth
  const reports = checkKeyHealth(state, config);
  if (reports.length !== 2) {
    console.log("  ✗ Expected 2 reports, got", reports.length);
    return false;
  }

  // Provider A: all healthy
  const reportA = reports.find(r => r.providerId === "provider-a")!;
  if (reportA.healthyKeys !== 2 || reportA.exhaustedKeys !== 0 || reportA.allExhausted) {
    console.log("  ✗ Provider A should have all healthy keys, got:", reportA);
    return false;
  }

  // Provider B: 1 healthy, 2 exhausted
  const reportB = reports.find(r => r.providerId === "provider-b")!;
  if (reportB.healthyKeys !== 1 || reportB.exhaustedKeys !== 2 || reportB.allExhausted) {
    console.log("  ✗ Provider B should have 1/3 healthy keys, got:", reportB);
    return false;
  }

  // Test notifyKeyHealth with alreadyNotified set
  const alreadyNotified = new Set<string>();
  const logged: string[] = [];
  const logFn = (_level: string, _tag: string, msg: string) => { logged.push(msg); };
  notifyKeyHealth(state, config, alreadyNotified, logFn as any);

  // Should get notifications for provider-b (1/3 healthy) 
  const lowKeyMsg = logged.find(m => m.includes("provider-b") && m.includes("Only 1/3"));
  if (!lowKeyMsg) {
    console.log("  ✗ Should notify low key health for provider-b, got:", logged);
    return false;
  }

  // Second call should be silenced (alreadyNotified)
  const logged2: string[] = [];
  notifyKeyHealth(state, config, alreadyNotified, ((_l: string, _t: string, m: string) => { logged2.push(m); }) as any);
  if (logged2.length > 0) {
    console.log("  ✗ AlreadyNotified should suppress duplicate notifications, got:", logged2);
    return false;
  }

  console.log("  ✓ Key health monitoring: PASSED");
  return true;
}

/** Test getModelProviders */
function testGetModelProviders(): boolean {
  console.log("\n12. Testing getModelProviders...");
  const models: ModelInfo[] = [
    { id: "a", provider: "opencode", isFree: true, name: "A" },
    { id: "b", provider: "openrouter", isFree: true, name: "B" },
    { id: "c", provider: "opencode", isFree: false, name: "C" },
  ];

  const providers = getModelProviders(models);
  if (providers.length !== 2 || providers[0] !== "opencode" || providers[1] !== "openrouter") {
    console.log("  ✗ Expected [opencode, openrouter], got:", providers);
    return false;
  }

  console.log("  ✓ getModelProviders: PASSED");
  return true;
}

/** Test formatDuration */
function testFormatDuration(): boolean {
  console.log("\n13. Testing formatDuration...");
  if (formatDuration(0) !== "now") { console.log("  ✗ Expected 'now'"); return false; }
  if (formatDuration(-1) !== "now") { console.log("  ✗ Negative should be 'now'"); return false; }
  if (formatDuration(500) !== "<1s") { console.log("  ✗ Expected '<1s'"); return false; }
  if (formatDuration(5000) !== "5s") { console.log("  ✗ Expected '5s'"); return false; }
  if (formatDuration(65000) !== "1m 5s") { console.log("  ✗ Expected '1m 5s'"); return false; }
  if (formatDuration(7200000) !== "2h 0m") { console.log("  ✗ Expected '2h 0m'"); return false; }
  console.log("  ✓ formatDuration: PASSED");
  return true;
}

/** Test parseRetryAfter with various input formats */
function testParseRetryAfter(): boolean {
  console.log("\n14. Testing parseRetryAfter...");

  // Null/undefined
  if (parseRetryAfter(undefined) !== null) { console.log("  ✗ Undefined should return null"); return false; }
  if (parseRetryAfter("") !== null) { console.log("  ✗ Empty should return null"); return false; }

  // Numeric seconds
  const r1 = parseRetryAfter("120");
  if (r1 === null || r1 < 119000 || r1 > 121000) { console.log(`  ✗ '120' should be ~120000ms, got ${r1}`); return false; }

  // Decimal seconds
  const r2 = parseRetryAfter("30.5");
  if (r2 === null || r2 < 30000 || r2 > 31000) { console.log(`  ✗ '30.5' should be ~30500ms, got ${r2}`); return false; }

  // Leading zeros
  const r3 = parseRetryAfter("005");
  if (r3 === null || r3 < 4000 || r3 > 6000) { console.log(`  ✗ '005' should be ~5000ms, got ${r3}`); return false; }

  // Whitespace
  const r4 = parseRetryAfter("  60  ");
  if (r4 === null || r4 < 59000 || r4 > 61000) { console.log(`  ✗ '  60  ' should be ~60000ms, got ${r4}`); return false; }

  // Human-readable: seconds
  const r5 = parseRetryAfter("45 seconds");
  if (r5 === null || r5 < 44000 || r5 > 46000) { console.log(`  ✗ '45 seconds' should be ~45000ms, got ${r5}`); return false; }

  // Human-readable: minutes
  const r6 = parseRetryAfter("2 minutes");
  if (r6 === null || r6 < 119000 || r6 > 121000) { console.log(`  ✗ '2 minutes' should be ~120000ms, got ${r6}`); return false; }

  // Human-readable: short forms
  const r7 = parseRetryAfter("30 sec");
  if (r7 === null || r7 < 29000 || r7 > 31000) { console.log(`  ✗ '30 sec' should be ~30000ms, got ${r7}`); return false; }
  const r8 = parseRetryAfter("1 min");
  if (r8 === null || r8 < 59000 || r8 > 61000) { console.log(`  ✗ '1 min' should be ~60000ms, got ${r8}`); return false; }

  // Capped at 1 hour
  const r9 = parseRetryAfter("999999");
  if (r9 === null || r9 > 3601000) { console.log(`  ✗ '999999' should be capped at 3600000ms, got ${r9}`); return false; }

  // Zero = retry immediately (valid per HTTP spec)
  if (parseRetryAfter("0") !== 0) { console.log("  ✗ '0' should be 0ms (retry immediately)"); return false; }

  console.log("  ✓ parseRetryAfter: PASSED");
  return true;
}

/** Run all new feature tests */
async function testNewFeatures(): Promise<boolean> {
  console.log("\n=== Running New Feature Tests ===");
  const results = [
    testProviderCooldown(),
    testFilterCooldownProviders(),
    testInterleaveProviders(),
    testSortModels(),
    testFilterAndExtract(),
    testKeyHealth(),
    testGetModelProviders(),
    testFormatDuration(),
    testParseRetryAfter(),
  ];
  const allOk = results.every(r => r);
  if (allOk) {
    console.log("\n✓ All new feature tests PASSED");
  } else {
    console.log("\n✗ Some new feature tests FAILED");
  }
  return allOk;
}

// Run all tests
async function runAllTests() {
  try {
    const stateTest = await testStatePersistence();
    const orchestratorTest = await testOrchestratorIntegration();
    const regressionTest = await testRegression();
    const newFeaturesTest = await testNewFeatures();
    
    if (stateTest && orchestratorTest && regressionTest && newFeaturesTest) {
      console.log("\n🎉 ALL TESTS PASSED! Fallback plugin is working correctly.");
      return true;
    } else {
      console.log("\n❌ SOME TESTS FAILED!");
      return false;
    }
  } catch (error) {
    console.error("Test error:", error);
    return false;
  }
}

// Uncomment to run all tests
// runAllTests().catch(console.error);

// ─── TUI Plugin ────────────────────────────────────────────────────────────────

/** Module-level notification tracker for TUI key health checks (separate from plugin closure) */
const _tuiNotified = new Set<string>();

interface FallbackTuiConfig {
  apiKeys: Record<string, string[]>;
  fallbackModels: string[];
  largeContextModel?: string;
  cooldownSeconds: number;
  maxRetries: number;
}

// ─── Interactive Model Selector ───────────────────────────────────────────────

function ModelSelectorDialog(
  api: TuiPluginApi,
  currentModels: string[],
  onSave: (selectedModels: string[]) => void
): void {
  // ── Reactive state ──
  const [availableModels, setAvailableModels] = createSignal<ModelInfo[]>([]);
  const [selectedIds, setSelectedIds] = createSignal<Set<string>>(new Set(currentModels));
  const [sortMode, setSortMode] = createSignal<"free-first" | "alpha" | "provider" | "context">("free-first");
  const [providerFilter, setProviderFilter] = createSignal<string | null>(null);
  const [isRefreshing, setIsRefreshing] = createSignal(false);
  const [statusMsg, setStatusMsg] = createSignal("");

  // Bootstrap: load models
  (async () => {
    const models = await fetchAvailableModels();
    setAvailableModels(models);
  })();

  function toggleModel(id: string) {
    const next = new Set(selectedIds());
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelectedIds(next);
  }

  function selectAll() {
    const filtered = getFilteredSorted();
    setSelectedIds(new Set(filtered.map((m) => m.id)));
  }

  function deselectAll() {
    setSelectedIds(new Set<string>());
  }

  async function refreshModels() {
    setIsRefreshing(true);
    setStatusMsg("Fetching latest models…");
    try {
      _modelCache = null; // bust cache
      const models = await fetchAvailableModels();
      setAvailableModels(models);
      setStatusMsg(`Refreshed — ${models.length} models available`);
    } catch {
      setStatusMsg("Refresh failed, using cached list");
    } finally {
      setIsRefreshing(false);
    }
  }

  function getFilteredSorted(): ModelInfo[] {
    let list = filterModelsByProvider(availableModels(), providerFilter());
    list = sortModels(list, sortMode());
    return list;
  }

  function openConfirmation() {
    const count = selectedIds().size;
    if (count === 0) {
      api.ui.toast({ variant: "error", message: "Please select at least one model." });
      return;
    }
    api.ui.dialog.replace(() => renderConfirmation());
  }

  function confirmAndSave() {
    onSave([...selectedIds()]);
    api.ui.dialog.clear();
    api.ui.toast({ variant: "success", message: `Saved ${selectedIds().size} fallback model(s)` });
  }

  const providers = () => getModelProviders(availableModels());

  // ── Render helper: single model row ──
  function ModelRow(m: ModelInfo) {
    const isSelected = selectedIds().has(m.id);
    const checkbox = isSelected ? "[✓]" : "[ ]";
    const color = isSelected ? "accent" : "muted";
    const freeTag = m.isFree ? " FREE" : "";
    return (
      <box flexDirection="row" gap={1}>
        <text
          {...({ color, onClick: () => toggleModel(m.id) } as any)}
        >{checkbox} {m.name}{freeTag}</text>
        <text {...({ color: "muted" } as any)}>({m.id})</text>
      </box>
    );
  }

  // ── Render: selector view ──
  function renderSelector() {
    const filtered = getFilteredSorted();
    const selectedCount = selectedIds().size;
    const totalCount = availableModels().length;

    return (
      <api.ui.Dialog size="large" onClose={() => api.ui.dialog.clear()}>
        <box flexDirection="column" padding={1} gap={1} height="100%">
          {/* Header */}
          <text {...({ bold: true, color: "accent" } as any)}>
            Model Selector — {selectedCount}/{totalCount} selected
          </text>

          {/* Status message */}
          {statusMsg() && (
            <text {...({ color: "info" } as any)}>{statusMsg()}</text>
          )}

          {/* Sort controls */}
          <box flexDirection="row" gap={1}>
            <text {...({ bold: true } as any)}>Sort:</text>
            {(["free-first", "alpha", "provider", "context"] as const).map((mode) => (
              <text
                {...({
                  color: sortMode() === mode ? "accent" : "muted",
                  onClick: () => setSortMode(mode),
                } as any)}
              >
                {mode === "free-first" ? "[Free First]" : mode === "alpha" ? "[A-Z]" : mode === "provider" ? "[By Provider]" : "[Context]"}
              </text>
            ))}
          </box>

          {/* Provider filter */}
          <box flexDirection="row" gap={1}>
            <text {...({ bold: true } as any)}>Provider:</text>
            <text
              {...({
                color: providerFilter() === null ? "accent" : "muted",
                onClick: () => setProviderFilter(null),
              } as any)}
            >[All]</text>
            {providers().map((p) => (
              <text
                {...({
                  color: providerFilter() === p ? "accent" : "muted",
                  onClick: () => setProviderFilter(p),
                } as any)}
              >[{p}]</text>
            ))}
          </box>

          {/* Bulk actions */}
          <box flexDirection="row" gap={1}>
            <text {...({ color: "accent", onClick: selectAll } as any)}>[Select All]</text>
            <text {...({ color: "error", onClick: deselectAll } as any)}>[Deselect All]</text>
            <text {...({ color: "info", onClick: refreshModels } as any)}>
              {isRefreshing() ? "[Refreshing…]" : "[Refresh]"}
            </text>
          </box>

          {/* Separator */}
          <text {...({ color: "muted" } as any)}>{"─".repeat(60)}</text>

          {/* Model list (scrollable) */}
          <box flexDirection="column" gap={0} flexGrow={1} overflow="scroll">
            {filtered.length === 0 && (
              <text {...({ color: "muted" } as any)}>No models found.</text>
            )}
            {filtered.map((m) => ModelRow(m))}
          </box>

          {/* Separator */}
          <text {...({ color: "muted" } as any)}>{"─".repeat(60)}</text>

          {/* Footer */}
          <box flexDirection="row" gap={1} justifyContent="flex-end">
            <text {...({ color: "accent", onClick: openConfirmation } as any)}>
              [Confirm{selectedCount > 0 ? ` (${selectedCount})` : ""}]
            </text>
            <text {...({ color: "muted", onClick: () => api.ui.dialog.clear() } as any)}>[Cancel]</text>
          </box>
        </box>
      </api.ui.Dialog>
    );
  }

  // ── Render: confirmation view ──
  function renderConfirmation() {
    const selected = availableModels().filter((m) => selectedIds().has(m.id));
    const freeCount = selected.filter((m) => m.isFree).length;
    const paidCount = selected.filter((m) => !m.isFree).length;

    return (
      <api.ui.Dialog size="large" onClose={() => api.ui.dialog.clear()}>
        <box flexDirection="column" padding={1} gap={1}>
          <text {...({ bold: true, color: "accent" } as any)}>Confirm Fallback Models</text>
          <text>You are about to set the following {selected.length} model(s) as your fallback chain:</text>
          <text {...({ color: "muted" } as any)}>
            {freeCount} free · {paidCount} paid · ordered by current sort
          </text>
          <text {...({ color: "muted" } as any)}>{"─".repeat(60)}</text>
          <box flexDirection="column" gap={0} maxHeight={20} overflow="scroll">
            {selected.map((m, i) => (
              <box flexDirection="row" gap={1}>
                <text {...({ color: "muted" } as any)}>{i + 1}.</text>
                <text {...({ color: m.isFree ? "accent" : undefined } as any)}>
                  {m.name} {m.isFree ? "(free)" : "(paid)"}
                </text>
                <text {...({ color: "muted" } as any)}>({m.id})</text>
              </box>
            ))}
          </box>
          <text {...({ color: "muted" } as any)}>{"─".repeat(60)}</text>
          <box flexDirection="row" gap={1} justifyContent="flex-end">
            <text {...({ color: "accent", onClick: confirmAndSave } as any)}>[Apply]</text>
            <text {...({ color: "muted", onClick: () => api.ui.dialog.replace(() => renderSelector()) } as any)}>[Back]</text>
            <text {...({ color: "muted", onClick: () => api.ui.dialog.clear() } as any)}>[Cancel]</text>
          </box>
        </box>
      </api.ui.Dialog>
    );
  }

  // Kick off the dialog with the selector view
  api.ui.dialog.replace(() => renderSelector());
}

function FallbackConfigTui(api: TuiPluginApi, options: PluginOptions | undefined): JSX.Element {
  const [config, setConfig] = createSignal<FallbackTuiConfig>(
    loadConfigForTui(),
    { equals: false }
  );

  // ── Key health check on TUI open ──
  // When the user opens the config panel, proactively check for key exhaustion
  (() => {
    try {
      const tuiConfig = loadConfig();
      const tuiState = loadState(tuiConfig.statePath || DEFAULT_STATE_PATH);
      const merged = tuiConfig.defaults;
      if (Object.keys(merged.apiKeys).length > 0) {
        notifyKeyHealth(tuiState, merged, _tuiNotified, log, (opts) => api.ui.toast(opts));
      }
    } catch {
      // Silently ignore errors in TUI key health check
    }
  })();
  
  function loadConfigForTui(): FallbackTuiConfig {
    const pluginConfig = loadConfig();
    return {
      apiKeys: pluginConfig.defaults.apiKeys,
      fallbackModels: pluginConfig.defaults.fallbackModels,
      largeContextModel: pluginConfig.defaults.largeContextModel,
      cooldownSeconds: pluginConfig.defaults.cooldownSeconds,
      maxRetries: pluginConfig.defaults.maxRetries
    };
  }
  
  function saveConfig() {
    // Read raw config to avoid deepMerge merging arrays
    let raw: Partial<SmartFallbackConfig> = {};
    try {
      if (existsSync(CONFIG_PATH)) {
        raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      }
    } catch {}
    if (!raw.defaults) raw.defaults = {} as any;
    raw.defaults!.apiKeys = config().apiKeys;
    raw.defaults!.fallbackModels = config().fallbackModels;
    raw.defaults!.largeContextModel = config().largeContextModel;
    raw.defaults!.cooldownSeconds = config().cooldownSeconds;
    raw.defaults!.maxRetries = config().maxRetries;
    // Preserve per-agent configs (never touched by TUI)
    // Preserve notification setting
    raw.notifications = raw.notifications ?? true;

    const configDir = dirname(CONFIG_PATH);
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2), "utf-8");

    api.ui.toast({ variant: "success", message: "Configuration saved successfully!" });
  }
  
  function addApiKey(providerId: string) {
    api.ui.dialog.replace(() => (
      <api.ui.DialogPrompt
        title={`Add API Key for ${providerId}`}
        placeholder="Enter API key"
        onConfirm={(value: string) => {
          if (value.trim()) {
            setConfig({
              ...config(),
              apiKeys: {
                ...config().apiKeys,
                [providerId]: [...(config().apiKeys[providerId] || []), value.trim()]
              }
            });
            saveConfig();
          }
        }}
        onCancel={() => api.ui.dialog.clear()}
      />
    ));
  }
  
  function removeApiKey(providerId: string, index: number) {
    setConfig({
      ...config(),
      apiKeys: {
        ...config().apiKeys,
        [providerId]: config().apiKeys[providerId].filter((_, i) => i !== index)
      }
    });
    saveConfig();
  }
  
  function openModelSelector() {
    ModelSelectorDialog(
      api,
      config().fallbackModels,
      (selectedModels: string[]) => {
        setConfig({ ...config(), fallbackModels: selectedModels });
        saveConfig();
      }
    );
  }
  
  function setLargeContextModel() {
    api.ui.dialog.replace(() => (
      <api.ui.DialogPrompt
        title="Set Large Context Model"
        placeholder="Enter model ID (e.g., anthropic/claude-3-opus)"
        value={config().largeContextModel || ""}
        onConfirm={(value: string) => {
          setConfig({
            ...config(),
            largeContextModel: value.trim() || undefined
          });
          saveConfig();
        }}
        onCancel={() => api.ui.dialog.clear()}
      />
    ));
  }
  
  return (
    <api.ui.Dialog size="large" onClose={() => api.ui.dialog.clear()}>
      <box flexDirection="column" padding={1} gap={1}>
        <text {...({ bold: true, color: "accent" } as any)}>Smart Fallback Configuration</text>
        
        <box flexDirection="column" gap={1}>
          <text {...({ bold: true } as any)}>API Keys</text>
          {Object.entries(config().apiKeys).map(([providerId, keys]) => (
            <box flexDirection="column" gap={0}>
              <text>{providerId}</text>
              {keys.map((key, index) => (
                <box flexDirection="row" gap={1}>
                  <text>• {key.substring(0, 8)}...{key.substring(key.length - 4)}</text>
                  <text {...({ color: "error", onClick: () => removeApiKey(providerId, index) } as any)}>
                    (remove)
                  </text>
                </box>
              ))}
              <text {...({ color: "accent", onClick: () => addApiKey(providerId) } as any)}>
                + Add another key
              </text>
            </box>
          ))}
<text {...({ color: "accent", onClick: () => {
             api.ui.dialog.replace(() => (
               <api.ui.DialogPrompt
                 title="Add Provider"
                 placeholder="Enter provider ID (e.g., openrouter)"
                 onConfirm={(value: string) => {
                   if (value.trim()) {
                     setConfig({
                       ...config(),
                       apiKeys: {
                         ...config().apiKeys,
                         [value.trim()]: []
                       }
                     });
                     api.ui.dialog.clear();
                     addApiKey(value.trim());
                   }
                 }}
                 onCancel={() => api.ui.dialog.clear()}
               />
             ));
           } } as any)}>
            + Add provider
          </text>
        </box>
        
        <box flexDirection="column" gap={1}>
          <text {...({ bold: true } as any)}>Fallback Models</text>
          <text {...({ color: "muted" } as any)}>
            {config().fallbackModels.length} model(s) configured
          </text>
          {config().fallbackModels.length === 0 && (
            <text {...({ color: "error" } as any)}>No fallback models set — will use default free pool.</text>
          )}
          {config().fallbackModels.slice(0, 5).map((model) => (
            <box flexDirection="row" gap={1}>
              <text>• {model}</text>
            </box>
          ))}
          {config().fallbackModels.length > 5 && (
            <text {...({ color: "muted" } as any)}>...and {config().fallbackModels.length - 5} more</text>
          )}
          <box flexDirection="row" gap={1}>
            <text {...({ color: "accent", onClick: openModelSelector } as any)}>
              [Open Model Selector]
            </text>
            {config().fallbackModels.length > 0 && (
              <text {...({ color: "error", onClick: () => {
                setConfig({ ...config(), fallbackModels: [] });
                saveConfig();
              } } as any)}>
                [Clear All]
              </text>
            )}
          </box>
        </box>
        
        <box flexDirection="column" gap={1}>
          <text {...({ bold: true } as any)}>Large Context Model</text>
          <text>
            {config().largeContextModel || "Not set"}
            {config().largeContextModel && (
              <text {...({ color: "error", onClick: () => {
                setConfig({ ...config(), largeContextModel: undefined });
                saveConfig();
              } } as any)}>
                (remove)
              </text>
            )}
          </text>
          <text {...({ color: "accent", onClick: setLargeContextModel } as any)}>
            {config().largeContextModel ? "Change" : "Set"} large context model
          </text>
        </box>
        
        <box flexDirection="column" gap={1}>
          <text {...({ bold: true } as any)}>Settings</text>
          <box flexDirection="row" gap={1}>
            <text>Cooldown seconds:</text>
            <input
              value={config().cooldownSeconds.toString()}
              onChange={(value) => {
                const num = parseInt(value) || 30;
                setConfig({ ...config(), cooldownSeconds: num });
                saveConfig();
              }}
              width={5}
            />
          </box>
          <box flexDirection="row" gap={1}>
            <text>Max retries:</text>
            <input
              value={config().maxRetries.toString()}
              onChange={(value) => {
                const num = parseInt(value) || 3;
                setConfig({ ...config(), maxRetries: num });
                saveConfig();
              }}
              width={5}
            />
          </box>
        </box>
        
        <box flexDirection="row" gap={1} justifyContent="flex-end">
          <text {...({ color: "muted", onClick: () => api.ui.dialog.clear() } as any)}>Close</text>
        </box>
      </box>
    </api.ui.Dialog>
  );
}

// TUI plugin entry point
const tuiPlugin: TuiPlugin = async (api, options, meta) => {
  // Register route for fallback configuration
  api.route.register([
    {
      name: "fallback-config",
      render: () => FallbackConfigTui(api, options)
    }
  ]);
  
  // Register command to open fallback configuration
  api.keymap.registerLayer({
    commands: [
      {
        id: "fallback.config.open",
        title: "Open Fallback Configuration",
        description: "Configure API keys, fallback models, and settings for the smart fallback plugin",
        category: "Plugins",
        keybind: "alt+p",
        onSelect: () => {
          api.route.navigate("fallback-config");
        }
      }
    ]
  });
};

export default plugin;
export { plugin, tuiPlugin as tui };
export type { SmartFallbackConfig, AgentFallbackConfig };