# Project Context

## Project: opencode-smart-fallback Plugin

A multi-API-key rotation, model fallback, and rate-limit-smart system plugin for OpenCode.

## Environment
- **Language:** TypeScript (ES2022)
- **Runtime:** Bun 1.3.14 / Node (OpenCode v1.17.5)
- **Plugin SDK:** `@opencode-ai/plugin@1.16.2`
- **Package Manager:** Bun
- **Build:** `bun x tsc --noEmit` (type check)
- **Entry:** `plugins/opencode-smart-fallback.ts`

## Location
- **Source:** `/root/opencode-fallback-ultimate/plugins/opencode-smart-fallback.ts`
- **Config (auto-gen):** `~/.config/opencode/opencode-smart-fallback.json`
- **State (auto-gen):** `~/.config/opencode/opencode-smart-fallback-state.json`

## Files
```
/root/opencode-fallback-ultimate/
  plugins/
    opencode-smart-fallback.ts   ← Plugin source (~400 lines)
  package.json                    ← Dependencies (bundled)
  tsconfig.json                   ← TypeScript config
  bun.lock                        ← Lockfile
  .opencode/
    todo.md                       ← Task tracking
    context.md                    ← This file
    .gitignore                    ← Ignore config
```

## Plugin Architecture

### Hooks Used
| Hook | Purpose |
|------|---------|
| `config` | Inject fallback chains into agent options at startup |
| `event` | Classify errors, manage cooldowns, rotate keys, log events |
| `chat.params` | Lower temperature on retry, boost max tokens for large context |
| `chat.headers` | Rotate API keys (round-robin with health tracking) |
| `experimental.session.compacting` | Inject context preservation instructions |
| `experimental.compaction.autocontinue` | Keep auto-continue enabled |
| `dispose` | Flush cooldown/state to disk |

### Error Classification
| Class | Detected By | Action |
|-------|------------|--------|
| `auth` | `ProviderAuthError` | Immediate fallback, 5min cooldown, key rotation |
| `rate_limit` | `APIError` 429 | Exponential backoff, Retry-After parsing, key cooldown |
| `retryable` | 5xx / `isRetryable` | Exponential backoff with jitter |
| `context` | `MessageOutputLengthError` / `ContextOverflowError` | Switch to large context model |
| `non_retryable` | 4xx non-auth / `MessageAbortedError` | Don't retry |
| `unknown` | Everything else | Default retry safety net |

### Key Rotation
- Round-robin across configured keys per provider
- Keys are cooled down individually on failure
- Exponential penalty per consecutive failure per key
- Falls back to least-recently-failed key when all are cooled down
- Key state persisted across restarts

### Cooldown Strategy
- **Auth errors:** 5+ min (exponential penalty 1.5^x)
- **Rate limits:** From Retry-After header, or 60s base (exponential penalty)
- **Transient:** 30s base (exponential penalty)
- **Success event:** Cooldown cleared immediately

### Configuration
Auto-generated at `~/.config/opencode/opencode-smart-fallback.json`:

```json
{
  "defaults": {
    "fallbackModels": [],
    "apiKeys": {},
    "contextThreshold": 0.85,
    "cooldownSeconds": 30,
    "maxRetries": 3,
    "backoff": { "initialDelayMs": 1000, "maxDelayMs": 60000, "multiplier": 2 }
  },
  "agents": {},
  "notifications": true
}
```

### Orchestrator Agent Integration

The plugin integrates with opencode's built-in orchestrator agents:

| Agent | Role | Fallback Integration |
|-------|------|----------------------|
| **Commander** | Orchestrates all phases of the mission | Full fallback support with key rotation, model fallback, and error handling |
| **Planner** | Strategic planning and research specialist | Full fallback support with key rotation, model fallback, and error handling |
| **Worker** | Implementation and documentation specialist | Full fallback support with key rotation, model fallback, and error handling |
| **Reviewer** | Verification and quality assurance specialist | Full fallback support with key rotation, model fallback, and error handling |

Each agent can have custom fallback configurations that inherit from defaults:

```json
{
  "agents": {
    "Commander": {
      "fallbackModels": ["mistral/mistral-small-2.2", "nvidia/nemotron-free"],
      "apiKeys": {"openrouter": ["key1", "key2"]},
      "cooldownSeconds": 60
    }
  }
}
```

### Registration (pending user approval)
To enable, add to `~/.config/opencode/opencode.json`:
```json
{ "plugin": ["./plugins/opencode-smart-fallback.ts"] }
```
