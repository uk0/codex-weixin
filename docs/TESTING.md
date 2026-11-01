# Tests and release verification

## Deterministic local checks

```bash
npm ci --ignore-scripts
npm run check
npm run release:check
npm pack --ignore-scripts
npm cache add qrcode-terminal@0.12.0 ws@8.22.0
node test/npx-install-smoke.js
```

The default suite contains 93 tests. It uses temporary state and fake Codex
subprocesses, not your account, private daemon or model. Some tests bind localhost
ports. Package installation is forced offline after caching dependency metadata;
`ENOTCACHED` means the dependency cache must be populated first.

GitHub CI repeats these checks on macOS/Linux and Node 22/24. Passing CI proves
the tested local/package paths, not real-provider or Windows compatibility.

## HTTP simulations (optional Postman CLI)

The committed stand-ins model the public client protocol subset in
`docs/weixin.openapi.json` and `docs/weixin-cdn.openapi.json`. These are inferred
client-side contracts, not official server guarantees. Historical assumptions
and unknowns are retained in `postman/simulations/weixin/weixin.context.yaml`.

Start a local simulation with a compatible Postman CLI (`simulation run --help`):

```bash
postman simulation run postman/simulations/weixin/weixin.sim.yaml --port 4502 --no-history
```

In another terminal:

```bash
node test/message-style-simulation.js http://127.0.0.1:4502
node test/channel-simulation.js http://127.0.0.1:4502
```

These tests drive the real bridge and HTTP serialization against stand-ins:

- Markdown confirmation, approvals, help, errors, status/history/files and chunk limits;
- no resume before an explicit mock-only confirmation; no automatic approval;
- dynamic file tool → encrypted CDN upload → file message → acceptance receipt;
- HTTP 500 before acceptance → stable upload metadata and one accepted mock attachment.

The channel test's optional `--live-model` mode uses a real local shared Codex
backend and may incur model usage. It is **not** part of default CI or needed for
the checks above; only use it deliberately in your own environment.

Generated artifacts are gitignored. Do not upload raw HTTP logs: even if a tool
redacts common headers, payloads can still contain sensitive material.

## What still needs a real environment

- Your Codex version, authentication and installed tools/plugins.
- Your Weixin account's eligibility and continued service compatibility.
- Recipient-side Markdown rendering, copy affordances and actual attachment download.
- Ambiguous timeout-after-send behavior and provider-side idempotency guarantees.
- Full Windows support, private desktop/IDE attachment and GUI feature parity.

Do not infer these from green tests, a successful upload grant, a health check,
or a stored delivery counter. Keep model execution, API acceptance and recipient
verification distinct when reporting issues.

## Release procedure

Keep credentials and internal deployment reports outside the public checkout.
Review `git diff --cached`, run the checks above, inspect `npm pack --dry-run`,
and produce a SHA-256 manifest for the tarball. Publish the reviewed commit/tag
and the exact tested tarball to GitHub Releases; verify the downloaded artifact
and run an isolated `--no-login` installation before announcing it.

No workflow in this repository automatically publishes to npm or updates a
running bridge. A release does not migrate anyone's local state.
