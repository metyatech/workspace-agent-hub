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
  viewing, prompt sending, and browser-local resume cues
- Regression tests for the primary PC/mobile handoff paths
- An `Open Manager` path that opens Hub's native Manager inbox on the same
  authenticated origin for both PC and smartphone

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

5. Optionally install the always-on browser UI shortcuts:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-web-ui-shortcuts.ps1
   ```

   This installs a Startup shortcut that launches a small phone-ready watchdog
   after Windows sign-in. The watchdog keeps the same Hub and Manager reachable
   from a smartphone without using Remote Desktop while the PC stays on and the
   Windows user session remains signed in, and it recreates the web UI
   automatically if that background process exits.

   This is the canonical day-to-day entrypoint. The installer also removes the
   old `AI Agent Sessions` shortcut if it still exists on this PC.

## Usage

### Low-level session launcher

The raw session launcher remains available for maintenance or direct tmux-backed
session work, but it is no longer the recommended daily entrypoint. Use the
browser Hub from the Desktop or Start Menu first.

Open the low-level launcher directly:

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

Open the browser UI without remembering the full command. This helper reuses an
already-running background server when possible and opens the browser directly:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/open-web-ui.ps1
```

Keep the browser UI server running in the background without opening a browser:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ensure-web-ui-running.ps1
```

Keep the background instance smartphone-ready so the reconnect URL/QR stays
available for phone access:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ensure-web-ui-running.ps1 -PhoneReady
```

Keep a self-healing phone-ready watchdog running in the background for the
current signed-in Windows session:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/keep-web-ui-phone-ready.ps1
```

The shortcut installer creates:

- `Workspace Agent Hub` on the Desktop and Start Menu, which opens the browser
  UI directly
- `Workspace Agent Hub Background` in the Windows Startup folder, which starts
  the phone-ready watchdog after sign-in so the phone can reconnect anytime
  while the PC is on, the user session stays signed in, and the Hub process can
  self-heal if it stops
- It also removes any stale `AI Agent Sessions` shortcut so the browser Hub is
  the only normal Windows entrypoint

Use the direct wrapper if you still want to launch it manually once:

Start the local browser UI with an auto-generated access code:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-web-ui.ps1
```

Start it in the recommended smartphone-ready mode so the script configures
Tailscale Serve and emits an installable HTTPS tailnet URL. If automatic HTTPS
setup does not complete on this machine, it falls back to a Tailscale-direct
URL instead of hanging. The opened PC page is preloaded so the smartphone QR is
ready immediately. If Tailscale Serve has not been enabled on the tailnet yet,
the command now points you at the stable Tailscale DNS settings page and keeps
the direct tailnet URL available until you enable HTTPS Certificates there and
rerun the same command. If the HTTPS tailnet endpoint currently responds with
`HTTP 502`, Hub now keeps the QR/default smartphone path on the verified
Tailscale-direct URL and shows HTTPS recovery guidance as a secondary step:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-web-ui.ps1 -PhoneReady
```

Start it without automatically opening a desktop browser:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-web-ui.ps1 -NoOpenBrowser
```

Start it with a fixed access code so a phone can reconnect later:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-web-ui.ps1 -ListenHost 0.0.0.0 -Port 3360 -AuthToken "replace-with-your-code"
```

Start it with a phone-facing HTTPS/Tailscale URL so the browser app can render a reconnect QR and copyable one-tap link:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-web-ui.ps1 -ListenHost 0.0.0.0 -Port 3360 -PublicUrl "https://agent-hub.example.ts.net"
```

Start it with an explicit Tailscale Serve-backed HTTPS URL by using the CLI
flag directly:

```powershell
workspace-agent-hub web-ui --tailscale-serve --auth-token auto --no-open-browser
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

Wrapper-specific parameters that differ from the CLI:

| Parameter            | Description                                                                   | Example                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `-ListenHost <host>` | PowerShell-safe equivalent of the CLI `--host` option.                        | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-web-ui.ps1 -ListenHost 0.0.0.0`        |
| `-PhoneReady`        | PowerShell shortcut for `--tailscale-serve` plus the normal wrapper defaults. | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-web-ui.ps1 -PhoneReady -NoOpenBrowser` |
| `-JsonOutput`        | PowerShell wrapper switch for CLI `--json`.                                   | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-web-ui.ps1 -JsonOutput -NoOpenBrowser` |
| `-NoOpenBrowser`     | PowerShell wrapper switch for CLI `--no-open-browser`.                        | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-web-ui.ps1 -NoOpenBrowser`             |

#### CLI parameters

`workspace-agent-hub web-ui` supports these parameters:

| Parameter              | Description                                                                                                                                                       | Example                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `--host <host>`        | Host/IP to bind. Use `127.0.0.1` for local-only access or `0.0.0.0` when another device reaches the PC through Tailscale or another trusted network path.         | `workspace-agent-hub web-ui --host 0.0.0.0`                                |
| `--port <port>`        | Preferred port. If already taken, the server walks upward to the next free port.                                                                                  | `workspace-agent-hub web-ui --port 3360`                                   |
| `--public-url <url>`   | Phone-facing URL used for reconnect links and QR pairing. Point this at Tailscale Serve or another trusted HTTPS reverse proxy when using the PWA from a phone.   | `workspace-agent-hub web-ui --public-url https://agent-hub.example.ts.net` |
| `--tailscale-serve`    | Configure Tailscale Serve for this run and prefer the resulting HTTPS tailnet URL. Useful for the normal smartphone/PWA path when the PC is already on Tailscale. | `workspace-agent-hub web-ui --tailscale-serve`                             |
| `--auth-token <token>` | Access code for API/browser auth. Use `auto` to generate one, or `none` only on a trusted local machine.                                                          | `workspace-agent-hub web-ui --auth-token auto`                             |
| `--json`               | Print a single JSON object describing the live web UI endpoint, connect URL, access code, and pairing link.                                                       | `workspace-agent-hub web-ui --json --no-open-browser`                      |
| `--no-open-browser`    | Start the server without opening the default desktop browser.                                                                                                     | `workspace-agent-hub web-ui --no-open-browser`                             |

End-to-end example:

```powershell
workspace-agent-hub web-ui --host 0.0.0.0 --port 3360 --auth-token auto --no-open-browser
```

First-use flow:

1. Start the web UI on the PC.
2. Let the local PC page open and show the pairing card.
3. Scan the pairing QR from the phone. Treat the printed link and copy/share controls as fallback only when scanning is not available.
4. If the terminal or secure-launch card tells you to open the Tailscale DNS settings page, open it once on the PC, enable HTTPS Certificates there, and rerun the same `-PhoneReady` command to upgrade the path to HTTPS.
5. If the page is served over HTTPS, use the install card to add it to the home screen.
6. Start or reopen a session, then use the transcript and prompt box from the same page.
7. If needed, enable browser notifications or use the device-lock button to clear the saved access code on that browser.
8. Use the session search box, browser-local favorites, the remembered last-session card, and saved prompt drafts to jump back into the same work quickly on that device.

#### Browser/mobile handoff state matrix

The browser app carries auth state in `localStorage`. The claimed primary paths
and their token-source precedence rules are:

| State               | localStorage token       | URL hash `#accessCode=`  | Auth source                       | QR / app result                                    |
| ------------------- | ------------------------ | ------------------------ | --------------------------------- | -------------------------------------------------- |
| **Fresh**           | absent                   | present                  | URL hash → stored to localStorage | Token stored, QR rendered                          |
| **Fresh**           | absent                   | absent                   | none                              | Auth overlay shown; user must enter code           |
| **Resumed**         | present and valid        | absent                   | localStorage                      | QR rendered; no re-auth needed                     |
| **Stale + hash**    | present (old server run) | present (new server run) | URL hash overrides localStorage   | New token stored, old token discarded, QR rendered |
| **Stale (no hash)** | present (old server run) | absent                   | localStorage (rejected by server) | API returns 401 → auth overlay shown               |

The server embeds the current access code in the browser-open URL on every
start, so the URL hash always takes precedence over any cached localStorage
value. This ensures that a phone opening the browser-open URL after a server
restart always gets the correct token, even if an older token is still cached in
that browser.

Automated tests in `src/__tests__/web-app-dom.test.ts` cover all five rows of
this matrix.

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
- When Tailscale is available, the launcher can emit a tailnet-direct reconnect
  URL automatically, and `--tailscale-serve` / `-PhoneReady` upgrades that path
  to an installable HTTPS tailnet URL in the same run.
- The session list supports browser-local favorites plus title/folder/preview
  search, so a phone can pin the sessions it reopens most often without changing
  the shared backend catalog.
- The browser remembers the last reopened session on that device, preserves
  unsent prompt drafts per session, and marks sessions with unseen output based
  on browser-local seen activity.
- When `--public-url` is provided, the browser app treats the QR as the primary
  smartphone entry path, while the share action and one-tap reconnect link stay
  available as fallback.
- When `--tailscale-serve` or `-PhoneReady` hits a tailnet where Serve is not
  enabled yet, the launcher points you at the stable Tailscale DNS settings
  page and the browser UI shows the same next step so you can finish HTTPS
  approval without guessing why the upgrade did not happen.

### Open Manager

Workspace Agent Hub now provides the official `Open Manager` entrypoint in the
browser UI.

The Manager UX design and behavior for the single global composer plus
AI-managed work-item graph routing is documented in
[docs/manager-global-inbox.md](docs/manager-global-inbox.md).

How it works:

1. Open the normal Hub page from the PC or smartphone.
2. Use `Manager を開く`.
3. The browser moves into Hub's native `/manager/` page on the same origin and in the same tab.
4. The Manager page reads and writes the workspace `.threads.jsonl` and
   `.tasks.jsonl` files directly through Hub's own API.
5. The user writes from one global send dock instead of creating tasks by hand;
   the writing surface stays collapsed on the inbox, then stays visible while a
   work-item conversation screen is open.
6. The built-in manager backend splits each message across existing tasks,
   new tasks, or routing-confirmation items, then executes each routed task
   in order and writes the resulting updates back into the task.
7. The built-in manager backend starts inside Hub when needed and keeps
   handling inbox messages for that workspace.

Important behavior:

- The same Hub access code protects the smartphone/desktop Manager path.
- There is no separate `manager-gui` process or second GUI server anymore.
- `Open Manager` is now a direct navigation path to Hub's own Manager page.
- Users send from one global dock; they do not need to create or pick a task
  before sending, and the larger text area only opens when they choose to
  write.
- When Manager splits a freeform message into tasks, the default granularity is
  one new user turn per work item. Follow-ups to existing work items are
  normally stored as new derived work items with `derived_from` parent links
  and parent context embedded into the stored user message, while only direct
  replies to an outstanding confirmation stay inside the same work item.
- The Manager page now surfaces a prominent live status summary so it is easy
  to tell whether AI is actively processing, idle, or waiting on the user, and
  how many tasks currently sit in each urgency bucket.
- The Manager page keeps a `まず見る` priority lane near the top, but limits
  that lane to items the human can actually act on now. `AI の順番待ち` and
  `AI作業中` remain in the inbox buckets instead of cluttering the read-next
  lane.
- Opening a work item now moves into a dedicated conversation screen with the
  message history in chat order and the newest message at the bottom, scrolls
  that conversation to the latest message when the work item opens, and lets the
  browser back button return to the Manager list before leaving Hub.
- The current built-in Manager routes each global send with a fresh Codex
  routing turn so old router-chat context does not blur distinct tasks, then
  executes each actionable task with its own persisted Codex worker
  continuation so routed requests do real repository work instead of stopping
  at inbox acknowledgements.
- The global send dock now shows an explicit send target: either the whole
  inbox or a selected work item mention hint, so follow-up messages can keep
  that work item attached without bypassing the normal routing pass.
- Manager work-item messages now preserve multiline user text, support inline image
  insertion inside the message body via drag-and-drop or Ctrl/Cmd+V clipboard
  paste at the current cursor position, and render both user/AI replies with
  Markdown formatting in the work-item conversation view.
- The work-item graph keeps zero or more `derived_from` parent work items, and
  the Manager UI surfaces those relations directly instead of relying on
  topic-like folders as the primary mental model.
- When AI refers to another work item, the Manager UI rewrites internal IDs
  into that work item's visible title so the screen never expects the human to
  know backend IDs.
- ANSI-colored CLI output inside Manager replies is rendered as styled text, so
  git diffs and other terminal-colored snippets stay readable instead of
  exposing raw escape sequences.
- The composer keeps the draft simple: image placement stays inline in the text
  box and attachment chips, without adding a second rendered preview card above
  the send button.
- Pressing `Send` now moves the just-sent draft into a separate sending/recent
  lane immediately, so the composer itself clears at once and is ready for the
  next draft instead of mixing in-flight content with new edits.
- Sending from the global dock does not forcibly jump the reading focus to the
  newly routed work item; the current task stays open unless the user
  explicitly opens a routing-result chip.
- The inbox is ordered by urgency: routing confirmation, user reply needed, AI
  finished awaiting user confirmation, queued, AI working, then done.
- Inside the queued bucket, the default is still arrival order, but explicit
  priority requests jump ahead of ordinary work, question-only items jump ahead
  of ordinary work after that, and ties inside each lane stay FIFO.
- The built-in queue also enforces a fairness cap so older ordinary work is
  periodically drained instead of being starved forever by repeated priority or
  question follow-ups.
- `AI working` is reserved for tasks that are genuinely in flight in the
  built-in execution queue; only genuinely ready results should move into the
  user's confirmation bucket.
- Tasks are only marked done explicitly; the AI may move them into
  confirmation/reply-needed states but does not auto-close them silently.
- The built-in manager backend runs on Codex CLI (`gpt-5.4` with
  `model_reasoning_effort="xhigh"`).
- Manager messages are serialized: one queued message is processed at a time,
  and messages received during an in-flight turn continue automatically with
  the same priority-aware ordering.
- Manager continuity is persisted in two layers:
  - one routing-thread Codex session for global inbox triage
  - one worker Codex session per work item for actual task execution across turns
    and server restarts
- Thread storage remains compatible with `thread-inbox` data files, but the
  higher-level Manager work-item graph now belongs to `workspace-agent-hub`.
- The CLI now exposes `workspace-agent-hub work-items --json` so automation and
  humans can inspect the same work-item graph that drives the Manager UI.

#### Manager browser auth state matrix

The Manager page carries the same browser-local access-code behavior as the Hub
page. The claimed primary states are:

| State               | localStorage token   | URL hash `#accessCode=` | Auth source                       | Manager result                                               |
| ------------------- | -------------------- | ----------------------- | --------------------------------- | ------------------------------------------------------------ |
| **Fresh**           | absent               | absent                  | none                              | Auth panel is shown before any inbox/task fetch              |
| **Fresh**           | absent               | present                 | URL hash → stored to localStorage | Manager opens immediately and boots with the new token       |
| **Resumed**         | present and valid    | absent                  | localStorage                      | Manager opens directly without showing the auth panel        |
| **Stale (no hash)** | present but rejected | absent                  | localStorage (rejected)           | Stored token is cleared and the auth panel reopens           |
| **Stale + hash**    | present (old)        | present (new)           | URL hash overrides localStorage   | New token replaces the old one and Manager opens immediately |

Automated tests in `src/__tests__/manager-app-dom.test.ts` cover these five
rows.

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

| Path | Claimed behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                | Automated evidence                                                                                                                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `P1` | PC-side launcher flow can create a session, surface it in the inventory, and resolve it again for reopening.                                                                                                                                                                                                                                                                                                                                                    | `scripts/test-primary-path-matrix.ps1`                                                                                             |
| `P2` | A session started from the PC side can be reopened from the mobile SSH menu.                                                                                                                                                                                                                                                                                                                                                                                    | `scripts/test-mobile-ssh.py`                                                                                                       |
| `P3` | A session started from the mobile SSH menu becomes visible and reopenable from the PC-side launcher flow.                                                                                                                                                                                                                                                                                                                                                       | `scripts/test-mobile-ssh.py`                                                                                                       |
| `P4` | When multiple sessions exist, the user can distinguish and reopen the intended one by title/folder.                                                                                                                                                                                                                                                                                                                                                             | `scripts/test-primary-path-matrix.ps1` and `scripts/test-mobile-ssh.py`                                                            |
| `P5` | The browser UI can authenticate, list sessions, start a session, restore the remembered last session plus saved prompt drafts, mark sessions with unseen output, display transcript output, search/prioritize browser-local favorite sessions, surface install/offline/notification guidance, expose Tailscale-aware secure-launch hints, render QR/copyable smartphone pairing links, locally lock the current browser, and manage archive/close/delete flows. | `e2e/web-ui.spec.ts`, `src/__tests__/web-ui.test.ts`, `src/__tests__/web-app-dom.test.ts`, `scripts/test-web-session-bridge.ps1`   |
| `P6` | `Open Manager` opens Hub's native `/manager/` page on the same authenticated origin, in the same browser tab, and that page can authenticate across fresh/resumed/stale browser states, read/write workspace threads, show active tasks, and start/use the built-in manager backend for both desktop and smartphone-oriented browser entry paths.                                                                                                               | `e2e/web-ui.spec.ts`, `src/__tests__/web-ui.test.ts`, `src/__tests__/web-app-dom.test.ts`, `src/__tests__/manager-app-dom.test.ts` |

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

Release the package and create the matching GitHub release:

```powershell
$version = '0.2.1'
npm version $version --no-git-tag-version
npm run verify
git push origin main
git tag v$version
git push origin v$version
gh release create v$version --repo metyatech/workspace-agent-hub --title v$version --notes "See CHANGELOG.md"
npm publish
```

Verify the published package resolves and runs:

```powershell
npm view @metyatech/workspace-agent-hub version
npm exec --yes --package @metyatech/workspace-agent-hub@latest workspace-agent-hub -- --version
```

## Links

- [CHANGELOG.md](CHANGELOG.md)
- [SECURITY.md](SECURITY.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [LICENSE](LICENSE)
