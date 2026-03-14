# Workspace Agent Hub

Workspace Agent Hub is the Windows + WSL tmux session fabric for running and
resuming multiple AI agent CLI sessions across PC and smartphone. It now
includes a mobile-friendly browser UI/PWA for starting sessions, reopening
them, and sending follow-up prompts without dropping into raw terminal flows.

It provides:

- A Windows launcher for starting, reopening, renaming, archiving, closing, and
  deleting agent sessions
- A WSL mobile menu that opens automatically after SSH login from tools such as
  Termius
- A browser UI/PWA for smartphone and desktop session management, transcript
  viewing, and prompt sending
- Regression tests for the primary PC/mobile handoff paths
- A foundation that can be paired with `thread-inbox manager-gui` as the
  higher-level Manager inbox

## Supported environments

- Windows 11 host
- PowerShell 7 or Windows PowerShell
- Node.js 22+
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

3. Install Node dependencies:

   ```powershell
   npm ci
   ```

4. Install the WSL mobile-login hook from inside WSL:

   ```bash
   ./scripts/install-wsl-mobile-menu-hook.sh
   ```

5. Optionally create Windows shortcuts for the launcher:

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

### Browser UI / PWA

Start the local browser UI with an auto-generated access code:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-web-ui.ps1
```

Start it without automatically opening a desktop browser:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-web-ui.ps1 -NoOpenBrowser
```

Start it with a fixed access code so a phone can reconnect later:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-web-ui.ps1 -Host 0.0.0.0 -Port 3360 -AuthToken "replace-with-your-code"
```

Start it with a phone-facing HTTPS/Tailscale URL so the browser app can render a reconnect QR and copyable one-tap link:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-web-ui.ps1 -Host 0.0.0.0 -Port 3360 -PublicUrl "https://agent-hub.example.ts.net"
```

Start it through the CLI directly:

```powershell
workspace-agent-hub web-ui --host 127.0.0.1 --port 3360 --auth-token auto
```

Print one JSON object with the listening URL, preferred connect URL, access code,
and one-tap pairing link for automation or launcher integration:

```powershell
workspace-agent-hub web-ui --host 127.0.0.1 --port 3360 --auth-token auto --json --no-open-browser
```

The PowerShell wrapper exposes the same behavior with `-JsonOutput`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-web-ui.ps1 -JsonOutput -NoOpenBrowser
```

#### CLI parameters

`workspace-agent-hub web-ui` supports these parameters:

| Parameter              | Description                                                                                                                                                     | Example                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `--host <host>`        | Host/IP to bind. Use `127.0.0.1` for local-only access or `0.0.0.0` when another device reaches the PC through Tailscale or another trusted network path.       | `workspace-agent-hub web-ui --host 0.0.0.0`                                |
| `--port <port>`        | Preferred port. If already taken, the server walks upward to the next free port.                                                                                | `workspace-agent-hub web-ui --port 3360`                                   |
| `--public-url <url>`   | Phone-facing URL used for reconnect links and QR pairing. Point this at Tailscale Serve or another trusted HTTPS reverse proxy when using the PWA from a phone. | `workspace-agent-hub web-ui --public-url https://agent-hub.example.ts.net` |
| `--auth-token <token>` | Access code for API/browser auth. Use `auto` to generate one, or `none` only on a trusted local machine.                                                        | `workspace-agent-hub web-ui --auth-token auto`                             |
| `--json`               | Print a single JSON object describing the live web UI endpoint, connect URL, access code, and pairing link.                                                     | `workspace-agent-hub web-ui --json --no-open-browser`                      |
| `--no-open-browser`    | Start the server without opening the default desktop browser.                                                                                                   | `workspace-agent-hub web-ui --no-open-browser`                             |

End-to-end example:

```powershell
workspace-agent-hub web-ui --host 0.0.0.0 --port 3360 --auth-token auto --no-open-browser
```

First-use flow:

1. Start the web UI on the PC.
2. Read the printed URL and access code from the terminal.
3. Open the URL from the phone over Tailscale or another trusted route.
4. Paste the access code once.
5. Use the pairing card to share or copy a one-tap reconnect link, or scan its QR on the phone.
6. If the page is served over HTTPS, use the install card to add it to the home screen.
7. Start or reopen a session, then use the transcript and prompt box from the same page.
8. If needed, enable browser notifications or use the device-lock button to clear the saved access code on that browser.
9. Use the session search box and browser-local favorites to keep frequently reused sessions easy to reopen on that device.

Installable/PWA note:

- The browser app registers a service worker on normal HTTP for local caching,
  but installable PWA mode requires a secure context.
- The intended secure path is to front the local web UI with Tailscale Serve or
  another HTTPS-capable reverse proxy.
- When the network drops, the app keeps showing the last cached session list and
  transcript until connectivity returns.
- The browser UI can optionally notify on selected-session output while the page
  is hidden, and it can clear the saved browser-side access code/cache with the
  device-lock control.
- The session list supports browser-local favorites plus title/folder/preview
  search, so a phone can pin the sessions it reopens most often without changing
  the shared backend catalog.
- When `--public-url` is provided, the browser app shows a QR, a share action,
  and a copyable one-tap reconnect link that includes the access code in the
  URL fragment.

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

Node-layer verify only:

```powershell
npm run verify
```

Real-browser web UI verification only:

```powershell
npm run test:e2e
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

| Path | Claimed behavior                                                                                                                                                                                                                                                                                                    | Automated evidence                                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `P1` | PC-side launcher flow can create a session, surface it in the inventory, and resolve it again for reopening.                                                                                                                                                                                                        | `scripts/test-primary-path-matrix.ps1`                                                                                           |
| `P2` | A session started from the PC side can be reopened from the mobile SSH menu.                                                                                                                                                                                                                                        | `scripts/test-mobile-ssh.py`                                                                                                     |
| `P3` | A session started from the mobile SSH menu becomes visible and reopenable from the PC-side launcher flow.                                                                                                                                                                                                           | `scripts/test-mobile-ssh.py`                                                                                                     |
| `P4` | When multiple sessions exist, the user can distinguish and reopen the intended one by title/folder.                                                                                                                                                                                                                 | `scripts/test-primary-path-matrix.ps1` and `scripts/test-mobile-ssh.py`                                                          |
| `P5` | The browser UI can authenticate, list sessions, start a session, display transcript output, search/prioritize browser-local favorite sessions, surface install/offline/notification guidance, render QR/copyable smartphone pairing links, locally lock the current browser, and manage archive/close/delete flows. | `e2e/web-ui.spec.ts`, `src/__tests__/web-ui.test.ts`, `src/__tests__/web-app-dom.test.ts`, `scripts/test-web-session-bridge.ps1` |

## Environment variables

- `WORKSPACE_AGENT_HUB_RUN_ANDROID_MOBILE_E2E=1`
  Runs the Android emulator + ConnectBot coverage path during `scripts/test.ps1`.
- `AI_AGENT_SESSION_CATALOG_PATH`
  Overrides the session catalog file used by the mobile menu.
- `WORKSPACE_AGENT_HUB_WEB_UI_AUTH_TOKEN`
  Optional environment override for the browser UI access code when a wrapper or
  service manager wants to inject one.
- `WORKSPACE_AGENT_HUB_WEB_UI_PUBLIC_URL`
  Optional phone-facing URL used for the reconnect QR and one-tap pairing link.
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
