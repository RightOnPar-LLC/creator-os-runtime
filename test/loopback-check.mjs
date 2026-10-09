#!/usr/bin/env node
// Can this machine reach its own loopback listeners from every client port?
//
//   node test/loopback-check.mjs          4096 client ports on 127.0.0.1 (a few seconds)
//   node test/loopback-check.mjs --v6     the same on ::1
//   node test/loopback-check.mjs --all    every port from 1024 up (a minute or two)
//
// One listener stays up on a port the OS picks. For every port S in the range the check binds S as the
// CLIENT's own port and connects once. Nothing leaves the machine. Exit 0: every port that could be
// bound got through. Exit 1: some did not, and their ranges are printed.
//
// WHY THIS EXISTS (measured 2026-10-09 on a Windows 11 box). The suite failed in bursts on unchanged
// code: the database connection refused at boot ("36 pass, 1 fail"), or dozens of tests timing out
// with ConnectionRefused to the harness's own listener. What was found:
//   * Connections to 127.0.0.1 and ::1 whose CLIENT port was 0x?500-0x?5ff (256 ports in every 4096)
//     timed out about three times in four, to any listener, including ones that had been up for
//     minutes. Every other client port was fine. The same client ports to a non-loopback address
//     (the box's own tailnet address, a host on the internet) were fine too.
//   * Windows hands client ports out in rising order from one pointer shared by every process. So
//     everything on the box failed together while that pointer was inside such a stretch, and for
//     longer the less traffic there was to move it on (a quiet box: about 90 seconds).
//   * A connection waiting to fail made unrelated loopback connections fail beside it.
//   * node reports the failure as ETIMEDOUT after about 300 ms; bun reports the same event as
//     ECONNREFUSED / ConnectionRefused.
//   * Not the cause: excluded port ranges (the OS never hands those out), the widened dynamic port
//     range, a busy core, ports left in TIME_WAIT, the test harness.
//   * The box ran WSL2 with networkingMode=mirrored, which shares 127.0.0.1 with the Linux side, and
//     WSL was failing every command at the time. Whether that is the cause was NOT confirmed.
// harness.js rides through it (a refused connection is asked again, and the run says so at the end).
// This file tells you whether a machine is in that state, before and after whatever is tried on it.
import net from "node:net";

const args = process.argv.slice(2);
const host = args.includes("--v6") ? "::1" : "127.0.0.1";
// 0x7000-0x7fff by default: below the usual dynamic port ranges, so the check competes with nobody
const [from, to] = args.includes("--all") ? [1024, 65535] : [0x7000, 0x7fff];

const srv = net.createServer((c) => c.destroy());
await new Promise((res, rej) => (srv.once("error", rej), srv.listen(0, host, res)));
const listenPort = srv.address().port;

const dial = (S) =>
  new Promise((resolve) => {
    let done = false;
    const s = net.connect({ host, port: listenPort, localAddress: host, localPort: S });
    const fin = (o) => done || ((done = true), s.destroy(), resolve(o));
    s.setTimeout(5000, () => fin("TIMEOUT"));
    s.once("connect", () => fin("ok"));
    s.once("error", (e) => fin(e.code || String(e.message)));
  });

const outcome = new Map();
let next = from;
await Promise.all(
  Array.from({ length: 32 }, async () => {
    for (let S = next++; S <= to; S = next++) if (S !== listenPort) outcome.set(S, await dial(S));
  }),
);
srv.close();

const UNBOUND = new Set(["EADDRINUSE", "EACCES"]); // somebody else's port, or one the OS keeps back
const tried = [...outcome].filter(([, o]) => !UNBOUND.has(o));
const lost = tried.filter(([, o]) => o !== "ok");
console.log(`loopback ${host}: ${tried.length} client ports (${from}-${to}) tried against a listener on port ${listenPort}`);
console.log(`  reached it: ${tried.length - lost.length}   did not: ${lost.length}   not tried (in use or kept back by the OS): ${outcome.size - tried.length}`);
if (!lost.length) {
  console.log("OK: this machine's loopback answered from every client port.");
  process.exit(0);
}
// ranges of lost ports, joining ports that are less than 16 apart
const ranges = [];
for (const [S, o] of lost) {
  const r = ranges[ranges.length - 1];
  if (r && S - r.b < 16) (r.b = S), r.n++, r.how.add(o);
  else ranges.push({ a: S, b: S, n: 1, how: new Set([o]) });
}
for (const r of ranges.slice(0, 40)) console.log(`  ${r.a}-${r.b} (0x${r.a.toString(16)}-0x${r.b.toString(16)}): ${r.n} of ${r.b - r.a + 1} lost, ${[...r.how].join("/")}`);
if (ranges.length > 40) console.log(`  ... and ${ranges.length - 40} more ranges`);
console.log("FAULT: a listener that was up could not be reached from those client ports. Tests that fail with");
console.log("'connection refused' on this machine are the machine. See the notes at the top of this file.");
process.exit(1);
