# Changelog

All notable changes to this repository will be documented in this file.

The format is based on Keep a Changelog, and this project adheres to Semantic Versioning.

## [Unreleased]

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

### Changed

- Replaced the remaining root-repo URL assumption in verification with the
  dedicated `workspace-agent-hub` GitHub target
- Expanded repository docs and verification scripts to treat the browser UI as a
  primary path alongside the existing PC/mobile terminal flows
- Improved the browser UI first-use flow so connection state, installability,
  and offline behavior are visible without leaving the page
- Reduced browser-side auth churn by pausing background API polling until an
  access code is present

## [0.1.0] - 2026-01-26

### Added

- Initial workspace-level AI agent session fabric release.
- Windows GUI launcher for starting and resuming WSL `tmux` sessions.
- Mobile SSH menu for cross-device session handoff and session lifecycle management.
- Automated verification for the primary PC/mobile handoff paths.
