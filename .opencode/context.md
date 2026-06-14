# Project Context

## Final State — All work merged to `main`

### Git Log
```
ff1d82b feat: comprehensive test coverage with formatDuration fix
2652024 feat: auto test runner with npm scripts
3a3fc36 docs: add improvement roadmap tracking document
cdd6059 Initial commit: smart-fallback plugin
```

### PRs Merged (squash)
| # | Branch | Title |
|---|--------|-------|
| 1 | feat/auto-test-runner | Auto test runner with npm scripts |
| 2 | feat/test-coverage | Comprehensive test coverage + formatDuration fix |

### Review Fixes Applied
- PR #1: `Array.isArray(process.argv)` guard (Gemini review), `precommit` → `validate` rename (CodeRabbit)
- PR #2: `formatDuration` `Math.floor` fix (Gemini review)

### Test Status
All 13 tests pass across 4 suites

### Standalone Git Workflow Skill
`/root/.config/opencode/skills/git-workflow/SKILL.md` (262 lines)
- Branch/convention docs, CI/CD templates, PR workflow
- **Review agent interaction guide** added:
  - CodeRabbit: `@coderabbitai review | full review | help`
  - Gemini: `/gemini review | summary | help`
- Reusable for any project via `skill("git-workflow")`

### Repo
https://github.com/techted89/opencode-smart-fallback
