#!/usr/bin/env node
/**
 * Regression test for the progress heartbeat (bridge 1.3.0).
 *
 * The bug it guards: a real `delegate` runs for minutes, an MCP client's
 * per-request timeout is typically 60s, and the bridge emitted nothing in the
 * meantime — so every substantial delegation returned `Error: Request timed out`
 * to the caller while the `agy` process carried on editing the repo. The work
 * landed, the caller was told it had failed, and the digest was lost. That is
 * worse than a plain failure, because the caller cannot tell the two apart.
 *
 * The fix is `notifications/progress`: a client that wants them puts a
 * `progressToken` in `params._meta`, and each notification carrying that token
 * resets the client's timeout for that request.
 *
 * What this asserts, against a real spawned server over stdio:
 *   1. the JSON-RPC stream stays well formed (one parseable object per line) —
 *      a notification written carelessly would corrupt every later response;
 *   2. the tool still returns its normal result;
 *   3. notifications arrive for a long call, carrying the exact token the
 *      client sent, with monotonically increasing `progress`;
 *   4. a client that sends NO progressToken receives no notifications, so this
 *      cannot regress a client that does not want them.
 *
 * It needs no agy install and makes no model call: AGY_BIN points at a shell
 * stub that just sleeps. On Windows that stub has to run through WSL, because
 * node refuses to spawn a .cmd with shell:false — which is what the bridge uses.
 *
 * Usage:
 *   node test/progress-heartbeat.mjs [path/to/agy-bridge.mjs]
 *   WSL_DISTRO=Ubuntu-24.04 node test/progress-heartbeat.mjs
 */

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = process.argv[2] || path.join(HERE, "..", "agy-bridge.mjs");

// Drive the heartbeat far faster than the 10s default so the test is quick.
const INTERVAL_MS = 400;
const STUB_SLEEP_S = 3;
const EXPECTED_BEATS = 3; // ~3s / 400ms, less a generous margin

const WSL_DISTRO = process.env.WSL_DISTRO || (process.platform === "win32" ? "Ubuntu-26.04" : "");

let agyBin;
let allowedRoots;
if (WSL_DISTRO) {
  // Write the stub inside WSL; the bridge will invoke it through `bash -lc`.
  const script = `#!/bin/sh\nsleep ${STUB_SLEEP_S}\necho done\n`;
  const b64 = Buffer.from(script, "utf8").toString("base64");
  const r = spawn("wsl.exe", [
    "-d", WSL_DISTRO, "--", "bash", "-lc",
    `echo ${b64} | base64 -d > /tmp/agy-bridge-test-stub.sh; chmod +x /tmp/agy-bridge-test-stub.sh`,
  ]);
  await new Promise((res) => r.on("close", res));
  agyBin = "/tmp/agy-bridge-test-stub.sh";
  allowedRoots = "/tmp";
} else {
  const dir = path.join(tmpdir(), "agy-bridge-test");
  mkdirSync(dir, { recursive: true });
  agyBin = path.join(dir, "stub.sh");
  writeFileSync(agyBin, `#!/bin/sh\nsleep ${STUB_SLEEP_S}\necho done\n`);
  chmodSync(agyBin, 0o755);
  allowedRoots = dir;
}

function runCase({ token }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY], {
      env: {
        ...process.env,
        AGY_BIN: agyBin,
        AGY_WSL_DISTRO: WSL_DISTRO,
        AGY_ALLOWED_ROOTS: allowedRoots,
        AGY_FORCE_OAUTH: "1",
        AGY_PROGRESS_INTERVAL_MS: String(INTERVAL_MS),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const progress = [];
    let result = null;
    let malformed = 0;
    let buf = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          malformed++;
          continue;
        }
        if (msg.method === "notifications/progress") progress.push(msg.params);
        if (msg.id === 2) result = msg;
      }
    });

    const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "doctor", arguments: {}, ...(token ? { _meta: { progressToken: token } } : {}) },
    });

    const deadline = Date.now() + (STUB_SLEEP_S + 20) * 1000;
    const poll = setInterval(() => {
      if (result || Date.now() > deadline) {
        clearInterval(poll);
        child.kill();
        resolve({ progress, result, malformed });
      }
    }, 200);
  });
}

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

// --- with a progressToken ---------------------------------------------------
const TOKEN = "test-token-1";
const withToken = await runCase({ token: TOKEN });
const beats = withToken.progress.filter((p) => p.progressToken === TOKEN);
const values = beats.map((p) => p.progress);

check(withToken.malformed === 0, `stdout had ${withToken.malformed} malformed line(s)`);
check(withToken.result !== null, "the tool never returned a result");
check(
  beats.length >= EXPECTED_BEATS,
  `expected >= ${EXPECTED_BEATS} heartbeats in a ~${STUB_SLEEP_S}s call at ${INTERVAL_MS}ms, got ${beats.length}`
);
check(
  beats.length === withToken.progress.length,
  "a notification carried a token the client never sent"
);
check(
  values.every((v, i) => i === 0 || v >= values[i - 1]),
  `progress was not monotonic: ${values.join(", ")}`
);

// --- without one: the old behaviour, exactly --------------------------------
const without = await runCase({ token: null });
check(without.result !== null, "the tool never returned a result (no-token case)");
check(
  without.progress.length === 0,
  `a client that sent no progressToken received ${without.progress.length} notification(s)`
);

console.log("=== agy-bridge progress heartbeat ===");
console.log(`entry              : ${ENTRY}`);
console.log(`heartbeats (token) : ${beats.length}${values.length ? ` [${values.join(", ")}]` : ""}`);
console.log(`heartbeats (none)  : ${without.progress.length}`);
console.log(`malformed lines    : ${withToken.malformed}`);

if (failures.length) {
  console.error("\nFAIL:");
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}
console.log("\nPASS");
