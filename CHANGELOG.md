# Changelog

## 0.5.1 — Initial public preview

- Independent Weixin ↔ Codex App Server bridge; no OpenClaw runtime dependency.
- Model-directed text/file delivery, bounded project/session inventory and explicit session selection.
- Markdown control notices, separate command blocks, remaining approval time and resumable long results.
- Owner-bound confirmations/approvals, default read-only execution and workspace-bound file snapshots.
- Persistent runtime installation outside the npx cache; state is never included in the distribution.
- Public source contains deterministic tests, HTTP simulations, CI and sanitized documentation.

This is the first GitHub distribution. Production JavaScript matches the locally
validated 0.5.1 implementation; public packaging and documentation are separated
from local deployment history. See docs/TESTING.md for verification boundaries.
