# gate/ — creator-os mcp-gate

`index.ts` is the source of **mcp-gate**: a small Bun + Hono service that puts an OAuth 2.1 + PKCE sign-in in front of the runtime's `/mcp` endpoint, so Claude (web, desktop, Code) can connect as a custom connector using a limited runtime grant the owner mints in the cockpit. It holds no secrets; the access token it hands out *is* the limited grant, and it only passes grants whose caps are within `memory.read`, `memory.write`, `cog.plan`, `tenant.read`.

## Where it runs

| | |
|---|---|
| Railway project | `creator-os-runtime` (`5ca34256-0fae-44e4-a27b-f7700b20f7e2`) |
| Service | `mcp-gate` (`bda0e984-3728-4a9c-a5ad-765af33eab0a`) |
| Environment | `production` |
| Public URL | https://mcp-gate-production.up.railway.app |
| Health | `GET /health` (reports the running source's sha256 and byte length) |
| Config vars (names only) | `PUBLIC_URL`, `RUNTIME_URL` (optional: `COCKPIT_URL`, `VERIFY_TTL_MS`, `PORT`) |

## How it is deployed today

By hand, as a Railway **Function**: the service uses the image `ghcr.io/railwayapp/function-bun:1.4.0`, and the whole of `index.ts` is pasted into the service's start command as base64 (`./run.sh <base64>`). Nothing in this repo is wired to that service yet — changing this folder does **not** redeploy the gate, and the runtime service (root `index.ts`) does not load anything from `gate/`.

## Provenance

Copied byte-for-byte from the live start command (decoded, not edited).

- sha256: `f701aefd58338c91de7e64e2d8d2e242d88829d7e3ab0d7b66eb557f9899f223`
- bytes: 15496

This matches what the running gate reports at `/health` → `source.sha256`. To check:

```sh
sha256sum gate/index.ts
curl -s https://mcp-gate-production.up.railway.app/health | jq .source
```

## Future

Deploy from this folder (point the mcp-gate service at this repo with root directory `gate/`, or regenerate the Function from this file) so git is the source of truth instead of a pasted blob. Until then, any edit to the live gate should be copied back here with its new sha256.
