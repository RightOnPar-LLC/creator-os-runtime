# creator-os-runtime

> **The engine room — grants, metering, and the MCP surface agents run on.**

[![CI](https://github.com/RightOnPar-LLC/creator-os-runtime/actions/workflows/test.yml/badge.svg)](https://github.com/RightOnPar-LLC/creator-os-runtime/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-teal.svg)](LICENSE)

The agent runtime behind [runtime.meshtool.ai](https://runtime.meshtool.ai).

## The idea

Agents shouldn't hold god-mode API keys. This runtime issues **grants** — budgeted,
capped, attenuating credentials an agent can spend but never overdraw. Every call is
metered to a ledger, every grant is verifiable and revocable, and agents talk to the
runtime over a standard **MCP surface**. It is the permission model the agent economy
is missing.

## What it does

- **Grants** — issue, verify, attenuate, and revoke scoped agent credentials
- **Ledger** — metered usage, budgets, escrow and settlement records
- **MCP surface** — memory, tools, and capability calls agents consume directly
- **Cockpit** — operator view of what's happening on the runtime
- **Workers** — deploy and supervise agent workers under grant control

## Quickstart

```bash
git clone https://github.com/RightOnPar-LLC/creator-os-runtime.git
cd creator-os-runtime
bun install
bun run dev
```

`GET /health` should return `ok:true`. See [PROVENANCE.md](PROVENANCE.md) for the
repo's history and [docs/specs](docs/specs) for design notes.

## Live

Production: [runtime.meshtool.ai](https://runtime.meshtool.ai)

## License

MIT — see [LICENSE](LICENSE).
