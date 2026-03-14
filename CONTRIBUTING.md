# Contributing

Thanks for your interest in contributing to `workspace-agent-hub`.

## Scope

This repository provides the workspace-level AI session fabric that supports PC/mobile handoff across multiple repositories in the same workspace.

## Workflow

- Create a branch (optional) or work on `main`.
- Keep docs and verification aligned with behavior changes.
- Regenerate `AGENTS.md` by running `compose-agentsmd`.
- Commit with a clear message and open a PR if desired.

## Development commands

- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-hooks.ps1`
- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/lint.ps1`
- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test.ps1`
- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build.ps1`

## Testing

Run the full verification suite before each commit:

- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/lint.ps1`
- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test.ps1`
- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build.ps1`

Use `WORKSPACE_AGENT_HUB_RUN_ANDROID_MOBILE_E2E=1` when you want the optional Android-emulator mobile SSH check.
