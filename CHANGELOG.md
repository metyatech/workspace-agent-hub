# Changelog

All notable changes to this repository will be documented in this file.

The format is based on Keep a Changelog, and this project adheres to Semantic Versioning.

## [Unreleased]

### Added

- Added browser-DOM regression coverage for the native Manager page's
  fresh/resumed/stale access-code states
- Added Playwright coverage for opening Manager from Hub on both desktop and
  mobile-width browser paths

### Changed

- Retired the old `AI Agent Sessions` shortcut as a normal user-facing
  entrypoint and made the browser Hub shortcut installer remove any leftover
  legacy shortcut from Windows
- Expanded the README Manager verification notes so `workspace-agent-hub` is
  documented as the sole Manager UI with an explicit browser auth state matrix
- Changed `Open Manager` to reuse the current browser origin and move into the
  native `/manager/` page in the same tab instead of relying on a separate tab
- Changed Manager topic details to expand inline in the selected row instead
  of jumping to a separate bottom detail panel
- Hardened the smartphone/Tailscale onboarding path so a detected HTTPS
  tailnet `HTTP 502` now keeps QR/default pairing on the verified direct
  tailnet URL and surfaces deterministic HTTPS recovery guidance
- Switched the built-in Manager backend runtime from Claude CLI to Codex CLI
  (`gpt-5.4` + `model_reasoning_effort="xhigh"`), while preserving serialized
  queue processing and persisted cross-turn continuity via Codex thread resume

## [0.2.1] - 2026-03-16

### Changed

- Reissued the native Manager release with an explicitly pushed Git tag so the latest Hub release chain is aligned end-to-end
- Updated the bundled `@metyatech/thread-inbox` dependency to the clean post-`manager-gui` line

## [0.2.0] - 2026-03-16

### Added

- Added standalone repository documentation and local AGENTS composition for
  `workspace-agent-hub`
- Added a mobile-friendly browser UI/PWA for starting, reopening, and managing
  workspace agent sessions from desktop or smartphone
- Added a PowerShell/WSL bridge for browser-driven transcript reading and input
  sending
- Added browser-focused verification for the web UI server, DOM behavior, and
  session bridge path
- Added real-browser Playwright coverage for the browser UI primary path,
  including auth, start, transcript send, archive, close, and delete flows
- Added browser-side install guidance, offline state messaging, and cached
  session/transcript fallback for the PWA flow
- Added browser notification opt-in and a local device-lock control for the PWA
  browser session
- Added QR-based smartphone pairing, share/copy reconnect actions, and
  `public-url` aware onboarding for the browser UI
- Added `--json` launch metadata output for `workspace-agent-hub web-ui`
  automation/integration flows
- Added browser-local session search and favorites to keep the mobile session
  list easier to reopen
- Added browser-local last-session recall, per-session prompt draft persistence,
  and unseen-output badges for faster smartphone resume flows
- Added Tailscale-aware launch metadata, browser secure-launch hints, and an
  explicit `--tailscale-serve` / `-PhoneReady` path for smartphone-ready HTTPS
  PWA access
- Added a native Manager page under `/manager/`, including the inbox UI,
  thread/task view, and built-in manager backend integration

### Changed

- Replaced the remaining root-repo URL assumption in verification with the
  dedicated `workspace-agent-hub` GitHub target
- Expanded repository docs and verification scripts to treat the browser UI as a
  primary path alongside the existing PC/mobile terminal flows
- Improved the browser UI first-use flow so connection state, installability,
  and offline behavior are visible without leaving the page
- Reduced browser-side auth churn by pausing background API polling until an
  access code is present
- Renamed the PowerShell wrapper bind parameter to `-ListenHost` so
  `scripts/start-web-ui.ps1 -PhoneReady` no longer collides with PowerShell's
  read-only `$Host` automatic variable, and added wrapper-start regression
  coverage
- Made `-PhoneReady` fall back when automatic Tailscale Serve setup stalls, so
  startup still prints connect details and keeps a tailnet-direct URL available
- Shifted smartphone onboarding to a QR-first flow so the opened PC page can
  show the scannable pairing QR immediately, while copy/share links remain
  fallback-only paths
- When Tailscale Serve is not yet enabled on the tailnet, the launcher now
  points to the stable Tailscale DNS settings page in both the startup output
  and the browser UI instead of relying on a node-specific approval URL that
  may fail after sign-in
- `Open Manager` now opens Hub's native Manager page instead of reusing a
  separate `thread-inbox manager-gui` process

## [0.1.0] - 2026-01-26

### Added

- Initial workspace-level AI agent session fabric release.
- Windows GUI launcher for starting and resuming WSL `tmux` sessions.
- Mobile SSH menu for cross-device session handoff and session lifecycle management.
- Automated verification for the primary PC/mobile handoff paths.
