# Vendored A2A schema authority

**Pinned version: A2A `v1.0.1`** — the latest official release of the Agent2Agent
protocol (`github.com/a2aproject/A2A`, Linux Foundation), fetched 2026-09-27.

`a2a.v1.0.1.proto` is the repo's `specification/a2a.proto` at tag `v1.0.1`,
byte-for-byte. It is the **single source of truth** for the AgentCard shape our
`/.well-known/agent.json` serves.

## Why the proto and not a JSON schema

The A2A nouns are defined in Protocol Buffers and the JSON Schema is *generated
from the proto* (`scripts/proto_to_json_schema.sh`); as of v1.0.x the repo does
**not commit** a `specification/json/a2a.json` (it did at v0.3.0 and earlier).
So the proto is the authoritative artifact to pin. `src/a2a.js`'s
`validateAgentCard()` encodes this proto's AgentCard contract (required fields,
types, proto3→JSON lowerCamelCase field names) — it is derived from this pinned
file, not from memory. A follow-up may run the repo's generator to emit the JSON
Schema and validate with ajv; Phase 1 validates against the proto contract.

## Version note (read this)

The build spec asked to pin **"A2A v1.2 (March 2026)"**. That version does not
exist: the authoritative repo's latest release is **v1.0.1**, and its own spec
page states "Latest Released Version 1.0.0". We pinned **v1.0.1** and target its
contract. If a v1.2 later ships, re-fetch the proto, bump `A2A_VERSION` in
`src/a2a.js`, and re-run the selftests.

## AgentCard contract at v1.0.1 (proto3 → JSON, lowerCamelCase)

Required: `name`, `description`, `supportedInterfaces[]`, `version`,
`capabilities`, `defaultInputModes[]`, `defaultOutputModes[]`, `skills[]`.
Optional: `provider`, `documentationUrl`, `securitySchemes`,
`securityRequirements[]`, `signatures[]`, `iconUrl`.
There is **no** top-level `id` or `url` at v1.0.x — transport lives in
`supportedInterfaces[]` (`url`, `protocolBinding`, `protocolVersion`, `tenant?`).
`skills[]` require `id`, `name`, `description`, `tags[]`.
