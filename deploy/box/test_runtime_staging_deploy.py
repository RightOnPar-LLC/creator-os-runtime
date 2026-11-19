"""Meaningful rollout refusal/recovery tests. No Docker, SSH, network or live state."""
import copy
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("rollout", Path(__file__).with_name("runtime_staging_deploy.py"))
r = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(r)

SHA = "d" * 40
NEW_ID = "e" * 64
NEW_IMAGE = "sha256:" + "f" * 64
NEW_HASH = "a" * 64
SECRET = "fake-password-never-in-evidence"


def container(cid, name, network, ip, portmap, env, image=r.BASE_IMAGE):
    return {
        "Id": cid, "Image": image, "Name": "/" + name, "Created": "2026-11-14T00:00:00Z",
        "RestartCount": 0, "State": {"Running": True, "StartedAt": "2026-11-14T00:00:01Z", "Pid": 123},
        "Config": {"Env": [k + "=" + v for k, v in env.items()], "Cmd": ["bun", "runtime.js"],
                   "Entrypoint": ["/usr/local/bin/docker-entrypoint.sh"], "User": "", "WorkingDir": "/app",
                   "ExposedPorts": {"3000/tcp": {}}, "Volumes": None},
        "HostConfig": {"NetworkMode": network, "PortBindings": copy.deepcopy(portmap),
                       "RestartPolicy": {"Name": "unless-stopped", "MaximumRetryCount": 0},
                       "Links": None, "Privileged": False},
        "Mounts": [],
        "NetworkSettings": {"Networks": {network: {"NetworkID": r.NETWORK_ID if network == r.NETWORK else "bridge-id",
                                                   "IPAddress": ip, "Aliases": None, "DNSNames": [name]}}},
    }


class Fake:
    def __init__(self):
        self.objects = {}
        self.commands = []
        self.fail = None
        self.env_drift = False
        self.config_drift = False
        self.bad_health = False
        self.production_drift_at = None
        self.rollback_start_failure = False
        s = container(r.STAGING_ID, r.STAGING, r.NETWORK, "172.18.0.3", r.PORTS,
                      {"NODE_ENV": "production", "DATABASE_URL": "postgres://user:" + SECRET + "@staging-db-alias/db"})
        p = container(r.PRODUCTION_ID, r.PRODUCTION, "bridge", "172.17.0.5",
                      {"3000/tcp": [{"HostIp": "100.85.34.93", "HostPort": "18081"}]},
                      {"NODE_ENV": "production", "DATABASE_URL": "postgres://user:" + SECRET + "@pg/db"})
        p["HostConfig"]["Links"] = ["/production-db:/own-rails-runtime-prod/pg"]
        sd = container("1" * 64, "staging-db", r.NETWORK, "172.18.0.2", {}, {})
        sd["NetworkSettings"]["Networks"][r.NETWORK]["Aliases"] = ["staging-db-alias"]
        sd["Mounts"] = [{"Source": "/var/lib/docker/volumes/staging/_data", "Destination": "/data", "Type": "volume", "RW": True}]
        pd = container("2" * 64, "production-db", "bridge", "172.17.0.2", {}, {})
        pd["Mounts"] = [{"Source": "/var/lib/docker/volumes/prod/_data", "Destination": "/data", "Type": "volume", "RW": True}]
        for c in (s, p, sd, pd):
            self.objects[c["Id"]] = c

    def obj(self, name):
        for value in self.objects.values():
            if value["Id"] == name or value["Name"] == "/" + name:
                return value
        raise r.Refusal("inspect_failed")

    def inspect(self, name):
        return copy.deepcopy(self.obj(name))

    def network(self, name):
        return {"Id": r.NETWORK_ID if name == r.NETWORK else "bridge-id", "Containers": {x["Id"]: {"Name": x["Name"].lstrip("/"),
                                          "IPv4Address": x["NetworkSettings"]["Networks"][name]["IPAddress"] + "/16"}
                               for x in self.objects.values() if name in x["NetworkSettings"]["Networks"]}}

    def health(self, url):
        name = r.STAGING if url == r.STAGING_HEALTH else r.PRODUCTION
        c = self.obj(name)
        if not c["State"]["Running"]:
            raise r.Refusal("health_unavailable")
        digest = NEW_HASH if c["Id"] == NEW_ID else r.BASE_HASH
        if c["Id"] == NEW_ID and self.bad_health:
            digest = "0" * 64
        return {"ok": True, "db": True, "source": {"sha256": digest}}

    def candidate(self, repo, sha):
        if sha != SHA:
            raise r.Refusal("full_commit_sha_required")
        return {"sha": sha, "repo": str(repo)}

    def build(self, repo, sha, tag):
        self.commands.append(("build", tag))
        if self.fail == "build":
            raise r.Refusal("candidate_build_failed")
        if self.production_drift_at == "build":
            self.obj(r.PRODUCTION)["State"]["Pid"] += 1
        return {"imageId": NEW_IMAGE, "bundleHash": NEW_HASH, "archiveHash": "9" * 64}

    def docker(self, *args):
        self.commands.append(args)
        op = args[0]
        if self.fail == op:
            self.fail = None
            raise r.Refusal("injected_" + op + "_failure")
        if op == "create":
            c = copy.deepcopy(self.obj(r.STAGING_ID))
            c.update(Id=NEW_ID, Image=NEW_IMAGE, Name="/" + args[args.index("--name") + 1])
            c["State"] = {"Running": False, "StartedAt": "", "Pid": 0}
            env = {**r.environment(c), **r.PROOF_ENV}
            if self.env_drift:
                env["DATABASE_URL"] += "-changed"
            c["Config"]["Env"] = [k + "=" + v for k, v in env.items()]
            if self.config_drift:
                c["HostConfig"]["Privileged"] = True
            self.objects[NEW_ID] = c
            return NEW_ID.encode()
        target = args[-1] if op in ("stop", "start") else args[1]
        c = self.obj(target)
        if op == "stop":
            c["State"]["Running"] = False
            c["State"]["Pid"] = 0
        elif op == "rename":
            require_unused = [x for x in self.objects.values() if x["Name"] == "/" + args[2]]
            if require_unused:
                raise r.Refusal("name_already_used")
            c["Name"] = "/" + args[2]
            for value in c["NetworkSettings"]["Networks"].values():
                value["DNSNames"] = [args[2]]
        elif op == "start":
            if c["Id"] == r.STAGING_ID and self.rollback_start_failure:
                raise r.Refusal("rollback_start_failed")
            c["State"].update(Running=True, Pid=456)
            if c["Id"] == NEW_ID and self.production_drift_at == "start":
                self.obj(r.PRODUCTION)["State"]["Pid"] += 1
        else:
            raise AssertionError("unanticipated mutating command: " + repr(args))
        return b"ok"


class RolloutTests(unittest.TestCase):
    def setUp(self):
        self.host = patch.object(r.socket, "gethostname", return_value=r.HOST)
        self.sleep = patch.object(r.time, "sleep")
        self.host.start()
        self.sleep.start()
        self.addCleanup(self.host.stop)
        self.addCleanup(self.sleep.stop)
        self.backend = Fake()
        self.records = []

    def writer(self, path, record):
        snapshot = copy.deepcopy(record)
        self.assertNotIn(SECRET, json.dumps(snapshot))
        self.records.append(snapshot)

    def deploy(self):
        return r.deploy(self.backend, Path("/fixed/runtime"), SHA, NEW_HASH, Path("/fake/receipt.json"), writer=self.writer)

    def assert_production_never_mutated(self):
        for command in self.backend.commands:
            if command[0] in ("stop", "start", "rename", "rm", "kill", "update"):
                self.assertNotIn(r.PRODUCTION_ID, command)
                self.assertNotIn(r.PRODUCTION, command)
            self.assertNotIn(command[0], ("rm", "image", "system", "prune"))

    def test_success_retains_original_and_adds_only_exact_proof_env(self):
        prod = r.identity(self.backend.inspect(r.PRODUCTION))
        result = self.deploy()
        self.assertEqual(result["phase"], "staged")
        self.assertEqual(self.backend.obj(r.STAGING)["Id"], NEW_ID)
        self.assertFalse(self.backend.obj(r.STAGING_ID)["State"]["Running"])
        self.assertEqual(r.identity(self.backend.inspect(r.PRODUCTION)), prod)
        self.assertEqual(r.environment(self.backend.obj(NEW_ID)), {**r.environment(self.backend.obj(r.STAGING_ID)), **r.PROOF_ENV})
        self.assertEqual(result["candidate"]["bundleHash"], NEW_HASH)
        self.assert_production_never_mutated()

    def test_wrong_host_refuses_without_build(self):
        with patch.object(r.socket, "gethostname", return_value="another-host"):
            with self.assertRaisesRegex(r.Refusal, "host_pin_mismatch"):
                self.deploy()
        self.assertEqual(self.backend.commands, [])

    def test_stale_container_image_port_network_and_conflicting_origin_refuse(self):
        changes = [lambda s: s.update(Image="different"),
                   lambda s: s["HostConfig"]["PortBindings"].update({"9000/tcp": [{"HostIp": "0.0.0.0", "HostPort": "9000"}]}),
                   lambda s: s["NetworkSettings"]["Networks"][r.NETWORK].update(NetworkID="different"),
                   lambda s: s["Config"]["Env"].append("PUBLIC_URL=https://runtime.meshtool.ai")]
        for change in changes:
            with self.subTest(change=change):
                self.backend = Fake()
                change(self.backend.obj(r.STAGING_ID))
                with self.assertRaises(r.Refusal):
                    self.deploy()
                self.assertEqual(self.backend.commands, [])

    def test_unresolved_database_alias_refuses(self):
        self.backend.obj("1" * 64)["NetworkSettings"]["Networks"][r.NETWORK]["Aliases"] = []
        with self.assertRaisesRegex(r.Refusal, "database_target_not_unique"):
            self.deploy()
        self.assertEqual(self.backend.commands, [])

    def test_database_url_query_or_fragment_refuses_before_build(self):
        for suffix in ("?host=production-db", "?sslmode=require", "#hidden"):
            with self.subTest(suffix=suffix):
                self.backend = Fake()
                c = self.backend.obj(r.STAGING_ID)
                c["Config"]["Env"] = [x + suffix if x.startswith("DATABASE_URL=") else x for x in c["Config"]["Env"]]
                with self.assertRaisesRegex(r.Refusal, "database_url_shape_refused"):
                    self.deploy()
                self.assertEqual(self.backend.commands, [])

    def test_shared_writable_database_storage_refuses(self):
        self.backend.obj("1" * 64)["Mounts"][0]["Source"] = "/var/lib/docker/volumes/prod/_data/inside"
        with self.assertRaisesRegex(r.Refusal, "database_isolation_refused"):
            self.deploy()
        self.assertEqual(self.backend.commands, [])

    def test_environment_or_security_config_drift_refuses_before_old_stop(self):
        for attr in ("env_drift", "config_drift"):
            with self.subTest(attr=attr):
                self.backend = Fake()
                setattr(self.backend, attr, True)
                with self.assertRaisesRegex(r.Refusal, "refused_before_activation"):
                    self.deploy()
                self.assertTrue(self.backend.obj(r.STAGING_ID)["State"]["Running"])
                self.assertNotIn("stop", [c[0] for c in self.backend.commands])

    def test_build_failure_does_not_stop_original(self):
        self.backend.fail = "build"
        with self.assertRaisesRegex(r.Refusal, "refused_before_activation"):
            self.deploy()
        self.assertTrue(self.backend.obj(r.STAGING_ID)["State"]["Running"])
        self.assertEqual([c[0] for c in self.backend.commands], ["build"])

    def test_image_hash_must_match_independently_tested_bundle_before_create(self):
        with self.assertRaisesRegex(r.Refusal, "refused_before_activation:image_differs_from_tested_bundle"):
            r.deploy(self.backend, Path("/repo"), SHA, "b" * 64, Path("/fake/receipt"), writer=self.writer)
        self.assertEqual([c[0] for c in self.backend.commands], ["build"])
        self.assertTrue(self.backend.obj(r.STAGING_ID)["State"]["Running"])

    def test_candidate_database_mapping_change_refuses(self):
        original = r.database_target(self.backend, self.backend.inspect(r.STAGING))
        self.backend.obj("1" * 64)["NetworkSettings"]["Networks"][r.NETWORK]["IPAddress"] = "172.18.0.9"
        with self.assertRaisesRegex(r.Refusal, "candidate_database_target_changed"):
            r.assert_candidate_database(self.backend, self.backend.inspect(r.STAGING), original, started=True)

    def test_network_name_rebound_refuses(self):
        network = self.backend.network
        self.backend.network = lambda name: {**network(name), "Id": "replacement-network"}
        with self.assertRaisesRegex(r.Refusal, "network_name_rebound"):
            self.deploy()
        self.assertEqual(self.backend.commands, [])

    def test_recovery_covers_every_checkpoint_after_original_may_have_stopped(self):
        for checkpoint in ("stopping_original", "original_retained", "starting_candidate", "staged", "rollback_started"):
            with self.subTest(checkpoint=checkpoint):
                self.backend = Fake()
                record = self.deploy()
                record["phase"] = checkpoint
                self.assertIn(checkpoint, r.RECOVERABLE)
                if checkpoint == "stopping_original":
                    # Simulate a kill between stop and rename: original owns the public name.
                    self.backend.obj(NEW_ID)["Name"] = "/" + record["candidateName"]
                    self.backend.obj(NEW_ID)["State"]["Running"] = False
                    self.backend.obj(r.STAGING_ID)["Name"] = "/" + r.STAGING
                elif checkpoint == "original_retained":
                    # Name is temporarily free; no command may assume it exists.
                    self.backend.obj(NEW_ID)["Name"] = "/" + record["candidateName"]
                    self.backend.obj(NEW_ID)["State"]["Running"] = False
                r.restore(self.backend, record)
                self.assertEqual(self.backend.obj(r.STAGING)["Id"], r.STAGING_ID)
                self.assertTrue(self.backend.obj(r.STAGING_ID)["State"]["Running"])
                self.assert_production_never_mutated()

    def test_failed_health_restores_exact_original_and_retains_failed_candidate(self):
        self.backend.bad_health = True
        with self.assertRaisesRegex(r.Refusal, "failed_restored"):
            self.deploy()
        self.assertEqual(self.backend.obj(r.STAGING)["Id"], r.STAGING_ID)
        self.assertTrue(self.backend.obj(r.STAGING_ID)["State"]["Running"])
        self.assertFalse(self.backend.obj(NEW_ID)["State"]["Running"])
        self.assertIn("failed-proof", self.backend.obj(NEW_ID)["Name"])
        self.assertEqual(self.records[-1]["phase"], "failed_restored")
        self.assert_production_never_mutated()

    def test_stop_rename_and_start_failures_restore_original(self):
        for operation in ("stop", "rename", "start"):
            with self.subTest(operation=operation):
                self.backend = Fake()
                self.backend.fail = operation
                with self.assertRaisesRegex(r.Refusal, "failed_restored"):
                    self.deploy()
                self.assertEqual(self.backend.obj(r.STAGING)["Id"], r.STAGING_ID)
                self.assertTrue(self.backend.obj(r.STAGING_ID)["State"]["Running"])
                self.assert_production_never_mutated()

    def test_prod_drift_during_build_refuses_before_staging_stop(self):
        self.backend.production_drift_at = "build"
        with self.assertRaisesRegex(r.Refusal, "refused_before_activation:production_identity_changed"):
            self.deploy()
        self.assertNotIn("stop", [c[0] for c in self.backend.commands])

    def test_prod_drift_after_activation_reports_uncertain_without_prod_action(self):
        self.backend.production_drift_at = "start"
        with self.assertRaisesRegex(r.Refusal, "uncertain_manual_recovery_required"):
            self.deploy()
        self.assertEqual(self.backend.obj(r.STAGING)["Id"], r.STAGING_ID)
        self.assert_production_never_mutated()

    def test_failed_rollback_is_uncertain_never_claimed_complete(self):
        self.backend.bad_health = True
        self.backend.rollback_start_failure = True
        with self.assertRaisesRegex(r.Refusal, "uncertain_manual_recovery_required"):
            self.deploy()
        self.assertEqual(self.records[-1]["phase"], "uncertain_manual_recovery_required")
        self.assertNotIn("productionUnchanged", self.records[-1])
        self.assert_production_never_mutated()

    def test_manual_restore_retains_candidate_and_protects_prod_id(self):
        # Recovery reads JSON from disk, not the in-process record: identity must
        # remain comparable after the serialization boundary.
        record = json.loads(json.dumps(self.deploy()))
        r.assert_production_unchanged(self.backend, record["productionBefore"])
        r.restore(self.backend, record)
        self.assertEqual(self.backend.obj(r.STAGING)["Id"], r.STAGING_ID)
        self.assertFalse(self.backend.obj(NEW_ID)["State"]["Running"])
        record["candidateContainerId"] = r.PRODUCTION_ID
        with self.assertRaisesRegex(r.Refusal, "rollback_candidate_refused"):
            r.restore(self.backend, record)
        self.assert_production_never_mutated()

    def test_unexpected_error_text_is_not_written_to_receipt(self):
        self.backend.build = lambda *_: (_ for _ in ()).throw(RuntimeError(SECRET))
        with self.assertRaisesRegex(r.Refusal, "unexpected_failure_details_suppressed") as caught:
            self.deploy()
        self.assertNotIn(SECRET, str(caught.exception))


class BoundaryTests(unittest.TestCase):
    def test_default_cli_is_read_only_and_never_locks_builds_or_writes(self):
        backend = Fake()
        output = io.StringIO()
        with patch.object(r, "Backend", return_value=backend), \
             patch.object(r.os, "geteuid", return_value=0), \
             patch.object(r.socket, "gethostname", return_value=r.HOST), \
             patch.object(r.sys, "version_info", (3, 12, 3)), \
             patch.object(r.sys, "argv", ["helper", "--sha", SHA, "--expected-bundle-sha256", NEW_HASH]), \
             patch.object(r.signal, "signal"), \
             patch.object(r, "locks", side_effect=AssertionError("read-only mode must not lock")), \
             patch.object(r, "save_receipt", side_effect=AssertionError("read-only mode must not write")), \
             contextlib.redirect_stdout(output):
            r.main()
        self.assertEqual(json.loads(output.getvalue())["outcome"], "read_only_plan")
        self.assertEqual(backend.commands, [])
        self.assertNotIn(SECRET, output.getvalue())

    def test_apply_without_independently_tested_hash_is_refused_before_any_command(self):
        backend = Fake()
        with patch.object(r, "Backend", return_value=backend), \
             patch.object(r.os, "geteuid", return_value=0), \
             patch.object(r.socket, "gethostname", return_value=r.HOST), \
             patch.object(r.sys, "version_info", (3, 12, 3)), \
             patch.object(r.sys, "argv", ["helper", "--sha", SHA, "--apply"]), \
             patch.object(r.signal, "signal"):
            with self.assertRaisesRegex(r.Refusal, "tested_bundle_hash_required"):
                r.main()
        self.assertEqual(backend.commands, [])

    def test_busy_second_lock_refuses_and_releases_first(self):
        with tempfile.TemporaryDirectory() as directory:
            names = [str(Path(directory) / x) for x in ("deploy.lock", "watchdog.lock")]
            fd = os.open(names[1], os.O_CREAT | os.O_RDWR, 0o600)
            r.fcntl.flock(fd, r.fcntl.LOCK_EX | r.fcntl.LOCK_NB)
            try:
                with patch.object(r, "LOCKS", names):
                    with self.assertRaisesRegex(r.Refusal, "deployment_lock_busy"):
                        with r.locks():
                            self.fail("entered with busy watchdog lock")
                first = os.open(names[0], os.O_RDWR)
                try:
                    r.fcntl.flock(first, r.fcntl.LOCK_EX | r.fcntl.LOCK_NB)
                finally:
                    os.close(first)
            finally:
                os.close(fd)

    def test_symlink_lock_refuses(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "target"
            target.write_text("preserve")
            link = Path(directory) / "link"
            link.symlink_to(target)
            with patch.object(r, "LOCKS", [str(link)]):
                with self.assertRaises(OSError):
                    with r.locks():
                        self.fail("entered symlink lock")
            self.assertEqual(target.read_text(), "preserve")

    def test_unsafe_archive_member_refused_before_build(self):
        for kind in ("traversal", "symlink"):
            with self.subTest(kind=kind):
                data = io.BytesIO()
                with tarfile.open(fileobj=data, mode="w") as tar:
                    item = tarfile.TarInfo("../../escape" if kind == "traversal" else "link")
                    if kind == "symlink":
                        item.type = tarfile.SYMTYPE
                        item.linkname = "/etc"
                    tar.addfile(item)
                backend = r.Backend()
                calls = []
                def run(args, **kw):
                    calls.append(args)
                    if "archive" in args:
                        return data.getvalue()
                    if "get-tar-commit-id" in args:
                        return SHA.encode()
                    raise AssertionError("build should not run")
                backend.run = run
                with self.assertRaisesRegex(r.Refusal, "unsafe_archive_member"):
                    backend.build(Path("/repo"), SHA, "tag")
                self.assertFalse(any(x[0] == "docker" for x in calls))

    def test_recipe_change_refuses_and_no_fetch_or_checkout_is_attempted(self):
        backend = r.Backend()
        calls = []
        def run(args, **kw):
            calls.append(args)
            return {"repo_origin": b"git@github.com:RightOnPar-LLC/creator-os-runtime.git",
                    "commit_lookup": b"commit", "recipe_lookup": b"wrong"}[kw["label"]]
        backend.run = run
        with self.assertRaisesRegex(r.Refusal, "reviewed_build_recipe_changed"):
            backend.candidate(Path("/repo"), SHA)
        self.assertFalse(any(set(x) & {"fetch", "checkout", "pull", "merge"} for x in calls))

    def test_receipt_is_private_and_contains_no_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipts" / "proof.json"
            r.save_receipt(path, {"kind": r.KIND, "phase": "staged"})
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(path.read_text())["phase"], "staged")
            self.assertFalse(path.with_suffix(".pending").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
