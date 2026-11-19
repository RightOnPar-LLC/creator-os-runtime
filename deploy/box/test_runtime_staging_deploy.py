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
STAGING_DB_ID = r.DB_PINS["staging"]["id"]
PRODUCTION_DB_ID = r.DB_PINS["production"]["id"]


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
        "NetworkSettings": {"Networks": {network: {"NetworkID": r.NETWORK_ID if network == r.NETWORK else r.DB_PINS["production"]["networkId"],
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
        self.env_drift_during_observation = False
        self.db_drift_during_observation = False
        self.socket_loss_after_activation = False
        self.socket_loss_before_activation = False
        self.socket_observations = []
        s = container(r.STAGING_ID, r.STAGING, r.NETWORK, "172.18.0.3", r.PORTS,
                      {"NODE_ENV": "production", "DATABASE_URL": "postgres://user:" + SECRET + "@staging-db-alias/db"})
        p = container(r.PRODUCTION_ID, r.PRODUCTION, "bridge", r.PRODUCTION_ADDRESS,
                      {"3000/tcp": [{"HostIp": "100.85.34.93", "HostPort": "18081"}]},
                      {"NODE_ENV": "production", "DATABASE_URL": "postgres://user:" + SECRET + "@unresolved-old-db/db",
                       **{"PUBLIC_FIXTURE_" + str(i): "fixture" for i in range(26)}})
        p["Config"]["Env"].append("DATABASE_URL=postgres://user:" + SECRET + "@pg/db")
        p["State"].update(Pid=r.PRODUCTION_PID, StartedAt=r.PRODUCTION_STARTED)
        p["HostConfig"]["Links"] = ["/production-db:/own-rails-runtime-prod/pg"]
        sd = container(STAGING_DB_ID, "staging-db", r.NETWORK, r.DB_PINS["staging"]["address"], {}, {},
                       image=r.DB_PINS["staging"]["image"])
        sd["NetworkSettings"]["Networks"][r.NETWORK]["Aliases"] = ["staging-db-alias"]
        sd["Mounts"] = [{"Name": r.DB_PINS["staging"]["volume"], "Source": r.DB_PINS["staging"]["source"],
                         "Destination": "/var/lib/postgresql", "Type": "volume", "RW": True}]
        pd = container(PRODUCTION_DB_ID, "production-db", "bridge", r.DB_PINS["production"]["address"], {}, {},
                       image=r.DB_PINS["production"]["image"])
        pd["Mounts"] = [{"Name": r.DB_PINS["production"]["volume"], "Source": r.DB_PINS["production"]["source"],
                         "Destination": "/var/lib/postgresql", "Type": "volume", "RW": True}]
        for c in (s, p, sd, pd):
            self.objects[c["Id"]] = c
        self.volumes = {pin["volume"]: {"Name": pin["volume"], "Driver": "local", "Options": None,
                                        "Mountpoint": pin["source"], "Scope": "local"} for pin in r.DB_PINS.values()}
        self.sockets = [{"local": (r.PRODUCTION_ADDRESS, 43123),
                         "peer": (r.DB_PINS["production"]["address"], 5432), "owners": {r.PRODUCTION_PID}}]

    def obj(self, name):
        for value in self.objects.values():
            if value["Id"] == name or value["Name"] == "/" + name:
                return value
        raise r.Refusal("inspect_failed")

    def inspect(self, name):
        return copy.deepcopy(self.obj(name))

    def network(self, name):
        return {"Id": r.NETWORK_ID if name == r.NETWORK else r.DB_PINS["production"]["networkId"], "Containers": {x["Id"]: {"Name": x["Name"].lstrip("/"),
                                          "IPv4Address": x["NetworkSettings"]["Networks"][name]["IPAddress"] + "/16"}
                               for x in self.objects.values() if name in x["NetworkSettings"]["Networks"]}}

    def volume(self, name):
        return copy.deepcopy(self.volumes[name])

    def production_sockets(self, pid):
        if pid != r.PRODUCTION_PID:
            raise AssertionError("wrong process inspected")
        self.socket_observations.append({"candidateExists": NEW_ID in self.objects,
                                         "candidateRunning": NEW_ID in self.objects and self.obj(NEW_ID)["State"]["Running"],
                                         "originalRunning": self.obj(r.STAGING_ID)["State"]["Running"]})
        if self.env_drift_during_observation:
            self.obj(r.PRODUCTION)["Config"]["Env"][0] += "-changed"
        if self.db_drift_during_observation:
            self.obj(PRODUCTION_DB_ID)["Mounts"][0]["Source"] += "-changed"
        if NEW_ID in self.objects:
            if self.socket_loss_after_activation and self.obj(NEW_ID)["State"]["Running"]:
                return []
            if self.socket_loss_before_activation and not self.obj(NEW_ID)["State"]["Running"]:
                return []
        return copy.deepcopy(self.sockets)

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
        self.assertEqual(result["databaseIsolation"]["productionDatabaseEvidence"], "owned_established_sockets")
        self.assertEqual(result["databaseIsolationAfter"]["productionDatabaseEvidence"], "owned_established_sockets")
        self.assertNotIn("normalizedTargetsDistinct", json.dumps(result))
        self.assertIn({"candidateExists": True, "candidateRunning": False, "originalRunning": True}, self.backend.socket_observations)
        self.assertIn({"candidateExists": True, "candidateRunning": True, "originalRunning": False}, self.backend.socket_observations)
        self.assert_production_never_mutated()

    def test_missing_or_foreign_or_multiple_production_socket_peers_refuse_before_build(self):
        correct = copy.deepcopy(self.backend.sockets[0])
        cases = [[], [{**correct, "owners": {r.PRODUCTION_PID + 1}}],
                 [{**correct, "owners": {r.PRODUCTION_PID, r.PRODUCTION_PID + 1}}],
                 [{**correct, "peer": ("172.17.0.99", 5432)}],
                 [correct, {**correct, "peer": ("172.17.0.99", 5432)}],
                 [{**correct, "local": ("172.18.0.3", 43123)}]]
        for sockets in cases:
            with self.subTest(sockets=sockets):
                self.backend = Fake()
                self.backend.sockets = sockets
                with self.assertRaises(r.Refusal):
                    self.deploy()
                self.assertEqual(self.backend.commands, [])

    def test_production_pid_start_or_restart_drift_refuses(self):
        for mutate in (lambda p: p["State"].update(Pid=r.PRODUCTION_PID + 1),
                       lambda p: p["State"].update(StartedAt="2026-11-19T00:00:00Z"),
                       lambda p: p.update(RestartCount=1)):
            with self.subTest(mutate=mutate):
                self.backend = Fake()
                mutate(self.backend.obj(r.PRODUCTION))
                with self.assertRaisesRegex(r.Refusal, "production_process_pin_mismatch"):
                    self.deploy()
                self.assertEqual(self.backend.commands, [])

    def test_production_raw_environment_drift_during_observation_refuses(self):
        self.backend.env_drift_during_observation = True
        with self.assertRaisesRegex(r.Refusal, "production_environment_changed"):
            self.deploy()
        self.assertEqual(self.backend.commands, [])

    def test_production_raw_environment_drift_between_observations_refuses(self):
        production = self.backend.inspect(r.PRODUCTION)
        raw = r.production_environment_snapshot(production)
        # Identity and shape remain the same; full raw array comparison catches it.
        self.backend.obj(r.PRODUCTION)["Config"]["Env"][0] += "-changed"
        with self.assertRaisesRegex(r.Refusal, "production_environment_changed"):
            r.assert_production_unchanged(self.backend, r.identity(production), raw)

    def test_database_peer_storage_changed_during_socket_observation_refuses(self):
        self.backend.db_drift_during_observation = True
        with self.assertRaisesRegex(r.Refusal, "production_database_storage_changed"):
            self.deploy()
        self.assertEqual(self.backend.commands, [])

    def test_production_database_identity_network_address_volume_and_running_pins(self):
        mutations = [lambda b: b.obj(PRODUCTION_DB_ID).update(Image="different"),
                     lambda b: b.obj(PRODUCTION_DB_ID)["State"].update(Running=False),
                     lambda b: b.obj(PRODUCTION_DB_ID)["NetworkSettings"]["Networks"]["bridge"].update(NetworkID="changed"),
                     lambda b: b.obj(PRODUCTION_DB_ID)["NetworkSettings"]["Networks"]["bridge"].update(IPAddress="172.17.0.99"),
                     lambda b: b.obj(PRODUCTION_DB_ID)["Mounts"][0].update(Source="/different"),
                     lambda b: b.volumes[r.DB_PINS["production"]["volume"]].update(Options={"remote": "unapproved"})]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                self.backend = Fake()
                mutate(self.backend)
                with self.assertRaises(r.Refusal):
                    self.deploy()
                self.assertEqual(self.backend.commands, [])

    def test_duplicate_docker_address_is_not_a_unique_peer(self):
        other = copy.deepcopy(self.backend.obj(PRODUCTION_DB_ID))
        other["Id"] = "7" * 64
        self.backend.objects[other["Id"]] = other
        with self.assertRaisesRegex(r.Refusal, "production_database_address_not_unique"):
            self.deploy()
        self.assertEqual(self.backend.commands, [])

    def test_vanished_sockets_immediately_before_stop_refuse_without_stop(self):
        self.backend.socket_loss_before_activation = True
        with self.assertRaisesRegex(r.Refusal, "refused_before_activation:production_postgres_sockets_absent"):
            self.deploy()
        self.assertTrue(self.backend.obj(r.STAGING_ID)["State"]["Running"])
        self.assertNotIn("stop", [c[0] for c in self.backend.commands])

    def test_vanished_sockets_after_candidate_health_restore_original(self):
        self.backend.socket_loss_after_activation = True
        with self.assertRaisesRegex(r.Refusal, "failed_restored:production_postgres_sockets_absent"):
            self.deploy()
        self.assertEqual(self.backend.obj(r.STAGING)["Id"], r.STAGING_ID)
        self.assertTrue(self.backend.obj(r.STAGING_ID)["State"]["Running"])
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
        self.backend.obj(STAGING_DB_ID)["NetworkSettings"]["Networks"][r.NETWORK]["Aliases"] = []
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
        self.backend.obj(STAGING_DB_ID)["Mounts"][0]["Source"] = r.DB_PINS["production"]["source"] + "/inside"
        with self.assertRaisesRegex(r.Refusal, "staging_database_storage_changed"):
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
        self.backend.obj(STAGING_DB_ID)["NetworkSettings"]["Networks"][r.NETWORK]["IPAddress"] = "172.18.0.9"
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
    def test_production_exception_does_not_relax_general_environment_parser(self):
        backend = Fake()
        with self.assertRaisesRegex(r.Refusal, "environment_conflicting_duplicate"):
            r.environment(backend.inspect(r.PRODUCTION))
        raw = r.production_environment_snapshot(backend.inspect(r.PRODUCTION))
        self.assertEqual(raw, backend.obj(r.PRODUCTION)["Config"]["Env"])

    def test_production_exception_requires_only_the_exact_observed_duplicate_shape(self):
        for mutate in (lambda raw: raw.append("EXTRA=value"),
                       lambda raw: raw.__setitem__(2, "NODE_ENV=other"),
                       lambda raw: raw.__setitem__(-1, raw[1])):
            with self.subTest(mutate=mutate):
                backend = Fake()
                mutate(backend.obj(r.PRODUCTION)["Config"]["Env"])
                with self.assertRaisesRegex(r.Refusal, "production_environment_shape_refused"):
                    r.production_environment_snapshot(backend.inspect(r.PRODUCTION))

    def test_socket_parser_extracts_endpoints_and_owner_without_raw_line(self):
        line = '0 0 172.17.0.5:43123 172.17.0.3:5432 users:(("bun",pid=700646,fd=12))'
        rows = r.parse_postgres_sockets(line)
        self.assertEqual(rows, [{"local": ("172.17.0.5", 43123), "peer": ("172.17.0.3", 5432), "owners": {700646}}])
        self.assertNotIn("users:", repr(rows))

    def test_socket_parser_refuses_empty_unowned_wrong_port_or_malformed_rows(self):
        for text in ("", "garbage", "0 0 172.17.0.5:43123 172.17.0.3:5432",
                     '0 0 172.17.0.5:43123 172.17.0.3:9999 users:(("bun",pid=700646,fd=12))'):
            with self.subTest(text=text):
                with self.assertRaises(r.Refusal):
                    r.parse_postgres_sockets(text)

    def test_only_byte_identical_duplicate_environment_entries_are_equivalent(self):
        c = {"Config": {"Env": ["A=value=with=equals", "B=", "A=value=with=equals", "B="]}}
        self.assertEqual(r.environment(c), {"A": "value=with=equals", "B": ""})
        for entries in (["A=value", "A=value "], ["A=value", "A=VALUE"],
                        ["A=first", "A=second"], ["DATABASE_URL=one", "DATABASE_URL=two"]):
            with self.subTest(entries=entries):
                with self.assertRaisesRegex(r.Refusal, "environment_conflicting_duplicate"):
                    r.environment({"Config": {"Env": entries}})

    def test_malformed_environment_entries_are_not_normalized_away(self):
        for entries in (["NO_EQUALS"], ["=empty-key"]):
            with self.assertRaisesRegex(r.Refusal, "environment_shape_refused"):
                r.environment({"Config": {"Env": entries}})

    def test_unexpected_production_duplicate_shape_still_blocks_the_plan(self):
        backend = Fake()
        backend.obj(r.PRODUCTION)["Config"]["Env"].append("DATABASE_URL=postgres://different@pg/other")
        with patch.object(r.socket, "gethostname", return_value=r.HOST):
            with self.assertRaisesRegex(r.Refusal, "production_environment_shape_refused"):
                r.baseline(backend)
        self.assertEqual(backend.commands, [])

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
