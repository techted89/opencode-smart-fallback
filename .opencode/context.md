# Project Context

## Environment
- Language: TypeScript (JSX)
- Runtime: Bun
- Build: tsc --noEmit
- Test: bun run plugins/opencode-smart-fallback.tsx --test
- Package Manager: npm / Bun

## GitHub
- Repo: https://github.com/techted89/opencode-smart-fallback
- Branch: main (up-to-date with origin/main)
- Authenticated as: techthed89

## PRs
| # | Branch | Title | Status |
|---|--------|-------|--------|
| 1 | feat/auto-test-runner | feat: auto test runner with npm scripts | Open |
| 2 | feat/test-coverage | feat: comprehensive test coverage for new features | Open |

## Changes vs main
- PR #1: CLI --test entry point, Array.isArray guard, npm scripts
- PR #2: 8 new test suites, filterCooldownProviders fallback fix, formatDuration Math.floor fix

## Key Files
- `plugins/opencode-smart-fallback.tsx` — Plugin source (all code + tests)
- `package.json` — Dependencies + scripts
- `IMPROVEMENTS.md` — Improvement roadmap (high/medium/low priority items)
- `.github/ISSUE_TEMPLATE/improvement.md` — Improvement issue template

## Infrastructure
- CI: Not yet configured in repo (template available in skill)
- Git workflow skill: `/root/.config/opencode/skills/git-workflow/SKILL.md`
  - Reusable pipeline for any project
  - Branch naming, commit conventions, PR workflow, CI/CD templates
  - Load via `skill("git-workflow")`

## Test Status
All 13 tests pass across 4 suites:
1. State persistence ✓
2. Orchestrator integration ✓
3. Regression (5 tests) ✓
4. New features (8 tests) ✓
