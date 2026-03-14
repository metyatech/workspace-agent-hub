# Workspace Agent Hub

Workspace Agent Hub is the Windows + WSL tmux session fabric for running and
resuming multiple AI agent CLI sessions across PC and smartphone.

It provides:

- A Windows launcher for starting, reopening, renaming, archiving, closing, and
  deleting agent sessions
- A WSL mobile menu that opens automatically after SSH login from tools such as
  Termius
- Regression tests for the primary PC/mobile handoff paths
- A foundation that can be paired with `thread-inbox manager-gui` as the
  higher-level Manager inbox

## Supported environments

- Windows 11 host
- PowerShell 7 or Windows PowerShell
- WSL2 with an Ubuntu distro
- `tmux` installed inside WSL
- Optional: Android emulator for the ConnectBot coverage path

## Install / setup

1. Configure git hooks:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-hooks.ps1
   ```

2. Refresh agent rules for this repository:

   ```powershell
   compose-agentsmd
   ```

3. Install the WSL mobile-login hook from inside WSL:

   ```bash
   ./scripts/install-wsl-mobile-menu-hook.sh
   ```

4. Optionally create Windows shortcuts for the launcher:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-agent-session-launcher-shortcuts.ps1
   ```

## Usage

### Windows launcher

Open the GUI:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/agent-session-launcher.ps1
```

Open one profile directly:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/agent-session-launcher.ps1 -Mode codex
```

List all sessions, including archived or closed entries:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/agent-session-launcher.ps1 -Mode list -Json -IncludeArchived
```

Rename an existing session:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/agent-session-launcher.ps1 -Mode rename -SessionName shell-example -Title "Current debugging task"
```

Archive a session without killing it:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/agent-session-launcher.ps1 -Mode archive -SessionName shell-example
```

Close a running session while keeping its catalog entry:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/agent-session-launcher.ps1 -Mode close -SessionName shell-example
```

Delete a session entry entirely:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/agent-session-launcher.ps1 -Mode delete -SessionName shell-example
```

### WSL mobile menu

Show archived and closed entries from the WSL-side CLI:

```bash
./scripts/wsl-agent-mobile-menu.sh list-all
```

Open the mobile management flow for rename/archive/close/delete:

```bash
./scripts/wsl-agent-mobile-menu.sh manage
```

### Pairing with Manager

Workspace Agent Hub is the session fabric. The current higher-level Manager
inbox UI lives in `thread-inbox`:

```powershell
thread-inbox manager-gui .. --host 0.0.0.0 --port 3335 --auth-token auto
```

That GUI can sit above this session fabric while start-or-attach integration is
being completed.

## Verification

Lint:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/lint.ps1
```

Full local test suite:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test.ps1
```

Add the Android emulator path:

```powershell
$env:WORKSPACE_AGENT_HUB_RUN_ANDROID_MOBILE_E2E='1'; powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test.ps1
```

Regenerate agent rules:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build.ps1
```

## Primary path matrix

This repository claims the following primary handoff paths.

| Path | Claimed behavior | Automated evidence |
| --- | --- | --- |
| `P1` | PC-side launcher flow can create a session, surface it in the inventory, and resolve it again for reopening. | `scripts/test-primary-path-matrix.ps1` |
| `P2` | A session started from the PC side can be reopened from the mobile SSH menu. | `scripts/test-mobile-ssh.py` |
| `P3` | A session started from the mobile SSH menu becomes visible and reopenable from the PC-side launcher flow. | `scripts/test-mobile-ssh.py` |
| `P4` | When multiple sessions exist, the user can distinguish and reopen the intended one by title/folder. | `scripts/test-primary-path-matrix.ps1` and `scripts/test-mobile-ssh.py` |

## Environment variables

- `WORKSPACE_AGENT_HUB_RUN_ANDROID_MOBILE_E2E=1`
  Runs the Android emulator + ConnectBot coverage path during `scripts/test.ps1`.
- `AI_AGENT_SESSION_CATALOG_PATH`
  Overrides the session catalog file used by the mobile menu.
- `AI_AGENT_SESSION_NO_ATTACH=1`
  Keeps the mobile menu tests from attaching the current shell to the created
  session.
- `AI_AGENT_MOBILE_BYPASS=1`
  Prevents the login bootstrap from opening the mobile menu automatically.

## Release / deploy

This repository is a workspace tool repository, not a publishable package.
There is no release artifact beyond git history at the moment.

## Links

- [CHANGELOG.md](CHANGELOG.md)
- [SECURITY.md](SECURITY.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [LICENSE](LICENSE)
