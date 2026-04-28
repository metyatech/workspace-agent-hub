---
description: Run the canonical repository verification command and summarize the result
---

Run this repository's canonical verification command and use the actual output as evidence:

pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1

Report whether verification passed, which checks ran, and any follow-up needed.
Do not claim success without command output.
