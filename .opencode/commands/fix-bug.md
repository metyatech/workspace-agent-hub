---
description: Run the repository bug-fix loop with regression-first verification
---

Use this repository bug-fix workflow:

1. Reproduce the failing behavior or deterministic failing condition first.
2. Add or strengthen the earliest reliable regression check that should have caught it.
3. Fix the root cause with the smallest viable change set.
4. Run the canonical verification command:

pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1

5. Summarize the cause, the prevention mechanism, and any residual risk.
