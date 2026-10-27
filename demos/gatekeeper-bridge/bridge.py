#!/usr/bin/env python3
"""
Gatekeeper Bridge
=================
Wires the character-builder demo's ceremonies (soulmate minting, soul granting,
soul/memory writing) to the real Meshtool runtime at https://runtime.meshtool.ai.

The demo page calls the endpoints below. Raw grant tokens NEVER leave this
server — they are stored in-memory per session and only grant/tenant/memory
IDs go back to the client.

RUNTIME_ADMIN_KEY comes from the environment. It is never logged, printed,
or returned. Every upstream call logs method + path + status only.
"""

import json
import logging
import os
import secrets
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

import requests

ALLOWED_RUNTIMES = {
    "practice": "https://creator-os-runtime-sandbox-production.up.railway.app",
    "real": "https://runtime.meshtool.ai",
}
DEFAULT_MODE = "practice" if os.environ.get("SHOP_MODE", "practice") == "practice" else "real"
RUNTIME_BASE = ALLOWED_RUNTIMES[DEFAULT_MODE]
ADMIN_KEY = os.environ.get("RUNTIME_ADMIN_KEY", "")
PORT = int(os.environ.get("PORT", "8789"))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("gatekeeper-bridge")

# session_id -> {
#   "tenant_id": "t_...",
#   "soulmate_token": "cog1....",      # NEVER returned to the client
#   "soulmate_grant_id": "gr_...",
#   "apps": {grant_id: {"token": ..., "character_name": ..., "app_name": ...}},
# }
sessions = {}


class BridgeError(Exception):
    """Expected failure — surfaced to the client as {"ok": false, "error": ...}."""


def _get(obj, *keys):
    """Walk a nested dict; raise BridgeError on any missing key (fail loud)."""
    cur = obj
    for key in keys:
        if not isinstance(cur, dict) or key not in cur:
            raise BridgeError("upstream response missing key: %s" % key)
        cur = cur[key]
    return cur


def upstream(method, path, bearer=None, payload=None):
    """Call the runtime. Logs method + path + status only — never bodies/tokens."""
    url = RUNTIME_BASE + path
    headers = {}
    if bearer:
        headers["Authorization"] = "Bearer " + bearer
    try:
        resp = requests.request(method, url, headers=headers, json=payload, timeout=20)
    except requests.RequestException:
        log.error("UPSTREAM %s %s -> transport error", method, path)
        raise BridgeError("upstream transport error: %s %s" % (method, path))
    log.info("UPSTREAM %s %s -> %s", method, path, resp.status_code)
    if resp.status_code >= 400:
        raise BridgeError("upstream %s %s failed with status %s" % (method, path, resp.status_code))
    try:
        return resp.json()
    except ValueError:
        raise BridgeError("upstream %s %s returned non-JSON" % (method, path))


def _require_str(body, name):
    value = body.get(name)
    if not value or not isinstance(value, str):
        raise BridgeError("missing required field: %s" % name)
    return value


def shop_status():
    """GET /shop — show which runtime this practice bridge is using."""
    return {
        "ok": True,
        "mode": "practice" if RUNTIME_BASE == ALLOWED_RUNTIMES["practice"] else "real",
        "runtime": RUNTIME_BASE,
        "parts": sorted(ALLOWED_RUNTIMES),
    }


def onboard(body):
    """POST /onboard — create tenant + mint the soulmate's root grant."""
    handle = _require_str(body, "handle")
    soulmate_name = _require_str(body, "soulmate_name")

    tenant = upstream(
        "POST", "/api/tenants", bearer=ADMIN_KEY,
        payload={"name": handle, "handle": handle},
    )
    tenant_id = _get(tenant, "tenant", "id")

    # NOTE: verified quirk — the runtime overrides requested caps/budget with
    # generous defaults. We still pass tight values so the intent is on record.
    grant = upstream(
        "POST", "/api/tenants/%s/root-grant" % tenant_id, bearer=ADMIN_KEY,
        payload={
            "sub": "agent:" + soulmate_name,
            "caps": ["grant.issue", "memory.read", "memory.write"],
            "budget": {"calls": 50, "deploys": 0, "usd_cents": 0},
        },
    )

    session_id = secrets.token_urlsafe(32)
    sessions[session_id] = {
        "tenant_id": tenant_id,
        "soulmate_token": _get(grant, "token"),
        "soulmate_grant_id": _get(grant, "id"),
        "apps": {},
    }
    return {
        "session_id": session_id,
        "tenant_id": tenant_id,
        "soulmate_grant_id": _get(grant, "id"),
    }


def grant_soul(body):
    """POST /grant-soul — the soulmate granting ceremony: issue a sub-grant."""
    session_id = _require_str(body, "session_id")
    app_name = _require_str(body, "app_name")
    character_name = _require_str(body, "character_name")

    sess = sessions.get(session_id)
    if not sess:
        raise BridgeError("unknown or expired session")

    grant = upstream(
        "POST", "/api/grants", bearer=sess["soulmate_token"],
        payload={
            "sub": "agent:" + character_name,
            "caps": ["memory.read", "memory.write"],
            "budget": {"calls": 100, "deploys": 0, "usd_cents": 0},
        },
    )
    grant_id = _get(grant, "id")
    sess["apps"][grant_id] = {
        "token": _get(grant, "token"),
        "character_name": character_name,
        "app_name": app_name,
    }
    return {"grant_id": grant_id}


def soul_write(body):
    """POST /soul/write — persist the character's SOUL.md and MEMORY.md."""
    session_id = _require_str(body, "session_id")
    grant_id = _require_str(body, "grant_id")
    soul_md = body.get("soul_md")
    memory_md = body.get("memory_md")
    if not isinstance(soul_md, str) or not isinstance(memory_md, str):
        raise BridgeError("soul_md and memory_md must be strings")

    sess = sessions.get(session_id)
    if not sess:
        raise BridgeError("unknown or expired session")
    app = sess["apps"].get(grant_id)
    if not app:
        raise BridgeError("unknown grant_id for this session")
    token = app["token"]

    m1 = upstream(
        "POST", "/api/memory", bearer=token,
        payload={"content": soul_md, "kind": "soul"},
    )
    m2 = upstream(
        "POST", "/api/memory", bearer=token,
        payload={"content": memory_md, "kind": "memory"},
    )
    return {"memory_ids": [_get(m1, "memory", "id"), _get(m2, "memory", "id")]}


def session_end(body):
    """POST /session/end — wipe server-side tokens for the session."""
    session_id = _require_str(body, "session_id")
    sessions.pop(session_id, None)
    return {"ok": True}


class Handler(BaseHTTPRequestHandler):
    server_version = "GatekeeperBridge/1.0"

    def log_message(self, fmt, *args):
        log.info("%s %s", self.command, self.path.split("?")[0])

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > 1_000_000:
            raise BridgeError("missing or oversized request body")
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise BridgeError("invalid JSON body")

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/shop":
            self._send(200, shop_status())
            return
        self._send(404, {"ok": False, "error": "unknown path"})

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            if path == "/onboard":
                result = onboard(self._read_json())
            elif path == "/grant-soul":
                result = grant_soul(self._read_json())
            elif path == "/soul/write":
                result = soul_write(self._read_json())
            elif path == "/session/end":
                result = session_end(self._read_json())
            else:
                self._send(404, {"ok": False, "error": "unknown path"})
                return
            self._send(200, result)
        except BridgeError as exc:
            self._send(502, {"ok": False, "error": str(exc)})
        except Exception:
            log.exception("unhandled error")
            self._send(500, {"ok": False, "error": "internal error"})


def main():
    if not ADMIN_KEY:
        print("FATAL: RUNTIME_ADMIN_KEY is not set", file=sys.stderr)
        sys.exit(2)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    log.info("gatekeeper-bridge listening on :%s -> %s", PORT, RUNTIME_BASE)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
