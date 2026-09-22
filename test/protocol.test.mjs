/**
 * Protocol and JSON-RPC plumbing test suite for agy-bridge.
 *
 * What this guards:
 *   1. MCP protocol handshake (`initialize`), capabilities, server info, and instructions.
 *   2. Tool catalog discovery (`tools/list` schema, required fields, properties, options).
 *   3. Flag and configuration overrides (`AGY_DISABLE_RAW`, `AGY_DEFAULT_MODEL`, `AGY_TIMEOUT_SEC`).
 *   4. Standard MCP built-ins (`ping`, `resources/list`, `prompts/list`).
 *   5. JSON-RPC request routing, error codes (-32601, -32602), and notification handling.
 *   6. Tool-level input validation failures returning normal error results with `isError: true`.
 *   7. Newline-delimited stdio framing: chunking, CRLF, batches, invalid JSON, and request IDs.
 *   8. Clean stdout protocol hygiene (no malformed lines, valid JSON-RPC 2.0).
 *   9. Clean process shutdown when stdin closes.
 *  10. Progress notifications (`notifications/progress` heartbeats) for long-running tools.
 *
 * Why it matters:
 *   Any corruption or deviation in the stdio JSON-RPC stream breaks the MCP client connection,
 *   causing tools to disappear or delegations to time out or crash silently.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import {
  startBridge,
  POSIX_ONLY,
  REPO_ROOT,
  tempDir,
  agyJson,
} from "./helpers/harness.mjs";

async function waitFor(predicate, timeoutMs = 2000, intervalMs = 20) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}

function assertHygiene(bridge) {
  assert.deepStrictEqual(bridge.malformed, []);
  for (const msg of bridge.messages) {
    assert.strictEqual(msg.jsonrpc, "2.0");
  }
}

describe("initialize", () => {
  test("echoes string protocolVersion", async () => {
    const bridge = startBridge();
    try {
      const res = await bridge.request("initialize", { protocolVersion: "2024-11-05" });
      assert.strictEqual(res.result.protocolVersion, "2024-11-05");
    } finally {
      await bridge.close();
      assertHygiene(bridge);
    }
  });

  test("defaults protocolVersion to 2025-06-18 when missing or non-string", async () => {
    const bridge = startBridge();
    try {
      const resMissing = await bridge.request("initialize", {});
      assert.strictEqual(resMissing.result.protocolVersion, "2025-06-18");

      const resNumber = await bridge.request("initialize", { protocolVersion: 42 });
      assert.strictEqual(resNumber.result.protocolVersion, "2025-06-18");
    } finally {
      await bridge.close();
      assertHygiene(bridge);
    }
  });

  test("returns expected serverInfo, capabilities, and instructions", async () => {
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, "mcpb", "manifest.json"), "utf8"));
    const bridge = startBridge();
    try {
      const res = await bridge.request("initialize", { protocolVersion: "2025-06-18" });
      assert.deepStrictEqual(res.result.serverInfo, { name: "agy-bridge", version: manifest.version });
      assert.deepStrictEqual(res.result.capabilities, { tools: { listChanged: false } });
      assert.strictEqual(typeof res.result.instructions, "string");
      assert.ok(res.result.instructions.length > 0);
      assert.ok(res.result.instructions.includes("delegate"));
    } finally {
      await bridge.close();
      assertHygiene(bridge);
    }
  });
});

describe("tools/list", () => {
  test("returns exactly 6 tools in defined order with expected schema properties", async () => {
    const bridge = startBridge();
    try {
      const res = await bridge.request("tools/list");
      const tools = res.result.tools;
      const names = tools.map((t) => t.name);
      assert.deepStrictEqual(names, ["delegate", "command", "help", "raw", "models", "doctor"]);

      for (const tool of tools) {
        assert.strictEqual(typeof tool.name, "string");
        assert.ok(tool.name.length > 0);
        assert.strictEqual(typeof tool.title, "string");
        assert.ok(tool.title.length > 0);
        assert.strictEqual(typeof tool.description, "string");
        assert.ok(tool.description.length > 0);
        assert.strictEqual(tool.inputSchema?.type, "object");
        assert.strictEqual(tool.inputSchema?.additionalProperties, false);

        if (tool.inputSchema.required) {
          for (const req of tool.inputSchema.required) {
            assert.ok(req in tool.inputSchema.properties, `${req} missing in ${tool.name} properties`);
          }
        }
      }

      const delegate = tools.find((t) => t.name === "delegate");
      const command = tools.find((t) => t.name === "command");
      const raw = tools.find((t) => t.name === "raw");
      const help = tools.find((t) => t.name === "help");
      const models = tools.find((t) => t.name === "models");
      const doctor = tools.find((t) => t.name === "doctor");

      assert.deepStrictEqual(delegate.inputSchema.required, ["task", "cwd"]);
      assert.deepStrictEqual(command.inputSchema.required, ["command"]);
      assert.deepStrictEqual(raw.inputSchema.required, ["args"]);
      assert.strictEqual(help.inputSchema.required, undefined);
      assert.strictEqual(models.inputSchema.required, undefined);
      assert.strictEqual(doctor.inputSchema.required, undefined);

      assert.deepStrictEqual(models.inputSchema.properties, {});
      assert.deepStrictEqual(doctor.inputSchema.properties, {});
      assert.deepStrictEqual(delegate.inputSchema.properties.mode.enum, ["accept-edits", "plan"]);
      assert.ok(delegate.inputSchema.properties.timeout_seconds.description.includes("Default 900"));
    } finally {
      await bridge.close();
      assertHygiene(bridge);
    }
  });

  test("reflects AGY_DEFAULT_MODEL in delegate model description", async () => {
    const bridge = startBridge({ env: { AGY_DEFAULT_MODEL: "my-model-x" } });
    try {
      const res = await bridge.request("tools/list");
      const delegate = res.result.tools.find((t) => t.name === "delegate");
      assert.ok(delegate.inputSchema.properties.model.description.includes("Default my-model-x"));
    } finally {
      await bridge.close();
      assertHygiene(bridge);
    }
  });

  test("reflects AGY_TIMEOUT_SEC in delegate timeout_seconds description", async () => {
    const bridge = startBridge({ env: { AGY_TIMEOUT_SEC: "77" } });
    try {
      const res = await bridge.request("tools/list");
      const delegate = res.result.tools.find((t) => t.name === "delegate");
      assert.ok(delegate.inputSchema.properties.timeout_seconds.description.includes("Default 77"));
    } finally {
      await bridge.close();
      assertHygiene(bridge);
    }
  });
});

describe("AGY_DISABLE_RAW", () => {
  test("AGY_DISABLE_RAW='1' removes raw from tools/list and returns error on tools/call", async () => {
    const bridge = startBridge({ env: { AGY_DISABLE_RAW: "1" } });
    try {
      const listRes = await bridge.request("tools/list");
      const names = listRes.result.tools.map((t) => t.name);
      assert.deepStrictEqual(names, ["delegate", "command", "help", "models", "doctor"]);

      const callRes = await bridge.request("tools/call", { name: "raw", arguments: { args: ["version"] } });
      assert.deepStrictEqual(callRes.error, { code: -32602, message: "Unknown tool: raw" });
    } finally {
      await bridge.close();
      assertHygiene(bridge);
    }
  });

  test("AGY_DISABLE_RAW='true' and '0' leave raw tool present", async () => {
    for (const val of ["true", "0"]) {
      const bridge = startBridge({ env: { AGY_DISABLE_RAW: val } });
      try {
        const listRes = await bridge.request("tools/list");
        const names = listRes.result.tools.map((t) => t.name);
        assert.ok(names.includes("raw"), `expected raw to be present when AGY_DISABLE_RAW='${val}'`);
        assert.strictEqual(names.length, 6);
      } finally {
        await bridge.close();
        assertHygiene(bridge);
      }
    }
  });
});

describe("MCP built-in handlers", () => {
  test("ping returns empty result", async () => {
    const bridge = startBridge();
    try {
      const res = await bridge.request("ping");
      assert.deepStrictEqual(res.result, {});
    } finally {
      await bridge.close();
      assertHygiene(bridge);
    }
  });

  test("resources/list returns empty list", async () => {
    const bridge = startBridge();
    try {
      const res = await bridge.request("resources/list");
      assert.deepStrictEqual(res.result, { resources: [] });
    } finally {
      await bridge.close();
      assertHygiene(bridge);
    }
  });

  test("prompts/list returns empty list", async () => {
    const bridge = startBridge();
    try {
      const res = await bridge.request("prompts/list");
      assert.deepStrictEqual(res.result, { prompts: [] });
    } finally {
      await bridge.close();
      assertHygiene(bridge);
    }
  });
});

describe("method routing and notifications", () => {
  test("unknown method with id returns -32601 Method not found", async () => {
    const bridge = startBridge();
    try {
      const res = await bridge.request("foo/bar");
      assert.deepStrictEqual(res.error, { code: -32601, message: "Method not found: foo/bar" });
    } finally {
      await bridge.close();
      assertHygiene(bridge);
    }
  });

  test("unknown method notification produces no reply", async () => {
    const bridge = startBridge();
    try {
      const countBefore = bridge.messages.length;
      bridge.notify("foo/bar");
      const pingRes = await bridge.request("ping");
      const newMsgs = bridge.messages.slice(countBefore);
      assert.strictEqual(newMsgs.length, 1);
      assert.strictEqual(newMsgs[0].id, pingRes.id);
    } finally {
      await bridge.close();
      assertHygiene(bridge);
    }
  });

  test("known notifications and ping without id produce no reply", async () => {
    const bridge = startBridge();
    try {
      for (const notificationMethod of ["notifications/initialized", "notifications/cancelled", "ping"]) {
        const countBefore = bridge.messages.length;
        bridge.notify(notificationMethod);
        const pingRes = await bridge.request("ping");
        const newMsgs = bridge.messages.slice(countBefore);
        assert.strictEqual(newMsgs.length, 1, `expected no reply for notification ${notificationMethod}`);
        assert.strictEqual(newMsgs[0].id, pingRes.id);
      }
    } finally {
      await bridge.close();
      assertHygiene(bridge);
    }
  });
});

describe("tools/call errors", () => {
  test("tools/call with unknown name returns -32602 Unknown tool: nope", async () => {
    const bridge = startBridge();
    try {
      const res = await bridge.request("tools/call", { name: "nope" });
      assert.deepStrictEqual(res.error, { code: -32602, message: "Unknown tool: nope" });
    } finally {
      await bridge.close();
      assertHygiene(bridge);
    }
  });

  test("tools/call with no params returns -32602 Unknown tool: undefined", async () => {
    const bridge = startBridge();
    try {
      const res = await bridge.request("tools/call");
      assert.deepStrictEqual(res.error, { code: -32602, message: "Unknown tool: undefined" });
    } finally {
      await bridge.close();
      assertHygiene(bridge);
    }
  });
});

describe("tool input validation", () => {
  test("delegate validation error returns isError: true without spawning agy", async () => {
    const bridge = startBridge();
    try {
      const res = await bridge.callTool("delegate", {});
      assert.strictEqual(res.isError, true);
      assert.strictEqual(res.error, undefined);
      assert.ok(res.text.includes("`task` is required"));
      assert.deepStrictEqual(bridge.calls(), []);
    } finally {
      await bridge.close();
      assertHygiene(bridge);
    }
  });

  test("command validation error returns isError: true without spawning agy", async () => {
    const bridge = startBridge();
    try {
      const res = await bridge.callTool("command", {});
      assert.strictEqual(res.isError, true);
      assert.strictEqual(res.error, undefined);
      assert.ok(res.text.includes("`command` is required"));
      assert.deepStrictEqual(bridge.calls(), []);
    } finally {
      await bridge.close();
      assertHygiene(bridge);
    }
  });

  test("raw validation error returns isError: true without spawning agy", async () => {
    const bridge = startBridge();
    try {
      const res = await bridge.callTool("raw", {});
      assert.strictEqual(res.isError, true);
      assert.strictEqual(res.error, undefined);
      assert.ok(res.text.includes("`args` is required"));
      assert.deepStrictEqual(bridge.calls(), []);
    } finally {
      await bridge.close();
      assertHygiene(bridge);
    }
  });
});

describe("stdin framing and protocol hygiene", () => {
  test("malformed and blank lines are ignored while server continues responding", async () => {
    const bridge = startBridge();
    try {
      bridge.writeRaw("{not json");
      bridge.writeRaw("");
      bridge.writeRaw("   ");
      const res = await bridge.request("ping");
      assert.deepStrictEqual(res.result, {});
    } finally {
      await bridge.close();
      assertHygiene(bridge);
    }
  });

  test("two requests written in a single write both receive replies", async () => {
    const bridge = startBridge();
    try {
      const r1 = JSON.stringify({ jsonrpc: "2.0", id: "batch-1", method: "ping" });
      const r2 = JSON.stringify({ jsonrpc: "2.0", id: "batch-2", method: "ping" });
      bridge.child.stdin.write(`${r1}\n${r2}\n`);
      const ok = await waitFor(() =>
        bridge.messages.some((m) => m.id === "batch-1") && bridge.messages.some((m) => m.id === "batch-2")
      );
      assert.ok(ok, "expected replies to both batched requests");
      const m1 = bridge.messages.find((m) => m.id === "batch-1");
      const m2 = bridge.messages.find((m) => m.id === "batch-2");
      assert.deepStrictEqual(m1.result, {});
      assert.deepStrictEqual(m2.result, {});
    } finally {
      await bridge.close();
      assertHygiene(bridge);
    }
  });

  test("one request split across two writes receives exactly one reply", async () => {
    const bridge = startBridge();
    try {
      const full = JSON.stringify({ jsonrpc: "2.0", id: "split-1", method: "ping" }) + "\n";
      const mid = Math.floor(full.length / 2);
      bridge.child.stdin.write(full.slice(0, mid));
      await new Promise((r) => setTimeout(r, 50));
      bridge.child.stdin.write(full.slice(mid));
      const ok = await waitFor(() => bridge.messages.some((m) => m.id === "split-1"));
      assert.ok(ok, "expected reply to split request");
      const hits = bridge.messages.filter((m) => m.id === "split-1");
      assert.strictEqual(hits.length, 1);
      assert.deepStrictEqual(hits[0].result, {});
    } finally {
      await bridge.close();
      assertHygiene(bridge);
    }
  });

  test("line terminated with CRLF (\\r\\n) is accepted", async () => {
    const bridge = startBridge();
    try {
      bridge.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: "crlf-1", method: "ping" }) + "\r\n");
      const ok = await waitFor(() => bridge.messages.some((m) => m.id === "crlf-1"));
      assert.ok(ok, "expected reply to CRLF terminated line");
      const hit = bridge.messages.find((m) => m.id === "crlf-1");
      assert.deepStrictEqual(hit.result, {});
    } finally {
      await bridge.close();
      assertHygiene(bridge);
    }
  });

  test("string id and numeric id 0 come back unchanged; id null receives no reply", async () => {
    const bridge = startBridge();
    try {
      bridge.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: "abc", method: "ping" }) + "\n");
      bridge.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }) + "\n");
      bridge.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: null, method: "ping" }) + "\n");
      const marker = await bridge.request("ping");

      const mStr = bridge.messages.find((m) => m.id === "abc");
      const mZero = bridge.messages.find((m) => m.id === 0);
      assert.ok(mStr, "expected reply for string id 'abc'");
      assert.ok(mZero, "expected reply for numeric id 0");
      assert.strictEqual(mStr.id, "abc");
      assert.strictEqual(mZero.id, 0);

      const nullMsgs = bridge.messages.filter((m) => m.id === null);
      assert.strictEqual(nullMsgs.length, 0, "request with id null must be treated as notification");
      assert.deepStrictEqual(marker.result, {});
    } finally {
      await bridge.close();
      assertHygiene(bridge);
    }
  });
});

describe("process exit", () => {
  test("closing stdin causes process to exit with code 0", { timeout: 10_000 }, async () => {
    const bridge = startBridge();
    bridge.child.stdin.end();
    const { code, signal } = await bridge.exited;
    assert.strictEqual(code, 0);
    assert.strictEqual(signal, null);
    await bridge.close();
  });
});

describe("progress heartbeat", { skip: POSIX_ONLY }, () => {
  test("doctor with sleeping stub emits progress with progressToken and no total key", async () => {
    const bridge = startBridge({
      env: { AGY_PROGRESS_INTERVAL_MS: "100" },
      stub: {
        byArg0: {
          "--version": { sleepMs: 800, stdout: "agy 1.2.3\n" },
          models: { stdout: "gemini-3.8-flash-high\n" },
        },
      },
    });
    try {
      const res = await bridge.callTool("doctor", {}, { progressToken: "tok-1" });
      assert.strictEqual(res.isError, false);
      const prog = bridge.progress();
      assert.ok(prog.length >= 3, `expected at least 3 progress notifications, got ${prog.length}`);
      for (const p of prog) {
        assert.strictEqual(p.progressToken, "tok-1");
        assert.ok(p.message.startsWith("doctor: running,"));
        assert.strictEqual("total" in p, false);
      }
      const values = prog.map((p) => p.progress);
      assert.ok(values.every((v, i) => i === 0 || v >= values[i - 1]));
    } finally {
      await bridge.close();
      assertHygiene(bridge);
    }
  });

  test("delegate carries total matching timeout_seconds", async () => {
    const dir = tempDir("proto-delegate-");
    const bridge = startBridge({
      env: {
        AGY_ALLOWED_ROOTS: dir,
        AGY_PROGRESS_INTERVAL_MS: "100",
      },
      stub: {
        byArg0: {
          "-p": { sleepMs: 800, json: agyJson() },
        },
      },
    });
    try {
      const res = await bridge.callTool(
        "delegate",
        { task: "test brief", cwd: dir, timeout_seconds: 120 },
        { progressToken: "tok-delegate" }
      );
      assert.strictEqual(res.isError, false);
      const prog = bridge.progress();
      assert.ok(prog.length >= 3, `expected at least 3 progress notifications, got ${prog.length}`);
      for (const p of prog) {
        assert.strictEqual(p.progressToken, "tok-delegate");
        assert.strictEqual(p.total, 120);
        assert.ok(p.message.startsWith("delegate: running,"));
      }
    } finally {
      await bridge.close();
      assertHygiene(bridge);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("progressToken 0 is honoured", async () => {
    const bridge = startBridge({
      env: { AGY_PROGRESS_INTERVAL_MS: "100" },
      stub: {
        byArg0: {
          "--version": { sleepMs: 500, stdout: "agy 1.2.3\n" },
          models: { stdout: "gemini-3.8-flash-high\n" },
        },
      },
    });
    try {
      const res = await bridge.callTool("doctor", {}, { progressToken: 0 });
      assert.strictEqual(res.isError, false);
      const prog = bridge.progress();
      assert.ok(prog.length >= 2, `expected at least 2 progress notifications, got ${prog.length}`);
      for (const p of prog) {
        assert.strictEqual(p.progressToken, 0);
      }
    } finally {
      await bridge.close();
      assertHygiene(bridge);
    }
  });

  test("no progressToken results in zero notifications", async () => {
    const bridge = startBridge({
      env: { AGY_PROGRESS_INTERVAL_MS: "100" },
      stub: {
        byArg0: {
          "--version": { sleepMs: 500, stdout: "agy 1.2.3\n" },
          models: { stdout: "gemini-3.8-flash-high\n" },
        },
      },
    });
    try {
      const res = await bridge.callTool("doctor", {});
      assert.strictEqual(res.isError, false);
      assert.strictEqual(bridge.progress().length, 0);
    } finally {
      await bridge.close();
      assertHygiene(bridge);
    }
  });

  test("heartbeat stops after tool reply arrives", async () => {
    const bridge = startBridge({
      env: { AGY_PROGRESS_INTERVAL_MS: "100" },
      stub: {
        byArg0: {
          "--version": { sleepMs: 500, stdout: "agy 1.2.3\n" },
          models: { stdout: "gemini-3.8-flash-high\n" },
        },
      },
    });
    try {
      const res = await bridge.callTool("doctor", {}, { progressToken: "stop-token" });
      assert.strictEqual(res.isError, false);
      const countAtReply = bridge.progress().length;
      assert.ok(countAtReply >= 2);
      await new Promise((r) => setTimeout(r, 500));
      assert.strictEqual(bridge.progress().length, countAtReply);
    } finally {
      await bridge.close();
      assertHygiene(bridge);
    }
  });
});
