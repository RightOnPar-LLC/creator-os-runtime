#!/usr/bin/env python3
"""Review candidate: one pinned staging-only Runtime rollout; default is read-only.

No fetch, checkout, merge, production mutation, timer change, grant API, database
write, image cleanup, or notification. Run as the existing authorized operator
with sudo. The candidate commit must already exist in the selected Runtime repo.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import socket
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
        require(sep and key not in result, "environment_shape_refused")
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


def check_database_isolation(backend, staging, production):
    a, b = database_target(backend, staging), database_target(backend, production)
    shared = any(x == y or x.startswith(y.rstrip("/") + "/") or y.startswith(x.rstrip("/") + "/")
                 for x in a[2] for y in b[2])
    require(a[0] != b[0] and a[1] != b[1] and not shared, "database_isolation_refused")
    return {"normalizedTargetsDistinct": True, "databaseContainersDistinct": True,
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
    env = environment(s)
    require(all(key not in env or env[key] == value for key, value in PROOF_ENV.items()), "proof_env_conflict")
    require(healthy(backend.health(STAGING_HEALTH), BASE_HASH), "staging_baseline_hash_mismatch")
    require(healthy(backend.health(PRODUCTION_HEALTH), BASE_HASH), "production_baseline_hash_mismatch")
    return s, p, check_database_isolation(backend, s, p)


def assert_production_unchanged(backend, before):
    require(identity(backend.inspect(PRODUCTION)) == before, "production_identity_changed")
    require(healthy(backend.health(PRODUCTION_HEALTH), BASE_HASH), "production_health_changed")


def validate_candidate_container(old, new):
    require(environment(new) == {**environment(old), **PROOF_ENV}, "candidate_environment_mismatch")
    # Docker allocates a new hostname/id. All operational HostConfig fields must agree.
    require(new["HostConfig"] == old["HostConfig"], "candidate_host_config_mismatch")
    for key in ("Cmd", "Entrypoint", "User", "WorkingDir", "Healthcheck", "StopSignal", "ExposedPorts", "Volumes"):
        require(new["Config"].get(key) == old["Config"].get(key), "candidate_runtime_config_mismatch")
    require(not new["Mounts"] and not new["State"]["Running"], "candidate_must_be_unstarted")


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


def restore(backend, record):
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
    assert_production_unchanged(backend, record["productionBefore"])


def deploy(backend, repo, sha, expected_bundle_hash, path, writer=save_receipt):
    require(re.fullmatch(r"[0-9a-f]{64}", expected_bundle_hash or ""), "tested_bundle_hash_required")
    source = backend.candidate(repo, sha)
    old, prod, isolation = baseline(backend)
    original_database_target = database_target(backend, old)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    suffix = stamp + "-" + sha[:12]
    record = {"kind": KIND, "host": HOST, "startedAt": now(), "phase": "building", "source": source,
              "stagingBefore": identity(old), "productionBefore": identity(prod),
              "expectedTestedBundleHash": expected_bundle_hash,
              "databaseIsolation": isolation, "permittedEnvAdditions": PROOF_ENV,
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
        assert_production_unchanged(backend, record["productionBefore"])
        arguments = ["create", "--name", record["candidateName"], "--restart", "unless-stopped",
                     "--network", NETWORK, "-p", "127.0.0.1:18080:3000", "-p", "100.85.34.93:18080:3000",
                     "--env-file", ENV_FILE]
        for key, value in PROOF_ENV.items():
            arguments.extend(["--env", key + "=" + value])
        arguments.append(record["candidate"]["imageId"])
        candidate_id = backend.docker(*arguments).decode().strip()
        require(re.fullmatch(r"[0-9a-f]{64}", candidate_id), "candidate_id_invalid")
        record["candidateContainerId"] = candidate_id
        record["phase"] = "candidate_created"
        writer(path, record)
        candidate = backend.inspect(candidate_id)
        validate_candidate_container(old, candidate)
        assert_candidate_database(backend, candidate, original_database_target, started=False)
        require(candidate["Image"] == record["candidate"]["imageId"], "candidate_image_mismatch")
        assert_production_unchanged(backend, record["productionBefore"])
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
        wait_health(backend, record["candidate"]["bundleHash"])
        require(backend.inspect(STAGING)["Id"] == candidate_id, "active_candidate_identity_mismatch")
        live_candidate = backend.inspect(candidate_id)
        assert_candidate_database(backend, live_candidate, original_database_target, started=True)
        check_database_isolation(backend, live_candidate, backend.inspect(PRODUCTION))
        assert_production_unchanged(backend, record["productionBefore"])
        record.update(phase="staged", finishedAt=now(), productionUnchanged=True,
                      rollbackContainerRetained=STAGING_ID, databaseTargetPreserved=True)
        writer(path, record)
        return record
    except BaseException as exc:
        record["reason"] = str(exc) if isinstance(exc, Refusal) else "unexpected_failure_details_suppressed"
        if touched_original:
            try:
                restore(backend, record)
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
            assert_production_unchanged(backend, record["productionBefore"])
            record["phase"] = "rollback_started"
            save_receipt(path, record)
            try:
                restore(backend, record)
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
        s, p, isolation = baseline(backend)
        print(json.dumps({"outcome": "read_only_plan", "source": source, "staging": identity(s),
                          "production": identity(p), "databaseIsolation": isolation,
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
