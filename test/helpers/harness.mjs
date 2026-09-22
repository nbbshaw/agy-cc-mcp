/**
 * Shared harness for the node:test suites in test/*.test.mjs.
 *
 * Every suite drives a real spawned server over stdio, exactly as an MCP client
 * would. `agy` itself is replaced by a stub whose behaviour each test scripts
 * through the `stub` option, and which records every invocation — argv, cwd,
 * env, stdin — so a test can assert on exactly what the bridge ran.
 *
 * The stub is a script with a shebang, and node refuses to spawn one on Windows
 * with shell:false (which is what the bridge uses). Tests that make the bridge
 * execute the stub pass `{ skip: POSIX_ONLY }`; tests that never reach agy
 * (protocol, manifests) run everywhere. CI runs the full set on Linux and macOS;
 * on Windows, run `npm test` inside WSL for the rest.
 *
 * Run against the packed copy instead of the working source with
 *   AGY_BRIDGE_ENTRY=mcpb/server/agy-bridge.mjs npm test
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ENTRY = process.env.AGY_BRIDGE_ENTRY
  ? path.resolve(process.env.AGY_BRIDGE_ENTRY)
  : path.join(REPO_ROOT, "agy-bridge.mjs");
export const DEV_LOADER = path.join(REPO_ROOT, "mcpb-dev", "server", "dev-loader.mjs");

export const POSIX_ONLY =
  process.platform === "win32" ? "the agy stub needs a POSIX shebang — run in WSL, or rely on CI" : false;

/** Credentials the bridge strips; removed from the inherited env so a developer's own keys can't skew a test. */
export const METERED_AUTH_VARS = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "VERTEXAI_PROJECT",
  "VERTEXAI_LOCATION",
];

export const tempDir = (prefix = "agy-bridge-test-") => mkdtempSync(path.join(tmpdir(), prefix));

// ---------------------------------------------------------------------------
// the agy stub
// ---------------------------------------------------------------------------

/**
 * Behaviour comes from AGY_STUB_CONFIG, a JSON object:
 *
 *   {
 *     default: <behaviour>,                 // applies to every call
 *     byArg0:  { "<argv[0]>": <behaviour> } // merged over default when argv[0] matches,
 *   }                                       //   e.g. "-p", "--version", "models", "--help"
 *
 * and a <behaviour> is any of:
 *
 *   stdout     string written to stdout
 *   json       object written to stdout as one line of JSON (wins over stdout)
 *   stderr     string written to stderr
 *   exit       exit code (default 0)
 *   sleepMs    wait this long before doing anything else
 *   writeFiles { "relative/path": "content" } created under the cwd — simulates an edit
 *   commit     commit message: `git add -A && git commit` in the cwd — simulates Gemini committing
 *   logModel   model slug written to the file after --log-file, as agy's own log would
 *
 * Every call is appended to AGY_STUB_RECORD as one JSON line: { argv, cwd, env, stdin }.
 */
const STUB_SOURCE = `#!${process.execPath}
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const argv = process.argv.slice(2);
let stdin = "";
try { stdin = fs.readFileSync(0, "utf8"); } catch {}

if (process.env.AGY_STUB_RECORD) {
  fs.appendFileSync(
    process.env.AGY_STUB_RECORD,
    JSON.stringify({ argv, cwd: process.cwd(), env: process.env, stdin }) + "\\n"
  );
}

const cfg = JSON.parse(process.env.AGY_STUB_CONFIG || "{}");
const b = { ...(cfg.default || {}), ...((cfg.byArg0 || {})[argv[0]] || {}) };

if (b.sleepMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, b.sleepMs);

for (const [rel, content] of Object.entries(b.writeFiles || {})) {
  const file = path.join(process.cwd(), rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
if (b.commit) {
  const git = (...a) => execFileSync("git", ["-c", "user.name=stub", "-c", "user.email=stub@example.com", ...a], { stdio: "ignore" });
  git("add", "-A");
  git("commit", "-q", "-m", b.commit);
}
if (b.logModel) {
  const i = argv.indexOf("--log-file");
  if (i >= 0 && argv[i + 1]) fs.writeFileSync(argv[i + 1], "resolved model: " + b.logModel + "\\n");
}

if (b.json !== undefined) process.stdout.write(JSON.stringify(b.json) + "\\n");
else if (b.stdout) process.stdout.write(b.stdout);
if (b.stderr) process.stderr.write(b.stderr);
process.exitCode = b.exit || 0;
`;

/** A typical successful `agy -p --output-format json` result, for tests that need one. */
export const agyJson = (overrides = {}) => ({
  status: "SUCCESS",
  response: "stub response",
  conversation_id: "conv-stub-1",
  ...overrides,
});

// ---------------------------------------------------------------------------
// git fixtures
// ---------------------------------------------------------------------------

/** A throwaway git repo with one commit, so the bridge's git digest has something to read. */
export function makeGitRepo(dir = tempDir("agy-bridge-repo-")) {
  const git = (...a) =>
    execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...a], {
      cwd: dir,
      stdio: "ignore",
    });
  git("init", "-q");
  writeFileSync(path.join(dir, "README.md"), "fixture\n");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
  return dir;
}

export const gitHead = (dir) =>
  execFileSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();

// ---------------------------------------------------------------------------
// the bridge
// ---------------------------------------------------------------------------

/**
 * Spawn the bridge with the stub as AGY_BIN.
 *
 *   env    merged over the defaults; a value of `undefined` removes the variable.
 *          AGY_* and metered credentials from the parent env are never inherited.
 *   stub   the AGY_STUB_CONFIG object described above.
 *   entry  the script to run (default: ENTRY).
 *   args   extra argv for the script.
 *
 * Defaults set for isolation: HOME is an empty temp dir (so doctor and plan-mode
 * lookups never read the developer's real ~/.gemini), and AGY_TRANSCRIPT_DIR is
 * inside the bridge's temp dir. Call close() when done; it removes both.
 */
export function startBridge({ env = {}, stub = {}, entry = ENTRY, args = [] } = {}) {
  const dir = tempDir();
  const home = path.join(dir, "home");
  const transcripts = path.join(dir, "transcripts");
  mkdirSync(home);

  const bin = path.join(dir, "agy-stub.cjs");
  writeFileSync(bin, STUB_SOURCE);
  chmodSync(bin, 0o755);
  const record = path.join(dir, "calls.jsonl");

  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("AGY_") && !METERED_AUTH_VARS.includes(k))
  );
  const merged = {
    ...inherited,
    HOME: home,
    AGY_BIN: bin,
    AGY_TRANSCRIPT_DIR: transcripts,
    AGY_STUB_RECORD: record,
    AGY_STUB_CONFIG: JSON.stringify(stub),
    ...env,
  };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];

  const child = spawn(process.execPath, [entry, ...args], { env: merged, stdio: ["pipe", "pipe", "pipe"] });

  const messages = [];
  const malformed = [];
  const pending = new Map();
  let stderr = "";
  let nextId = 1;
  let buf = "";

  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      for (const { reject, timer } of pending.values()) {
        clearTimeout(timer);
        reject(new Error(`bridge exited (code ${code}, signal ${signal}) before replying.\nstderr:\n${stderr}`));
      }
      pending.clear();
      resolve({ code, signal });
    });
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => (stderr += d));
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
        malformed.push(line);
        continue;
      }
      messages.push(msg);
      const p = msg.id !== undefined && msg.id !== null ? pending.get(msg.id) : undefined;
      if (p && (msg.result !== undefined || msg.error !== undefined)) {
        pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg);
      }
    }
  });

  const writeLine = (obj) => child.stdin.write((typeof obj === "string" ? obj : JSON.stringify(obj)) + "\n");

  const bridge = {
    child,
    dir,
    home,
    bin,
    transcripts,
    /** Every parsed stdout message, in arrival order. */
    messages,
    /** Every stdout line that was not valid JSON. Should always be empty. */
    malformed,
    /** Resolves with { code, signal } when the server process exits. */
    exited,
    get stderr() {
      return stderr;
    },

    /** Send a JSON-RPC request; resolves with the whole response ({ id, result } or { id, error }). */
    request(method, params, { timeoutMs = 30_000 } = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`no reply to ${method} (id ${id}) within ${timeoutMs}ms.\nstderr:\n${stderr}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        writeLine({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
      });
    },

    /** Send a JSON-RPC notification (no id, no reply expected). */
    notify(method, params) {
      writeLine({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
    },

    /** Write one raw line to the server's stdin, e.g. deliberately malformed JSON. */
    writeRaw(line) {
      writeLine(String(line));
    },

    /** initialize + notifications/initialized; resolves with the initialize result. */
    async initialize(protocolVersion = "2025-06-18") {
      const res = await bridge.request("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "test", version: "0" } });
      bridge.notify("notifications/initialized");
      return res.result;
    },

    /**
     * tools/call. Resolves with
     *   { text, isError, result, error, id }
     * where `text` joins the result's text content, or is the JSON-RPC error message.
     */
    async callTool(name, args = {}, { progressToken, timeoutMs = 60_000 } = {}) {
      const params = { name, arguments: args };
      if (progressToken !== undefined) params._meta = { progressToken };
      const msg = await bridge.request("tools/call", params, { timeoutMs });
      if (msg.error) return { id: msg.id, error: msg.error, isError: true, text: msg.error.message, result: undefined };
      const text = (msg.result?.content || []).map((c) => c.text ?? "").join("\n");
      return { id: msg.id, result: msg.result, error: undefined, isError: msg.result?.isError === true, text };
    },

    /** notifications/progress messages received so far. */
    progress() {
      return messages.filter((m) => m.method === "notifications/progress").map((m) => m.params);
    },

    /** Every recorded stub invocation, oldest first: [{ argv, cwd, env, stdin }]. */
    calls() {
      if (!existsSync(record)) return [];
      return readFileSync(record, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    },

    /** Kill the server and remove its temp dir. Safe to call twice. */
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await exited;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return bridge;
}

/**
 * Value after `flag` in an argv array, or undefined. For repeated flags use argvValues.
 */
export const argvValue = (argv, flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

export const argvValues = (argv, flag) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []));
