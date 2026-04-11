# Workspace Agent Hub

Workspace Agent Hub is the Windows + WSL tmux session fabric for running and
resuming multiple AI agent CLI sessions across PC and smartphone. It now
includes a mobile-friendly browser UI/PWA for starting sessions, reopening
them, and sending follow-up prompts without dropping into raw terminal flows.

This repository is intentionally source-distributed only. Public npm publishing
is disabled for the project, and any older npm package versions should be
treated as historical and unsupported.

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
- `tmux`, `curl`, `xz-utils`, and Node.js 22+ installed inside that WSL distro
- Optional: Android emulator for the ConnectBot coverage path

## Install / setup

1. Install Node dependencies. This also configures the repository's git hooks
   automatically through the `prepare` script:

   ```powershell
   npm ci
   ```

2. If your local `core.hooksPath` was overridden earlier, repair it manually:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-hooks.ps1
   ```

3. Refresh agent rules for this repository:

   ```powershell
   compose-agentsmd
   ```

4. From inside WSL, install the distro-side dependencies that the mobile menu
   and repository-standard verification use:

   ```bash
   sudo apt-get update
   sudo apt-get install -y tmux curl xz-utils
   sudo ./scripts/install-wsl-node.sh
   ```

5. Install the WSL mobile-login hook from inside WSL:

   ```bash
   ./scripts/install-wsl-mobile-menu-hook.sh
   ```

6. Optionally install the always-on browser UI shortcuts:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-web-ui-shortcuts.ps1
   ```

   This installs a Startup shortcut that launches a small phone-ready watchdog
   after Windows sign-in. The watchdog keeps the same Hub and Manager reachable
   from a smartphone without using Remote Desktop while the PC stays on and the
   Windows user session remains signed in, and it recreates the web UI
   automatically if that background process exits. It now waits on the managed
   Hub PID so unexpected exits trigger an immediate restart instead of waiting
   for the next periodic health pass.

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

Keep the background instance smartphone-ready so the same Tailscale URL stays
available for phone access without reopening the PC UI:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ensure-web-ui-running.ps1 -PhoneReady
```

If the live runtime is launched from a detached checkout under the OS temporary
directory, pass the canonical workspace explicitly with `-WorkspaceRoot` (or set
`WORKSPACE_AGENT_HUB_WORKSPACE_ROOT`) so Hub keeps reading the real
`.threads.jsonl`, `.tasks.jsonl`, and Manager queue files instead of inferring a
temporary parent directory.

When it needs to replace an existing phone-ready instance, it now starts the
replacement in the background, waits for it to become healthy, and only then
stops the previous managed process. That keeps the stable Tailscale-facing Hub
URL available across the handoff instead of creating a stop-first gap.

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

With that background path, the normal smartphone assumption is now:

- the PC is on
- the phone is on the same Tailscale tailnet

The default phone-ready route no longer depends on reading a fresh QR code or
access code from the PC. Open the same Tailscale URL or home-screen shortcut on
the phone and Hub/Manager should load directly.

Use the direct wrapper if you still want to launch it manually once:

Start the local browser UI with an auto-generated access code:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-web-ui.ps1
```

Start it in the recommended smartphone-ready mode so the script configures
Tailscale Serve and emits an installable HTTPS tailnet URL. If automatic HTTPS
setup does not complete on this machine, it falls back to a Tailscale-direct
URL instead of hanging. In this mode the PowerShell wrapper now defaults to no
extra app-level access code, so a Tailscale-connected phone can open the same
tailnet URL directly. If Tailscale Serve has not been enabled on the tailnet yet,
the command now points you at the stable Tailscale DNS settings page and keeps
the direct tailnet URL available until you enable HTTPS Certificates there and
rerun the same command. If the HTTPS tailnet endpoint currently responds with
`HTTP 502`, Hub now keeps the default smartphone path on the verified
Tailscale-direct URL and shows HTTPS recovery guidance as a secondary step:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-web-ui.ps1 -PhoneReady
```

Tailscale prerequisite for cross-PC access:

- Install Tailscale on both PCs and sign in so both devices join the same
  tailnet. Using the same Tailscale account is the simplest setup, but it is
  not strictly required if both devices are already allowed onto the same
  tailnet.
- Keep Workspace Agent Hub running on the host PC. The other PC just opens the
  emitted tailnet URL in a browser and drives that same host-side process.

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
workspace-agent-hub web-ui --tailscale-serve --auth-token none --no-open-browser
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

| Parameter               | Description                                                                                                                                                                              | Example                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `-ListenHost <host>`    | PowerShell-safe equivalent of the CLI `--host` option.                                                                                                                                   | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-web-ui.ps1 -ListenHost 0.0.0.0`        |
| `-WorkspaceRoot <path>` | Explicit workspace root that contains `.threads.jsonl`, `.tasks.jsonl`, and Manager runtime files. Required when the package itself runs from a temporary/detached checkout.             | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-web-ui.ps1 -WorkspaceRoot D:\ghws`     |
| `-PhoneReady`           | PowerShell shortcut for `--tailscale-serve` plus the normal wrapper defaults. When no `-AuthToken` is given, this mode trusts the Tailscale path and disables the extra app access code. | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-web-ui.ps1 -PhoneReady -NoOpenBrowser` |
| `-JsonOutput`           | PowerShell wrapper switch for CLI `--json`.                                                                                                                                              | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-web-ui.ps1 -JsonOutput -NoOpenBrowser` |
| `-NoOpenBrowser`        | PowerShell wrapper switch for CLI `--no-open-browser`.                                                                                                                                   | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-web-ui.ps1 -NoOpenBrowser`             |

#### CLI parameters

`workspace-agent-hub web-ui` supports these parameters:

| Parameter                 | Description                                                                                                                                                       | Example                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `--host <host>`           | Host/IP to bind. Use `127.0.0.1` for local-only access or `0.0.0.0` when another device reaches the PC through Tailscale or another trusted network path.         | `workspace-agent-hub web-ui --host 0.0.0.0`                                |
| `--port <port>`           | Preferred port. If already taken, the server walks upward to the next free port.                                                                                  | `workspace-agent-hub web-ui --port 3360`                                   |
| `--workspace-root <path>` | Explicit workspace root that contains `.threads.jsonl`, `.tasks.jsonl`, and Manager queue/state files. Required when the package runs from a temporary checkout.  | `workspace-agent-hub web-ui --workspace-root D:\ghws`                      |
| `--public-url <url>`      | Phone-facing URL used for reconnect links and QR pairing. Point this at Tailscale Serve or another trusted HTTPS reverse proxy when using the PWA from a phone.   | `workspace-agent-hub web-ui --public-url https://agent-hub.example.ts.net` |
| `--tailscale-serve`       | Configure Tailscale Serve for this run and prefer the resulting HTTPS tailnet URL. Useful for the normal smartphone/PWA path when the PC is already on Tailscale. | `workspace-agent-hub web-ui --tailscale-serve`                             |
| `--auth-token <token>`    | Access code for API/browser auth. Use `auto` to generate one, or `none` when the Tailscale path itself is the trust boundary and you want direct phone access.    | `workspace-agent-hub web-ui --auth-token none`                             |
| `--json`                  | Print a single JSON object describing the live web UI endpoint, connect URL, access code, and pairing link.                                                       | `workspace-agent-hub web-ui --json --no-open-browser`                      |
| `--no-open-browser`       | Start the server without opening the default desktop browser.                                                                                                     | `workspace-agent-hub web-ui --no-open-browser`                             |

End-to-end example:

```powershell
workspace-agent-hub web-ui --host 0.0.0.0 --port 3360 --auth-token none --no-open-browser
```

First-use flow:

1. Start the web UI on the PC.
2. On the phone, open the emitted Tailscale URL directly. If HTTPS/Tailscale Serve is already active, add that page to the home screen once.
3. If the terminal or secure-launch card tells you to open the Tailscale DNS settings page, open it once on the PC, enable HTTPS Certificates there, and rerun the same `-PhoneReady` command to upgrade the path to HTTPS.
4. Only when you intentionally enabled an extra access code do you need the local PC page QR/link for the first handoff.
5. Start or reopen a session, then use the transcript and prompt box from the same page.
6. If needed, enable browser notifications or use the device-lock button to clear the saved browser-side state on that device.
7. Use the session search box, browser-local favorites, the remembered last-session card, and saved prompt drafts to jump back into the same work quickly on that device.

#### Browser/mobile handoff state matrix

The default `-PhoneReady` / background Tailscale path now uses `--auth-token none`,
so there is no app-level access-code handoff at all. The matrix below applies
only when you intentionally keep the extra access-code layer enabled.

In that protected mode, the browser app carries auth state in `localStorage`.
The claimed primary paths and their token-source precedence rules are:

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
- When `--public-url` is provided, the browser app uses that URL as the primary
  smartphone entry path. QR and share actions stay available only as optional
  first-time handoff helpers.
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

The broader target architecture for the Manager-as-orchestrator model is
documented in
[docs/manager-orchestrator-architecture.md](docs/manager-orchestrator-architecture.md).

The detailed next-phase operator flow for manager-decided repo targeting, isolated
worktree runs, repo merge lanes, and multi-agent worker adapters is documented
in [docs/manager-multi-agent-workflow.md](docs/manager-multi-agent-workflow.md).

How it works:

1. Open the normal Hub page from the PC or smartphone.
2. Use `Manager を開く`.
3. The browser moves into Hub's native `/manager/` page on the same origin and in the same tab.
4. The Manager page reads and writes the workspace `.threads.jsonl` and
   `.tasks.jsonl` files directly through Hub's own API.
5. The user sends requests and follow-ups from the normal bottom composer.
   Manager decides internally whether the message belongs on an existing work
   item, should become a new work item, or needs clarification before it can
   route further.
6. The writing surface stays collapsed on the inbox, then turns into a compact
   bottom reply bar while a work-item conversation screen is open.
7. The built-in manager backend splits each message across existing tasks,
   new tasks, or routing-confirmation items, then either answers the routed
   work item directly or dispatches it to a worker agent. Worker-agent items
   can run in parallel when their declared write scopes do not overlap, and
   each completed worker result goes back through a manager review turn before
   the final user-facing update and any delivery actions.
8. The built-in manager backend starts inside Hub when needed and keeps
   handling inbox messages for that workspace.

Important behavior:

- When Hub is running with an access code, the same protection also covers the
  smartphone/desktop Manager path. On the default phone-ready Tailscale route,
  Manager opens directly from the same trusted Hub origin.
- There is no separate `manager-gui` process or second GUI server anymore.
- Existing workspace repos are discovered internally by Manager. The human does
  not register repo paths or repo settings in the GUI; Manager decides whether
  a task belongs on one discovered repo or on a brand-new repo under the
  workspace root.
- Existing-repo write work must target one concrete repo. When a routed worker
  task would mutate an existing repo but does not identify which repo, Manager
  asks for clarification instead of falling back to the workspace root.
- New repos are first-class targets. When the request clearly implies a new
  repo instead of an existing one, Manager can choose that path internally and
  create it directly under the workspace root.
- `Open Manager` is now a direct navigation path to Hub's own Manager page.
- Users send from one global dock; they do not need to create or pick a task
  before sending, and the larger text area only opens when they choose to
  write.
- When Manager splits a freeform message into tasks, the default granularity is
  one user goal per work item, but clear follow-ups, status checks, and direct
  answers for an existing work item stay in that same work item instead of
  being split out automatically. Recently resolved work items also remain valid
  routing targets when the user naturally returns to that earlier topic.
- The Manager page now surfaces a prominent live status summary so it is easy
  to tell whether AI is actively processing, idle, or waiting on the user, and
  how many tasks currently sit in each urgency bucket.
- Empty Manager sections now start collapsed automatically and reopen
  themselves when matching work items arrive, so buckets with nothing in them
  stop taking space while still surfacing new arrivals immediately.
- Each Manager list now has its own `新しい順 / 古い順` toggle. The three
  human-review buckets default to oldest-first so older waiting items surface
  first, while AI-only buckets default to newest-first. In `AI の順番待ち`,
  that toggle changes only the visible display order; the actual dispatch queue
  still follows the backend priority/FIFO rules.
- Opening a work item now moves into a dedicated conversation screen with the
  message history in chat order and the newest message at the bottom, scrolls
  that conversation to the latest message when the work item opens, and lets the
  browser back button return to the Manager list before leaving Hub. That
  conversation screen keeps the input area as a compact bottom bar instead of
  reusing the larger inbox composer chrome.
- The current built-in Manager keeps one continuing primary routing session
  across global sends so references like earlier XX / yesterday YY can be
  interpreted with conversation continuity while still grounding every send in
  the latest recent-topic list, then executes each actionable task with its
  own persisted worker continuation. Worker runtime/model choice is resolved
  per task from live third-party Scale leaderboards plus `ai-quota`, so the
  backend prefers the highest-ranked currently-available Codex/Claude worker
  instead of pinning every task to one static worker model.
- Manager-owned git worktrees are created next to the target repository instead
  of under the OS temp directory. That preserves the repository's original
  parent-directory topology, so local overlays such as `.env*.local` keep the
  same relative-path semantics without content rewriting heuristics. The
  Manager does not graft `node_modules` or other repository directories into
  those worktrees, and after bootstrap it quarantines non-Git
  symlinks/junctions that resolve outside the worktree: tracked links fail
  fast, while untracked links are materialized into ordinary files/directories.
- Static worker env settings such as `WORKSPACE_AGENT_HUB_CODEX_MODEL`,
  `WORKSPACE_AGENT_HUB_CODEX_EFFORT`,
  `WORKSPACE_AGENT_HUB_CLAUDE_MODEL`, and
  `WORKSPACE_AGENT_HUB_CLAUDE_EFFORT` are not the normal automatic routing
  source of truth. They are only used when you explicitly force that runtime.
- Automatic worker routing uses three live task classes:
  `codebase-qna` -> SWE Atlas QnA, `test-writing` -> SWE Atlas Test Writing,
  `implementation` -> SWE-Bench Pro public/private. The backend walks the
  live-ranked candidates from the top, checks the corresponding runtime with
  `ai-quota`, and launches the first candidate whose runtime still has enough
  quota headroom. If live ranking or `ai-quota` cannot produce an eligible
  worker, Manager stops and surfaces a `needs-reply` error instead of silently
  bypassing that gate with a static fallback.
- A repo-level `preferredWorkerRuntime` is treated only as a runtime
  constraint. It limits which worker runtime family can be auto-selected, but
  it does not pin a specific model. Inside that runtime constraint, the actual
  model/effort still comes from live ranking.
- The global send dock now shows an explicit send target. From the inbox it
  can hint a selected work item while still using normal routing, and from an
  open work-item conversation it sends straight back into that same work item
  unless the user explicitly switches to `別件`.
- Manager work-item messages now preserve multiline user text, support inline image
  insertion inside the message body via a mobile-friendly image picker plus
  desktop drag-and-drop or Ctrl/Cmd+V clipboard paste at the current cursor
  position, and render both user/AI replies with Markdown formatting in the
  work-item conversation view.
- The work-item graph keeps zero or more `derived_from` parent work items, and
  the Manager UI surfaces those relations directly instead of relying on
  topic-like folders as the primary mental model.
- Parent/child work-item links now show unfinished vs done counts directly on
  the source work item and inside the conversation screen, so the human can see
  which derived requests are still open without mentally reconstructing one
  long mixed conversation.
- When AI refers to another work item, the Manager UI rewrites internal IDs
  into that work item's visible title so the screen never expects the human to
  know backend IDs.
- ANSI-colored CLI output inside Manager replies is rendered as styled text, so
  git diffs and other terminal-colored snippets stay readable instead of
  exposing raw escape sequences.
- The composer keeps the draft simple: image placement stays inline in the text
  box and attachment chips, without adding a second rendered preview card above
  the send button.
- Pressing `Send` now moves the just-sent draft into a separate send-status
  lane above the work area immediately, so the composer itself clears at once
  and is ready for the next draft instead of mixing in-flight content with new
  edits. That lane stays collapsed to a one-line summary by default, persists
  across reloads in browser-local state, and lets the user delete individual
  items or clear the whole strip when it is no longer useful.
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
- The built-in manager backend uses Codex CLI (`gpt-5.4` with
  `model_reasoning_effort="xhigh"`) as the primary manager runtime. When
  Manager Codex hits a usage limit, Hub surfaces a paused state, leaves queued
  work pending, and resumes when the user clicks `再開する` in the Manager GUI
  or starts Manager again after topping up quota.
- The native Manager page now updates over a pushed live snapshot stream instead
  of periodic client polling, and the bottom of the open work-item
  conversation now shows a growing live worker log while a result is still
  running.
- When a phone or browser returns from screen lock, backgrounding, or a
  persisted page restore, the Manager now always forces one fresh authoritative
  state fetch and then reopens the live snapshot stream so `送信中…`-style
  states do not stay stale, even if another lifecycle refresh fired shortly
  before the page went hidden.
- For stale-state investigations, the Manager page exposes
  `window.__workspaceAgentHubManagerDiagnostics()` in the browser console so a
  report can include recent visibility/live-stream events plus the last
  received live payload timing.
- The Hub session browser now uses the same live snapshot model (`/api/live`)
  as its primary update path for session list ordering and selected-session
  transcript output, driven by authoritative session-catalog/session-live file
  changes from the bridge path instead of browser polling or a server-side
  reconciliation interval.
- The built-in Manager now behaves as an orchestrator: each queued work item is
  assigned either to the Manager itself or to a worker agent, manager-direct
  answers use a separate lane from worker execution, and worker agents can run
  in parallel when their declared write scopes do not overlap.
- Worker turns now stop at implementation and verification. After a worker
  finishes, the Manager itself reviews that result inside the repository and,
  when the result is acceptable, owns the in-scope commit/push chain plus
  release/publish follow-through when that repository normally requires it for
  completion. Review-ready completion is now blocked until `push` succeeds, and
  user-owned publishable npm repositories must also clear the post-merge
  release/publish verification chain before the task is surfaced as complete.
- If a worker cannot start because another running work item owns an
  overlapping write scope, the work item stays visible with an explicit
  scope-blocked runtime reason until that conflict clears.
- If the Manager decides a newer descendant work item fully supersedes an older
  running descendant, the older work item is stopped and shown as
  `cancelled-as-superseded` instead of silently disappearing.
- Manager continuity is persisted in two layers:
  - one workspace-level primary routing session for global inbox triage across sends
  - one worker Codex session per work item for actual task execution across
    turns and server restarts
- Thread storage remains compatible with `thread-inbox` data files, but the
  higher-level Manager work-item graph now belongs to `workspace-agent-hub`.
- The CLI now exposes `workspace-agent-hub work-items --json` so automation and
  humans can inspect the same work-item graph that drives the Manager UI.

#### Manager browser auth state matrix

The default phone-ready Tailscale route opens Manager directly without an
app-level access code. The matrix below applies only when you intentionally run
Hub in the protected access-code mode; in that case, the Manager page carries
the same browser-local access-code behavior as the Hub page.

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

Repository-standard verify:

```powershell
npm run verify
```

`npm run verify` is the same verification entrypoint used by CI. It runs
formatting, lint/typecheck, the full test suite, the build, and the launcher
smoke test. The repository pre-commit hook runs that same entrypoint, then
refreshes the generated instruction files with `compose-agentsmd --compose`
and stages them. CI provisions a fresh Ubuntu WSL distro with the same tmux +
Node prerequisites before invoking that entrypoint.

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

Build and regenerate agent rules:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build.ps1
```

## Primary path matrix

This repository claims the following primary handoff paths.

| Path | Claimed behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Automated evidence                                                                                                                 |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `P1` | PC-side launcher flow can create a session, surface it in the inventory, and resolve it again for reopening.                                                                                                                                                                                                                                                                                                                                                                                                                                          | `scripts/test-primary-path-matrix.ps1`                                                                                             |
| `P2` | A session started from the PC side can be reopened from the mobile SSH menu.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `scripts/test-mobile-ssh.py`                                                                                                       |
| `P3` | A session started from the mobile SSH menu becomes visible and reopenable from the PC-side launcher flow.                                                                                                                                                                                                                                                                                                                                                                                                                                             | `scripts/test-mobile-ssh.py`                                                                                                       |
| `P4` | When multiple sessions exist, the user can distinguish and reopen the intended one by title/folder.                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `scripts/test-primary-path-matrix.ps1` and `scripts/test-mobile-ssh.py`                                                            |
| `P5` | The browser UI can authenticate, list sessions, start a session, restore the remembered last session plus saved prompt drafts, mark sessions with unseen output, display transcript output, keep Hub session/transcript updates flowing over the Hub `/api/live` snapshot stream, search/prioritize browser-local favorite sessions, surface install/offline/notification guidance, expose Tailscale-aware secure-launch hints, render QR/copyable smartphone pairing links, locally lock the current browser, and manage archive/close/delete flows. | `e2e/web-ui.spec.ts`, `src/__tests__/web-ui.test.ts`, `src/__tests__/web-app-dom.test.ts`, `scripts/test-web-session-bridge.ps1`   |
| `P6` | `Open Manager` opens Hub's native `/manager/` page on the same authenticated origin, in the same browser tab, and that page can authenticate across fresh/resumed/stale browser states, read/write workspace threads, show active tasks, and start/use the built-in manager backend for both desktop and smartphone-oriented browser entry paths.                                                                                                                                                                                                     | `e2e/web-ui.spec.ts`, `src/__tests__/web-ui.test.ts`, `src/__tests__/web-app-dom.test.ts`, `src/__tests__/manager-app-dom.test.ts` |

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
- `WORKSPACE_AGENT_HUB_WORKSPACE_ROOT`
  Optional explicit workspace root override for detached/temp runtime checkouts.
  Use this when the package root is not the canonical repository parent and you
  still want Hub/Manager to read the real workspace state.
- `AI_AGENT_SESSION_NO_ATTACH=1`
  Keeps the mobile menu tests from attaching the current shell to the created
  session.
- `AI_AGENT_MOBILE_BYPASS=1`
  Prevents the login bootstrap from opening the mobile menu automatically.

## Distribution status

Workspace Agent Hub is maintained from source in this repository. Public npm
publishing is intentionally disabled, so do not run `npm publish` for this
project.

If an older `@metyatech/workspace-agent-hub` package version is still visible
in the npm registry, treat it as a historical artifact rather than a supported
distribution channel.

## Links

- [CHANGELOG.md](CHANGELOG.md)
- [SECURITY.md](SECURITY.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [LICENSE](LICENSE)
