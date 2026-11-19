#!/usr/bin/env python3
"""Review candidate: one pinned staging-only Runtime rollout; default is read-only.

No fetch, checkout, merge, production mutation, timer change, grant API, database
write, image cleanup, or notification. Run as the existing authorized operator
with sudo. The candidate commit must already exist in the selected Runtime repo.
"""
from __future__ import annotations

import argparse
import contextlib
import copy
import datetime as dt
import fcntl
import hashlib
import http.client
import io
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request

HOST = "meshtool-prod"
STAGING = "staging-runtime"
PRODUCTION = "own-rails-runtime-prod"
STAGING_ID = "090fc51c6884d1dbdc09b39cf6321ef40d42237fba25f2291d1f382ff0b11fa5"
PRODUCTION_ID = "5146ed5cf72447487286ba4ab485060cc593af62e217cfa2e53e3bd1177109e0"
BASE_IMAGE = "sha256:a6b89fcfad50fa125c3870253acef39e40ad98d742ecff82fb8c09ead8fc805f"
BASE_HASH = "59107df04578198aef024dae1a8cf7882f3ef2573e89bfb24429156a0d8b9525"
PRODUCTION_PID = 700646
PRODUCTION_STARTED = "2026-11-14T08:51:34.616308668Z"
PRODUCTION_RESTART_COUNT = 0
PRODUCTION_ADDRESS = "172.17.0.5"
DOCKER_SOCKET = "/var/run/docker.sock"
DOCKER_VERSION = "29.1.3"
DOCKER_BUILD = "29.1.3-0ubuntu3~24.04.2"
DOCKER_API = "1.52"
DOCKER_ENGINE_ID = "e982df3c-d2fd-4dec-bace-1b3831fb421c"
NETWORK = "staging-net"
NETWORK_ID = "60b98edbb630a5f50d6b2adc53209b54811cb45c2a5de53446afbf5b3153e75c"
PORTS = {"3000/tcp": [{"HostIp": "127.0.0.1", "HostPort": "18080"},
                       {"HostIp": "100.85.34.93", "HostPort": "18080"}]}
ENV_FILE = "/opt/staging/runtime.env"
LOCKS = ("/opt/runtime/deploy/lock", "/run/staging-rail-watchdog.lock")
RECEIPTS = Path("/opt/staging/proof-reconnect-receipts")
STAGING_HEALTH = "http://127.0.0.1:18080/health"
PRODUCTION_HEALTH = "http://100.85.34.93:18081/health"
DOCKERFILE_BLOB = "49e4c2f731c70b09b02a12b8bb41cefe3621bc80"
PACKAGE_BLOB = "fdb764b655b218eb453992733dfeffd2901576a9"
PROOF_ENV = {
    "PUBLIC_URL": "https://staging-runtime.meshtool.ai",
    "DEVDESK_PROOF_ENABLED": "1",
    "DEVDESK_PROOF_TENANT": "t_uCUhCZP_FcnB",
    "DEVDESK_PROOF_REDIRECT_URI": "https://chatgpt-devdesk.meshtool.ai/runtime/callback",
}
KIND = "runtime-isolated-staging-rollout/v1"
RECOVERABLE = {"candidate_created", "stopping_original", "original_retained", "starting_candidate",
               "staged", "rollback_started", "uncertain_manual_recovery_required"}
DB_PINS = {
    "production": {
        "id": "15cec49a81ca655e5931420942587810a41570aab5a0e6dcd6c4052474600075",
        "image": "sha256:e3d24f6906d0760bf4da0dae872415391ededefad23fd471c47dc53b0ddf3c42",
        "network": "bridge", "networkId": "cc32d3153b73425fbad4b7166296af5e0f00f7d70b50e66d263b6f741d45550a",
        "address": "172.17.0.3", "volume": "pg-runtime",
        "source": "/var/lib/docker/volumes/pg-runtime/_data",
    },
    "staging": {
        "id": "8dc791d2cd40a6024a718b9e55d01fecd600ede1eb965662fe29e2bde28847fd",
        "image": "sha256:3a4264520e121176619f54ff867d12774bc81e95e7b84db58d63bccdb6144b81",
        "network": NETWORK, "networkId": NETWORK_ID, "address": "172.18.0.2",
        "volume": "staging-pg-data", "source": "/var/lib/docker/volumes/staging-pg-data/_data",
    },
}


class Refusal(Exception):
    """Only fixed, credential-free reason codes may leave this helper."""


def require(condition, code):
    if not condition:
        raise Refusal(code)


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def environment(container):
    result = {}
    for item in container["Config"].get("Env", []):
        key, sep, value = item.partition("=")
        require(sep and key, "environment_shape_refused")
        # Identical repeats cannot change first/last-wins lookup semantics. A
        # conflicting repeat is ambiguous, so never silently choose either one.
        require(key not in result or result[key] == value, "environment_conflicting_duplicate")
        result[key] = value
    return result


def ports(value):
    return {k: sorted([p["HostIp"], p["HostPort"]] for p in v)
            for k, v in (value or {}).items()}


def identity(container):
    """No environment values or hashes of credentials in a receipt."""
    return {
        "id": container["Id"], "image": container["Image"],
        "name": container["Name"], "created": container["Created"],
        "started": container["State"]["StartedAt"],
        "running": container["State"]["Running"],
        "pid": container["State"]["Pid"],
        "restartCount": container["RestartCount"],
        "networkMode": container["HostConfig"]["NetworkMode"],
        "ports": ports(container["HostConfig"].get("PortBindings")),
        "networks": {k: {"id": v["NetworkID"], "ip": v["IPAddress"]}
                     for k, v in container["NetworkSettings"]["Networks"].items()},
        "mounts": [{"type": m["Type"], "source": m.get("Source"),
                    "destination": m["Destination"], "rw": m["RW"]}
                   for m in container["Mounts"]],
    }


def healthy(body, expected_hash):
    return (body.get("ok") is True and body.get("db") is True
            and body.get("source", {}).get("sha256") == expected_hash)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise Refusal("health_redirect_refused")


def verify_docker_socket():
    path = Path(DOCKER_SOCKET)
    info = path.lstat()
    require(stat.S_ISSOCK(info.st_mode) and info.st_uid == 0 and info.st_gid == 110
            and stat.S_IMODE(info.st_mode) == 0o660, "docker_socket_identity_refused")


class DockerSocketConnection(http.client.HTTPConnection):
    """Fixed root-owned Unix socket only; no TCP, proxy or alternate host."""
    def __init__(self):
        super().__init__("localhost", timeout=15)

    def connect(self):
        verify_docker_socket()
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(DOCKER_SOCKET)


def candidate_create_body(original, image_id, sha):
    """Copy the exact current staging settings; never persist this secret body."""
    require(original["Id"] == STAGING_ID and original["Image"] == BASE_IMAGE
            and original["State"]["Running"], "create_original_pin_mismatch")
    require("OomKillDisable" in original["HostConfig"]
            and original["HostConfig"]["OomKillDisable"] is None, "staging_oom_shape_changed")
    require(re.fullmatch(r"sha256:[0-9a-f]{64}", image_id) and re.fullmatch(r"[0-9a-f]{40}", sha),
            "create_image_or_source_refused")
    env = environment(original)
    require(all(key not in env or env[key] == value for key, value in PROOF_ENV.items()), "proof_env_conflict")
    body = copy.deepcopy(original["Config"])
    body["Hostname"] = ""  # Docker assigns the new container's hostname.
    body["Image"] = image_id
    body["Env"] = list(original["Config"]["Env"])
    body["Env"].extend(key + "=" + value for key, value in PROOF_ENV.items() if key not in env)
    body["Labels"] = {**(body.get("Labels") or {}), "org.opencontainers.image.revision": sha,
                      "meshtool.purpose": "isolated-staging-proof"}
    body["HostConfig"] = copy.deepcopy(original["HostConfig"])
    require(body["HostConfig"] == original["HostConfig"], "create_host_config_changed")
    require(environment({"Config": body}) == {**env, **PROOF_ENV}, "create_environment_changed")
    return body


class Backend:
    def run(self, args, *, label, input_bytes=None, timeout=60):
        try:
            r = subprocess.run(args, input=input_bytes, capture_output=True,
                               timeout=timeout, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise Refusal(label + "_unavailable") from None
        require(r.returncode == 0, label + "_failed")
        return r.stdout

    def inspect(self, name):
        return json.loads(self.run(["docker", "inspect", name], label="inspect"))[0]

    def network(self, name):
        return json.loads(self.run(["docker", "network", "inspect", name], label="network_inspect"))[0]

    def image(self, name):
        return json.loads(self.run(["docker", "image", "inspect", name], label="image_inspect"))[0]

    def volume(self, name):
        return json.loads(self.run(["docker", "volume", "inspect", name], label="volume_inspect"))[0]

    def engine_request(self, method, path, body=None):
        """Only the pinned read endpoints and one new-candidate create endpoint."""
        reads = {"/version", "/v" + DOCKER_API + "/info",
                 "/v" + DOCKER_API + "/containers/" + STAGING_ID + "/json"}
        create_path = (r"/v" + re.escape(DOCKER_API) + r"/containers/create\?name="
                       + re.escape(STAGING) + r"-candidate-[0-9]{8}T[0-9]{12}Z-[0-9a-f]{12}")
        require((method == "GET" and path in reads and body is None)
                or (method == "POST" and re.fullmatch(create_path, path) and isinstance(body, dict)),
                "engine_endpoint_refused")
        connection = None
        try:
            verify_docker_socket()
            payload = json.dumps(body, separators=(",", ":")).encode() if body is not None else None
            require(payload is None or len(payload) <= 1024 * 1024, "engine_request_too_large")
            connection = DockerSocketConnection()
            # There is deliberately no automatic retry, including ambiguous POST failure.
            connection.request(method, path, body=payload,
                               headers={"Content-Type": "application/json"} if payload is not None else {})
            response = connection.getresponse()
            require(response.status == (201 if method == "POST" else 200), "engine_response_status_refused")
            raw = response.read(1024 * 1024 + 1)
            require(len(raw) <= 1024 * 1024, "engine_response_too_large")
            result = json.loads(raw)
            require(isinstance(result, dict), "engine_response_shape_refused")
            return result
        except Refusal:
            raise
        except Exception:
            raise Refusal("engine_request_unavailable_details_suppressed") from None
        finally:
            if connection is not None:
                connection.close()

    def verify_create_engine(self, original):
        require(all(not os.environ.get(key) for key in
                    ("DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_API_VERSION", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH")),
                "docker_environment_override_refused")
        require(self.run(["docker", "context", "show"], label="docker_context").strip() == b"default",
                "docker_context_refused")
        endpoint = self.run(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
                            label="docker_endpoint").strip()
        require(endpoint == b"unix:///var/run/docker.sock", "docker_endpoint_refused")
        version = self.engine_request("GET", "/version")
        require(version.get("Version") == DOCKER_VERSION and version.get("ApiVersion") == DOCKER_API
                and version.get("GitCommit") == DOCKER_BUILD
                and version.get("MinAPIVersion") == "1.44" and version.get("Os") == "linux",
                "docker_engine_version_changed")
        info = self.engine_request("GET", "/v" + DOCKER_API + "/info")
        require(info.get("ID") == DOCKER_ENGINE_ID, "docker_engine_identity_changed")
        require(info.get("CgroupVersion") == "2" and info.get("CgroupDriver") == "systemd"
                and info.get("OomKillDisable") is False, "docker_oom_capability_changed")
        observed = self.engine_request("GET", "/v" + DOCKER_API + "/containers/" + STAGING_ID + "/json")
        require(identity(observed) == identity(original) and observed["Config"] == original["Config"]
                and observed["HostConfig"] == original["HostConfig"], "engine_original_differs_from_cli")
        return {"transport": "root_owned_unix_socket", "context": "default",
                "apiVersion": version["ApiVersion"], "engineVersion": version["Version"],
                "engineGitCommit": version["GitCommit"], "cgroupVersion": info["CgroupVersion"],
                "cgroupDriver": info["CgroupDriver"], "oomKillDisableSupported": info["OomKillDisable"],
                "engineId": info["ID"], "socketOwnerAndModePinned": True,
                "originalIdentityConfigHostConfigMatched": True}

    def create_candidate(self, original, image_id, sha, name):
        require(re.fullmatch(r"[0-9a-f]{40}", sha), "create_source_refused")
        require(re.fullmatch(re.escape(STAGING) + r"-candidate-[0-9]{8}T[0-9]{12}Z-" + sha[:12], name),
                "create_candidate_name_refused")
        current = self.inspect(STAGING_ID)
        require(identity(current) == identity(original) and current["Config"] == original["Config"]
                and current["HostConfig"] == original["HostConfig"], "create_original_changed")
        self.verify_create_engine(current)
        image = self.image(image_id)
        require(image["Id"] == image_id and image["Config"].get("Labels", {}).get("org.opencontainers.image.revision") == sha,
                "create_image_identity_changed")
        body = candidate_create_body(current, image_id, sha)
        result = self.engine_request("POST", "/v" + DOCKER_API + "/containers/create?name=" + name, body)
        require(isinstance(result.get("Id"), str) and re.fullmatch(r"[0-9a-f]{64}", result["Id"]),
                "candidate_id_invalid")
        require(not result.get("Warnings"), "candidate_create_warning_refused")
        return result["Id"]

    def production_sockets(self, pid):
        require(pid == PRODUCTION_PID, "socket_process_pin_mismatch")
        raw = self.run(["nsenter", "--target", str(pid), "--net", "--", "ss", "-Hntp",
                        "state", "established", "( dport = :5432 )"], label="production_socket_read", timeout=10)
        return parse_postgres_sockets(raw.decode("utf-8"))

    def docker(self, *args):
        # All callers pass literal staging names or previously verified staging IDs.
        return self.run(["docker", *args], label="docker_" + args[0], timeout=90)

    def health(self, url):
        require(url in (STAGING_HEALTH, PRODUCTION_HEALTH), "health_target_refused")
        try:
            opener = urllib.request.build_opener(NoRedirect(), urllib.request.ProxyHandler({}))
            with opener.open(url, timeout=3) as response:
                require(response.status == 200, "health_status_refused")
                return json.loads(response.read(65537))
        except Refusal:
            raise
        except Exception:
            raise Refusal("health_unavailable") from None

    def candidate(self, repo, sha):
        require(re.fullmatch(r"[0-9a-f]{40}", sha), "full_commit_sha_required")
        base = ["git", "-C", str(repo)]
        remote = self.run(base + ["remote", "get-url", "origin"], label="repo_origin").decode().strip()
        require(remote in ("git@github.com:RightOnPar-LLC/creator-os-runtime.git",
                           "https://github.com/RightOnPar-LLC/creator-os-runtime.git",
                           "https://github.com/RightOnPar-LLC/creator-os-runtime"), "runtime_repo_required")
        require(self.run(base + ["cat-file", "-t", sha], label="commit_lookup").strip() == b"commit",
                "commit_object_required")
        for path, expected in (("deploy/Dockerfile", DOCKERFILE_BLOB), ("package.json", PACKAGE_BLOB)):
            actual = self.run(base + ["rev-parse", sha + ":" + path], label="recipe_lookup").decode().strip()
            require(actual == expected, "reviewed_build_recipe_changed")
        return {"sha": sha, "repo": str(repo), "dockerfileBlob": DOCKERFILE_BLOB,
                "packageBlob": PACKAGE_BLOB}

    def build(self, repo, sha, tag):
        archive = self.run(["git", "-C", str(repo), "archive", "--format=tar", sha],
                           label="git_archive", timeout=120)
        require(len(archive) <= 64 * 1024 * 1024, "archive_too_large")
        embedded = self.run(["git", "get-tar-commit-id"], label="archive_identity", input_bytes=archive).decode().strip()
        require(embedded == sha, "archive_commit_mismatch")
        archive_hash = hashlib.sha256(archive).hexdigest()
        with tempfile.TemporaryDirectory(prefix="runtime-staging-build-") as directory:
            with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
                members = tar.getmembers()
                require(sum(m.size for m in members) <= 128 * 1024 * 1024, "archive_expansion_refused")
                for member in members:
                    p = PurePosixPath(member.name)
                    require(not p.is_absolute() and ".." not in p.parts
                            and (member.isfile() or member.isdir()), "unsafe_archive_member")
                tar.extractall(directory, members=members, filter="data")
            self.run(["docker", "build", "--quiet", "--label", "org.opencontainers.image.revision=" + sha,
                      "--label", "meshtool.purpose=isolated-staging-proof",
                      "-f", str(Path(directory) / "deploy/Dockerfile"), "-t", tag, directory],
                     label="candidate_build", timeout=900)
        image = self.image(tag)
        require(image["Config"].get("Labels", {}).get("org.opencontainers.image.revision") == sha,
                "candidate_image_revision_mismatch")
        raw = self.run(["docker", "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
                        "--security-opt", "no-new-privileges", "--entrypoint", "sha256sum",
                        image["Id"], "/app/runtime.js"], label="candidate_bundle_hash").decode().split()
        require(len(raw) == 2 and re.fullmatch(r"[0-9a-f]{64}", raw[0]) and raw[1] == "/app/runtime.js",
                "candidate_bundle_hash_invalid")
        return {"imageId": image["Id"], "bundleHash": raw[0], "archiveHash": archive_hash}


def database_target(backend, runtime):
    """Resolve the configured URL through Docker aliases/links, never external DNS."""
    u = urllib.parse.urlsplit(environment(runtime).get("DATABASE_URL", ""))
    host = (u.hostname or "").lower()
    require(u.scheme in ("postgres", "postgresql") and host and u.path.strip("/")
            and (u.port or 5432) == 5432 and not u.query and not u.fragment, "database_url_shape_refused")
    candidates = set()
    networks = runtime["NetworkSettings"]["Networks"]
    for net in networks:
        for container_id, item in backend.network(net).get("Containers", {}).items():
            c = backend.inspect(container_id)
            connection = c["NetworkSettings"]["Networks"].get(net, {})
            names = [item.get("Name", "")] + (connection.get("Aliases") or []) + (connection.get("DNSNames") or [])
            address = item.get("IPv4Address", "").split("/")[0]
            if address == host or host in [name.lower() for name in names]:
                candidates.add((c["Id"], address))
    for link in runtime["HostConfig"].get("Links") or []:
        source, alias = link.split(":", 1)
        if alias.rsplit("/", 1)[-1].lower() == host:
            c = backend.inspect(source.lstrip("/"))
            for net, connection in c["NetworkSettings"]["Networks"].items():
                if net in networks:
                    candidates.add((c["Id"], connection["IPAddress"]))
    require(len(candidates) == 1, "database_target_not_unique")
    container_id, address = next(iter(candidates))
    database = backend.inspect(container_id)
    require(database["State"]["Running"] and database["Id"] != runtime["Id"], "database_container_refused")
    sources = [m.get("Source", "") for m in database["Mounts"] if m.get("RW")]
    require(all(sources), "database_mount_identity_missing")
    return container_id, (address, 5432, urllib.parse.unquote(u.path.lstrip("/"))), sources


def production_environment_snapshot(production):
    """The one observed production exception is opaque data, never a URL selection.

    Staging/candidates always use environment(), which rejects conflicting values.
    This array remains in memory only; no value or credential hash enters receipts.
    """
    raw = production["Config"].get("Env", [])
    require(isinstance(raw, list) and len(raw) == 29, "production_environment_shape_refused")
    grouped = {}
    for item in raw:
        require(isinstance(item, str), "production_environment_shape_refused")
        key, sep, value = item.partition("=")
        require(key and sep, "production_environment_shape_refused")
        grouped.setdefault(key, []).append(value)
    duplicates = {key: len(values) for key, values in grouped.items() if len(values) > 1}
    require(len(grouped) == 28 and duplicates == {"DATABASE_URL": 2}
            and grouped["DATABASE_URL"][0] != grouped["DATABASE_URL"][1], "production_environment_shape_refused")
    return list(raw)


def assert_production_process_pin(production):
    require(production["Id"] == PRODUCTION_ID and production["Image"] == BASE_IMAGE,
            "production_container_or_image_pin_mismatch")
    state = production["State"]
    require(state["Running"] and state["Pid"] == PRODUCTION_PID
            and state["StartedAt"] == PRODUCTION_STARTED
            and production["RestartCount"] == PRODUCTION_RESTART_COUNT, "production_process_pin_mismatch")
    networks = production["NetworkSettings"]["Networks"]
    require(set(networks) == {"bridge"} and production["HostConfig"]["NetworkMode"] == "bridge"
            and networks["bridge"]["NetworkID"] == DB_PINS["production"]["networkId"]
            and networks["bridge"]["IPAddress"] == PRODUCTION_ADDRESS, "production_network_pin_mismatch")


def parse_postgres_sockets(text):
    """Parse only endpoints and owner PIDs; never return a raw ss line."""
    rows = []
    for line in text.splitlines():
        if not line.strip():
            continue
        endpoints = []
        for field in line.split():
            try:
                address, port = field.rsplit(":", 1)
                parsed = ipaddress.ip_address(address.strip("[]"))
                if isinstance(parsed, ipaddress.IPv6Address) and parsed.ipv4_mapped:
                    parsed = parsed.ipv4_mapped
                endpoints.append((str(parsed), int(port)))
            except (ValueError, TypeError):
                pass
        owners = set(int(value) for value in re.findall(r"pid=([0-9]+)", line))
        require(len(endpoints) == 2 and endpoints[1][1] == 5432 and owners,
                "postgres_socket_shape_refused")
        rows.append({"local": endpoints[0], "peer": endpoints[1], "owners": owners})
    require(rows, "production_postgres_sockets_absent")
    return rows


def pinned_database(backend, role):
    pin = DB_PINS[role]
    db = backend.inspect(pin["id"])
    require(db["Id"] == pin["id"] and db["Image"] == pin["image"] and db["State"]["Running"],
            role + "_database_identity_changed")
    networks = db["NetworkSettings"]["Networks"]
    require(set(networks) == {pin["network"]}
            and networks[pin["network"]]["NetworkID"] == pin["networkId"]
            and networks[pin["network"]]["IPAddress"] == pin["address"], role + "_database_network_changed")
    network = backend.network(pin["network"])
    require(network["Id"] == pin["networkId"], role + "_database_network_changed")
    owners = [cid for cid, item in network.get("Containers", {}).items()
              if item.get("IPv4Address", "").split("/")[0] == pin["address"]]
    require(owners == [pin["id"]], role + "_database_address_not_unique")
    writable = [{"type": m["Type"], "name": m.get("Name"), "source": m.get("Source"),
                 "canonicalSource": os.path.realpath(m.get("Source", "")),
                 "destination": m["Destination"], "rw": m["RW"]}
                for m in db["Mounts"] if m.get("RW")]
    expected = [{"type": "volume", "name": pin["volume"], "source": pin["source"],
                 "canonicalSource": pin["source"], "destination": "/var/lib/postgresql", "rw": True}]
    require(writable == expected, role + "_database_storage_changed")
    volume = backend.volume(pin["volume"])
    require(volume["Name"] == pin["volume"] and volume["Driver"] == "local"
            and not volume.get("Options") and volume["Mountpoint"] == pin["source"]
            and volume.get("Scope") == "local", role + "_database_volume_changed")
    return pin


def observe_production_database(backend, production, expected_env=None):
    assert_production_process_pin(production)
    before = identity(production)
    env_before = production_environment_snapshot(production)
    if expected_env is not None:
        require(env_before == expected_env, "production_environment_changed")
    # The existing public health route creates/uses the existing DB pool. No
    # credential or SQL is injected; this also checks the pinned running source.
    require(healthy(backend.health(PRODUCTION_HEALTH), BASE_HASH), "production_health_changed")
    pin = pinned_database(backend, "production")
    sockets = backend.production_sockets(PRODUCTION_PID)
    require(sockets, "production_postgres_sockets_absent")
    require(all(row["owners"] == {PRODUCTION_PID} for row in sockets), "production_socket_owner_mismatch")
    require(all(row["local"][0] == PRODUCTION_ADDRESS for row in sockets), "production_socket_local_address_changed")
    peers = {row["peer"] for row in sockets}
    require(peers == {(pin["address"], 5432)}, "production_socket_peer_mismatch")
    # Re-read the database after observing sockets; a cached peer must not stand
    # in for an independently running, still-pinned database and volume.
    pinned_database(backend, "production")
    after = backend.inspect(PRODUCTION)
    assert_production_process_pin(after)
    require(identity(after) == before, "production_identity_changed_during_observation")
    require(production_environment_snapshot(after) == env_before, "production_environment_changed")
    require(healthy(backend.health(PRODUCTION_HEALTH), BASE_HASH), "production_health_changed")
    return {"productionDatabaseEvidence": "owned_established_sockets",
            "observedProcessPid": PRODUCTION_PID, "observedProcessStartedAt": PRODUCTION_STARTED,
            "observedRestartCount": PRODUCTION_RESTART_COUNT,
            "productionDatabaseContainerId": pin["id"], "productionDatabasePinsMatched": True,
            "establishedPostgresSockets": len(sockets), "observedSocketPeers": 1,
            "productionRawEnvArrayUnchanged": True, "observedAt": now()}


def check_database_isolation(backend, staging, production, expected_prod_env=None):
    target = database_target(backend, staging)
    stage = pinned_database(backend, "staging")
    require(target[0] == stage["id"] and target[1][:2] == (stage["address"], 5432)
            and target[2] == [stage["source"]], "staging_database_target_not_pinned")
    evidence = observe_production_database(backend, production, expected_prod_env)
    prod = DB_PINS["production"]
    require(stage["id"] != prod["id"] and stage["address"] != prod["address"]
            and not (stage["source"] == prod["source"] or stage["source"].startswith(prod["source"] + "/")
                     or prod["source"].startswith(stage["source"] + "/")), "database_isolation_refused")
    return {**evidence, "stagingDatabaseContainerId": stage["id"], "stagingDatabasePinsMatched": True,
            "socketPeersDistinct": True, "databaseContainersDistinct": True,
            "writableDatabaseStorageDisjoint": True}


def baseline(backend):
    require(socket.gethostname() == HOST, "host_pin_mismatch")
    s, p = backend.inspect(STAGING), backend.inspect(PRODUCTION)
    require(s["Id"] == STAGING_ID and p["Id"] == PRODUCTION_ID, "container_pin_mismatch")
    require(s["Image"] == BASE_IMAGE and p["Image"] == BASE_IMAGE, "image_pin_mismatch")
    require(s["State"]["Running"] and p["State"]["Running"], "baseline_not_running")
    nets = s["NetworkSettings"]["Networks"]
    require(set(nets) == {NETWORK} and nets[NETWORK]["NetworkID"] == NETWORK_ID, "network_pin_mismatch")
    require(backend.network(NETWORK)["Id"] == NETWORK_ID, "network_name_rebound")
    require(not nets[NETWORK].get("Aliases") and not nets[NETWORK].get("IPAMConfig"), "staging_network_options_changed")
    require(s["HostConfig"]["NetworkMode"] == NETWORK and not s["Mounts"]
            and ports(s["HostConfig"].get("PortBindings")) == ports(PORTS), "staging_topology_changed")
    require(s["HostConfig"]["RestartPolicy"] == {"Name": "unless-stopped", "MaximumRetryCount": 0},
            "staging_restart_policy_changed")
    require("OomKillDisable" in s["HostConfig"] and s["HostConfig"]["OomKillDisable"] is None,
            "staging_oom_shape_changed")
    engine = backend.verify_create_engine(s)
    env = environment(s)
    require(all(key not in env or env[key] == value for key, value in PROOF_ENV.items()), "proof_env_conflict")
    require(healthy(backend.health(STAGING_HEALTH), BASE_HASH), "staging_baseline_hash_mismatch")
    require(healthy(backend.health(PRODUCTION_HEALTH), BASE_HASH), "production_baseline_hash_mismatch")
    return s, p, check_database_isolation(backend, s, p), {**engine, "originalOomKillDisableIsNull": True}


def assert_production_unchanged(backend, before, expected_env=None):
    production = backend.inspect(PRODUCTION)
    require(identity(production) == before, "production_identity_changed")
    return observe_production_database(backend, production, expected_env)


def validate_candidate_container(old, new, *, started=False, engine=None):
    require(environment(new) == {**environment(old), **PROOF_ENV}, "candidate_environment_mismatch")
    require(not new["Mounts"], "candidate_mounts_refused")
    if started:
        require(new["State"]["Running"], "candidate_must_be_running")
        require(new["HostConfig"] == old["HostConfig"], "candidate_started_host_config_mismatch")
    else:
        require(not new["State"]["Running"] and new["State"]["Pid"] == 0
                and new["State"]["StartedAt"] == "0001-01-01T00:00:00Z", "candidate_must_be_unstarted")
        if new["HostConfig"] != old["HostConfig"]:
            # This exact daemon creates false after capability validation, then
            # clears it during START on cgroup v2. This is not general equality
            # normalization: the fully running HostConfig must match above.
            expected_engine = {"engineVersion": DOCKER_VERSION, "engineGitCommit": DOCKER_BUILD,
                               "apiVersion": DOCKER_API, "engineId": DOCKER_ENGINE_ID,
                               "cgroupVersion": "2", "cgroupDriver": "systemd"}
            pinned = (isinstance(engine, dict) and all(engine.get(k) == v for k, v in expected_engine.items())
                      and engine.get("oomKillDisableSupported") is False)
            before, after = old["HostConfig"], new["HostConfig"]
            require(pinned and old["Id"] == STAGING_ID and old["State"]["Running"]
                    and "OomKillDisable" in before and before["OomKillDisable"] is None
                    and "OomKillDisable" in after and after["OomKillDisable"] is False
                    and {k: v for k, v in before.items() if k != "OomKillDisable"}
                    == {k: v for k, v in after.items() if k != "OomKillDisable"},
                    "candidate_host_config_mismatch")
    for key in ("Cmd", "Entrypoint", "User", "WorkingDir", "Healthcheck", "StopSignal", "ExposedPorts", "Volumes"):
        require(new["Config"].get(key) == old["Config"].get(key), "candidate_runtime_config_mismatch")


def assert_candidate_database(backend, candidate, expected_target, *, started):
    require(backend.network(NETWORK)["Id"] == NETWORK_ID, "network_name_rebound")
    networks = candidate["NetworkSettings"]["Networks"]
    require(set(networks) == {NETWORK} and candidate["HostConfig"]["NetworkMode"] == NETWORK,
            "candidate_network_changed")
    connection = networks[NETWORK]
    # An unstarted Docker container may not have its endpoint allocated yet.
    require(connection.get("NetworkID") in ((NETWORK_ID,) if started else ("", NETWORK_ID)),
            "candidate_network_id_mismatch")
    require(not connection.get("Aliases") and not connection.get("IPAMConfig"), "candidate_network_options_changed")
    if started:
        require(STAGING in (connection.get("DNSNames") or []), "candidate_staging_dns_name_missing")
    require(database_target(backend, candidate) == expected_target, "candidate_database_target_changed")


def wait_health(backend, expected_hash, attempts=20, delay=2):
    for attempt in range(attempts):
        try:
            if healthy(backend.health(STAGING_HEALTH), expected_hash):
                return
        except Refusal:
            pass
        if attempt + 1 < attempts:
            time.sleep(delay)
    raise Refusal("staging_health_gate_failed")


@contextlib.contextmanager
def locks():
    descriptors = []
    try:
        for path in LOCKS:
            fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            descriptors.append(fd)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Refusal("deployment_lock_busy") from None
        yield
    finally:
        for fd in reversed(descriptors):
            os.close(fd)


def save_receipt(path, data):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_suffix(".pending")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump(data, handle, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def restore(backend, record, expected_prod_env=None):
    """Only restore the pinned original staging container; retain candidate stopped."""
    require(record["stagingBefore"]["id"] == STAGING_ID, "rollback_original_pin_mismatch")
    old = backend.inspect(STAGING_ID)
    require(old["Image"] == BASE_IMAGE and old["Name"] in ("/" + STAGING, "/" + record["rollbackName"]),
            "rollback_original_changed")
    candidate_id = record.get("candidateContainerId")
    if candidate_id:
        require(candidate_id not in (STAGING_ID, PRODUCTION_ID), "rollback_candidate_refused")
        candidate = backend.inspect(candidate_id)
        require(candidate["Image"] == record["candidate"]["imageId"], "rollback_candidate_image_changed")
        require(candidate["Name"] in ("/" + STAGING, "/" + record["candidateName"], "/" + record["failedName"]),
                "rollback_candidate_name_changed")
        if candidate["State"]["Running"]:
            backend.docker("stop", "--time", "20", candidate_id)
            require(not backend.inspect(candidate_id)["State"]["Running"], "rollback_candidate_still_running")
        if candidate["Name"] == "/" + STAGING:
            backend.docker("rename", candidate_id, record["failedName"])
    if old["Name"] != "/" + STAGING:
        backend.docker("rename", STAGING_ID, STAGING)
    if not backend.inspect(STAGING_ID)["State"]["Running"]:
        backend.docker("start", STAGING_ID)
    require(backend.inspect(STAGING)["Id"] == STAGING_ID, "rollback_name_not_restored")
    wait_health(backend, BASE_HASH)
    assert_production_unchanged(backend, record["productionBefore"], expected_prod_env)


def deploy(backend, repo, sha, expected_bundle_hash, path, writer=save_receipt):
    require(re.fullmatch(r"[0-9a-f]{64}", expected_bundle_hash or ""), "tested_bundle_hash_required")
    source = backend.candidate(repo, sha)
    old, prod, isolation, engine = baseline(backend)
    original_production_env = production_environment_snapshot(prod)
    original_database_target = database_target(backend, old)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    suffix = stamp + "-" + sha[:12]
    record = {"kind": KIND, "host": HOST, "startedAt": now(), "phase": "building", "source": source,
              "stagingBefore": identity(old), "productionBefore": identity(prod),
              "expectedTestedBundleHash": expected_bundle_hash,
              "databaseIsolation": isolation, "candidateCreationTransport": engine, "permittedEnvAdditions": PROOF_ENV,
              "candidateName": STAGING + "-candidate-" + suffix,
              "rollbackName": STAGING + "-before-proof-" + suffix,
              "failedName": STAGING + "-failed-proof-" + suffix}
    writer(path, record)
    touched_original = False
    try:
        record["candidate"] = backend.build(repo, sha, "runtime-staging-proof:" + sha)
        writer(path, record)
        require(record["candidate"]["bundleHash"] == expected_bundle_hash, "image_differs_from_tested_bundle")
        # No mutable source refs and no pre-existing staging drift before create/stop.
        require(identity(backend.inspect(STAGING)) == identity(old), "staging_changed_during_build")
        assert_production_unchanged(backend, record["productionBefore"], original_production_env)
        candidate_id = backend.create_candidate(old, record["candidate"]["imageId"], sha, record["candidateName"])
        require(re.fullmatch(r"[0-9a-f]{64}", candidate_id), "candidate_id_invalid")
        record["candidateContainerId"] = candidate_id
        record["phase"] = "candidate_created"
        writer(path, record)
        candidate = backend.inspect(candidate_id)
        validate_candidate_container(old, candidate, engine=engine)
        record["candidateHostConfigPrestart"] = ("exact_original" if candidate["HostConfig"] == old["HostConfig"]
                                                else "pinned_daemon_oom_default_false_pending_start")
        assert_candidate_database(backend, candidate, original_database_target, started=False)
        require(candidate["Image"] == record["candidate"]["imageId"], "candidate_image_mismatch")
        assert_production_unchanged(backend, record["productionBefore"], original_production_env)
        record["phase"] = "stopping_original"
        writer(path, record)
        touched_original = True
        backend.docker("stop", "--time", "20", STAGING_ID)
        require(not backend.inspect(STAGING_ID)["State"]["Running"], "original_still_running")
        backend.docker("rename", STAGING_ID, record["rollbackName"])
        record["phase"] = "original_retained"
        writer(path, record)
        backend.docker("rename", candidate_id, STAGING)
        record["phase"] = "starting_candidate"
        writer(path, record)
        backend.docker("start", candidate_id)
        validate_candidate_container(old, backend.inspect(candidate_id), started=True)
        record["candidateHostConfigAfterStart"] = "exact_original"
        wait_health(backend, record["candidate"]["bundleHash"])
        require(backend.inspect(STAGING)["Id"] == candidate_id, "active_candidate_identity_mismatch")
        live_candidate = backend.inspect(candidate_id)
        validate_candidate_container(old, live_candidate, started=True)
        assert_candidate_database(backend, live_candidate, original_database_target, started=True)
        record["databaseIsolationAfter"] = check_database_isolation(
            backend, live_candidate, backend.inspect(PRODUCTION), original_production_env)
        assert_production_unchanged(backend, record["productionBefore"], original_production_env)
        record.update(phase="staged", finishedAt=now(), productionUnchanged=True,
                      rollbackContainerRetained=STAGING_ID, databaseTargetPreserved=True)
        writer(path, record)
        return record
    except BaseException as exc:
        record["reason"] = str(exc) if isinstance(exc, Refusal) else "unexpected_failure_details_suppressed"
        if touched_original:
            try:
                restore(backend, record, original_production_env)
                record.update(phase="failed_restored", productionUnchanged=True)
            except BaseException:
                record["phase"] = "uncertain_manual_recovery_required"
        else:
            record["phase"] = "refused_before_activation"
        record["finishedAt"] = now()
        writer(path, record)
        raise Refusal(record["phase"] + ":" + record["reason"]) from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path("/opt/runtime/src"))
    parser.add_argument("--sha", help="Full committed Runtime candidate SHA; never a branch")
    parser.add_argument("--expected-bundle-sha256", help="Required hash of the exact bundle that passed artifact tests")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--apply", action="store_true", help="Build and replace only pinned staging")
    modes.add_argument("--rollback-receipt", type=Path, help="Restore retained original after a staged rollout")
    args = parser.parse_args()
    require(os.geteuid() == 0, "existing_sudo_operator_required")
    require(sys.version_info >= (3, 12), "python_3_12_required")
    require(socket.gethostname() == HOST, "host_pin_mismatch")
    backend = Backend()
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, lambda *_: (_ for _ in ()).throw(Refusal("operator_interruption")))
    if args.rollback_receipt:
        path = args.rollback_receipt.resolve()
        require(path.parent == RECEIPTS and not path.is_symlink(), "rollback_receipt_path_refused")
        record = json.loads(path.read_text())
        require(record.get("kind") == KIND and record.get("host") == HOST and record.get("phase") in RECOVERABLE,
                "rollback_receipt_not_recoverable")
        require(record.get("candidateContainerId") and record.get("candidate", {}).get("imageId"),
                "rollback_candidate_checkpoint_missing")
        with locks():
            original_production_env = production_environment_snapshot(backend.inspect(PRODUCTION))
            assert_production_unchanged(backend, record["productionBefore"], original_production_env)
            record["phase"] = "rollback_started"
            save_receipt(path, record)
            try:
                restore(backend, record, original_production_env)
            except BaseException:
                record["phase"] = "uncertain_manual_recovery_required"
                save_receipt(path, record)
                raise Refusal("rollback_uncertain_no_production_action") from None
            record.update(phase="rolled_back", finishedAt=now(), productionUnchanged=True)
            save_receipt(path, record)
        print(json.dumps({"outcome": "rolled_back", "receipt": str(path), "productionUnchanged": True}))
        return
    require(args.sha is not None, "candidate_sha_required")
    require(re.fullmatch(r"[0-9a-f]{64}", args.expected_bundle_sha256 or ""), "tested_bundle_hash_required")
    if not args.apply:
        source = backend.candidate(args.repo, args.sha)
        s, p, isolation, engine = baseline(backend)
        print(json.dumps({"outcome": "read_only_plan", "source": source, "staging": identity(s),
                          "production": identity(p), "databaseIsolation": isolation,
                          "candidateCreationTransport": engine,
                          "expectedTestedBundleHash": args.expected_bundle_sha256,
                          "permittedEnvAdditions": PROOF_ENV, "locksRequired": LOCKS,
                          "next": "Review exact candidate and this plan before --apply"}))
        return
    path = RECEIPTS / (dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + "-" + args.sha[:12] + ".json")
    with locks():
        record = deploy(backend, args.repo, args.sha, args.expected_bundle_sha256, path)
    print(json.dumps({"outcome": record["phase"], "receipt": str(path), "candidateSha": args.sha,
                      "bundleHash": record["candidate"]["bundleHash"], "productionUnchanged": True,
                      "rollbackContainerRetained": STAGING_ID}))


if __name__ == "__main__":
    try:
        main()
    except Refusal as error:
        print(json.dumps({"outcome": "not_complete", "reason": str(error)}))
        sys.exit(1)
    except Exception:
        print(json.dumps({"outcome": "not_complete", "reason": "unexpected_failure_details_suppressed"}))
        sys.exit(1)
