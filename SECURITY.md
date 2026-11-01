# Security and privacy

This bridge grants a trusted Weixin sender access to a local Codex workflow.
Only authorize accounts you control. Review Codex/MCP permissions separately.

- Never commit or upload account.json, config.json, state.json, control.json,
  QR codes, verification codes, environment files, private keys, or real chat logs.
- State defaults to a private directory outside the source checkout. Local filesystem
  permissions are defense in depth, not protection from other processes running as you.
- The default sandbox is read-only. Approvals are bounded and expire; there is no
  automatic global approval or unrestricted arbitrary RPC endpoint.
- Install pinned releases from this repository. Dependencies may still need access
  to the npm registry; a GitHub release is not a fully offline standalone executable.
- API acceptance of a file does not prove recipient download. A send timeout can
  be ambiguous. Check the recipient before requesting a repeat delivery.
- Do not publish personal deployment reports in Issues. Use synthetic examples and
  redact identifiers, paths, message content and credentials.

For a sensitive vulnerability, use GitHub's private **Report a vulnerability** feature
when available. Do not post exploit details or secrets in a public issue. If you
suspect exposed credentials, revoke them with the provider before sharing diagnostics.

The public 0.5.x line is a preview, with no security-support SLA or guarantee of
continued compatibility with third-party services. See README for platform limitations.
