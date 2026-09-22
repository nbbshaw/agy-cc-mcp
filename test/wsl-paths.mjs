#!/usr/bin/env node
/**
 * Regression test for Windows paths in WSL mode (bridge 1.3.1).
 *
 * The bugs it guards, both hit by Claude Code running on Windows against agy in WSL:
 *
 *   1. Claude passes `cwd` as a Windows path (C:\Users\you\repo). The bridge only
 *      understood /mnt/c/..., so every delegation was refused as "not inside
 *      AGY_ALLOWED_ROOTS" even though the directory was allowed.
 *   2. The post-run git digest came from git inside WSL, which cannot follow a
 *      worktree's `gitdir: C:/...` pointer — so every Claude Code worktree was
 *      reported as "not a git repository" — and which, with core.autocrlf, lists
 *      every text file in a clean checkout as modified.
 *
 * What this asserts, against a real spawned server over stdio:
 *   1. a Windows `cwd` inside the allowed roots runs, in the translated /mnt path;
 *   2. `add_dir` entries are translated the same way;
 *   3. a Windows path that escapes the roots with `..` is still refused;
 *   4. the git digest names this checkout's HEAD and touches exactly as many paths
 *      as Windows git reports — whether this is a worktree or a main checkout.
 *
 * It needs no agy install and makes no model call: AGY_BIN points at a stub inside
 * WSL that prints its working directory and argv. Windows only.
 *
 * Usage:
 *   node test/wsl-paths.mjs [path/to/agy-bridge.mjs]
 *   WSL_DISTRO=Ubuntu-24.04 node test/wsl-paths.mjs
 */

import { spawn, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.log("SKIP: WSL path translation only applies when the bridge runs on Windows.");
  process.exit(0);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = process.argv[2] || path.join(HERE, "..", "agy-bridge.mjs");
const WSL_DISTRO = process.env.WSL_DISTRO || "Ubuntu-26.04";

const REPO = path.resolve(HERE, "..");
const ROOT = path.dirname(REPO);
const toMnt = (p) => `/mnt/${p[0].toLowerCase()}/${p.slice(3).replace(/\\/g, "/")}`;

// Write the stub inside WSL; the bridge will invoke it through `bash -lc`.
const STUB = "/tmp/agy-bridge-test-echo.sh";
const b64 = Buffer.from(`#!/bin/sh\necho "PWD=$(pwd)"\nprintf 'ARG=%s\\n' "$@"\n`, "utf8").toString("base64");
execFileSync("wsl.exe", ["-d", WSL_DISTRO, "--", "bash", "-lc", `echo ${b64} | base64 -d > ${STUB}; chmod +x ${STUB}`]);

function callDelegate(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY], {
      env: {
        ...process.env,
        AGY_BIN: STUB,
        AGY_WSL_DISTRO: WSL_DISTRO,
        AGY_ALLOWED_ROOTS: toMnt(ROOT),
        AGY_TRANSCRIPT_DIR: path.join(tmpdir(), "agy-bridge-test"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = "";
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      child.kill();
      resolve(value);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 2) {
          finish({ isError: !!msg.result?.isError, text: msg.result?.content?.[0]?.text ?? JSON.stringify(msg) });
        }
      }
    });
    const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "delegate", arguments: args } });
    setTimeout(() => finish({ isError: true, text: "(no reply within 90s)" }), 90_000);
  });
}

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

// --- 1, 2 & 4: a Windows cwd inside the roots --------------------------------
const inside = await callDelegate({ task: "noop", cwd: REPO, write: true, add_dir: [ROOT], timeout_seconds: 60 });
const windowsPorcelain = execFileSync("git", ["-C", REPO, "status", "--porcelain=v1"], { encoding: "utf8" }).trim();
const expectedTouched = windowsPorcelain ? windowsPorcelain.split(/\r?\n/).length : 0;
const expectedHead = execFileSync("git", ["-C", REPO, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();

check(!inside.isError, `Windows cwd inside the roots was refused:\n${inside.text}`);
check(inside.text.includes(`PWD=${toMnt(REPO)}`), `agy did not run in ${toMnt(REPO)}`);
check(inside.text.includes(`ARG=${toMnt(ROOT)}`), `add_dir was not translated to ${toMnt(ROOT)}`);
check(!inside.text.includes("not a git repository"), "git digest says this checkout is not a git repository");
check(
  inside.text.includes(`git HEAD ${expectedHead} · ${expectedTouched} path(s) touched`),
  `git digest disagrees with Windows git (HEAD ${expectedHead}, ${expectedTouched} path(s))`
);

// --- 3: `..` out of the roots is still refused -------------------------------
const escaped = await callDelegate({ task: "noop", cwd: path.join(REPO, "..", ".."), write: true, timeout_seconds: 60 });
check(escaped.isError && /not inside AGY_ALLOWED_ROOTS/.test(escaped.text), `path outside the roots was not refused:\n${escaped.text}`);

console.log("=== agy-bridge WSL paths ===");
console.log(`entry        : ${ENTRY}`);
console.log(`cwd          : ${REPO} -> ${toMnt(REPO)}`);
console.log(`allowed root : ${toMnt(ROOT)}`);
console.log(`git          : HEAD ${expectedHead}, ${expectedTouched} path(s) per Windows git`);

if (failures.length) {
  console.error("\nFAIL:");
  for (const f of failures) console.error("  -", f);
  console.error("\n--- digest ---\n" + inside.text);
  process.exit(1);
}
console.log("\nPASS");
