# Improvement Roadmap

Tracked improvements from the comprehensive codebase audit.

## 🔴 High Priority

### H1 — Automated Test Runner
Wire the existing `runAllTests()` into `package.json` so tests auto-run before commits.
- **Branch:** `feat/auto-test-runner`
- **Status:** pending
- **PR:** —

### H2 — Test Coverage for New Features
Add unit tests for `interleaveProviders`, `filterCooldownProviders`, `checkKeyHealth`, `fetchAvailableModels`, `setProviderCooldown`, and `ModelSelectorDialog`.
- **Branch:** `feat/test-coverage`
- **Status:** pending
- **PR:** —

### H3 — State Version Migration
Implement `migrateState()` so old state files aren't silently dropped when `PersistedState` shape changes.
- **Branch:** `feat/state-migration`
- **Status:** pending
- **PR:** —

## 🟡 Medium Priority

### M1 — Multi-Provider Health Endpoints
Fetch models from Mistral, Nvidia, and OpenCode APIs in addition to OpenRouter.
- **Branch:** `feat/multi-provider-endpoints`
- **Status:** pending
- **PR:** —

### M2 — Configuration Validation
Add input clamping and validation for TUI numeric fields (cooldown, retries).
- **Branch:** `feat/config-validation`
- **Status:** pending
- **PR:** —

### M3 — Config Backup Before Write
Atomic writes with `.bak` fallback to prevent config corruption.
- **Branch:** `feat/config-backup`
- **Status:** pending
- **PR:** —

### M4 — Stale Cooldown Cleanup
Auto-prune expired cooldowns from state on startup and dispose.
- **Branch:** `feat/stale-cleanup`
- **Status:** pending
- **PR:** —

### M5 — Per-Agent TUI Model Selector
Add agent selector dropdown to edit per-agent fallback models in the TUI.
- **Branch:** `feat/per-agent-tui`
- **Status:** pending
- **PR:** —

## 🟢 Low Priority

### L1 — Usage Statistics Dashboard
Show per-model success/failure counts and per-key rotation stats in TUI.
- **Branch:** `feat/stats-dashboard`
- **Status:** pending

### L2 — Multiple Fallback Strategies
Support latency-optimized, cost-optimized, and round-robin strategies.
- **Branch:** `feat/fallback-strategies`
- **Status:** pending

### L3 — Export/Import Config
Buttons to backup/share model/key configuration.
- **Branch:** `feat/config-export`
- **Status:** pending

### L4 — Configurable Log Verbosity
Add `logLevel` config option (error/warn/info/debug).
- **Branch:** `feat/log-verbosity`
- **Status:** pending

### L5 — Context-Window-Aware Sorting
Add "Largest Context" sort mode to ModelSelector.
- **Branch:** `feat/context-sort`
- **Status:** pending

### L6 — Concurrency Guard for State
Add mutex for concurrent state access from multiple hooks.
- **Branch:** `feat/concurrency-guard`
- **Status:** pending

### L7 — Robust Retry-After Parsing
Handle non-standard `Retry-After` header formats.
- **Branch:** `feat/retryafter-robust`
- **Status:** pending
