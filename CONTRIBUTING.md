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

- `npm ci`
- `npm run verify`
- `npm run test:e2e`
- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-hooks.ps1`
- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/lint.ps1`
- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test.ps1`
- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build.ps1`
- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-web-ui.ps1 -NoOpenBrowser`

## Testing

Run the full verification suite before each commit:

- `npm run verify`

`npm ci` installs the repository git hooks automatically. The pre-commit
hook runs the same `npm run verify` entrypoint as CI, then refreshes the
generated instruction files with `compose-agentsmd --compose` and stages them.

Use the component commands only when you need to rerun a specific phase:

- `npm run test:e2e`
- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/lint.ps1`
- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test.ps1`
- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build.ps1`

Use `WORKSPACE_AGENT_HUB_RUN_ANDROID_MOBILE_E2E=1` when you want the optional Android-emulator mobile SSH check.

For browser UI changes, also start the local UI and dogfood the primary
smartphone flow before concluding:

- Start the UI with `scripts/start-web-ui.ps1`
- Open it from a browser
- Authenticate
- Start or reopen a session
- Confirm transcript refresh and prompt sending
