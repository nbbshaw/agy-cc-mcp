/**
 * Test suite for the dev extension loader (mcpb-dev/server/dev-loader.mjs).
 *
 * What this guards:
 *   1. Validation of the AGY_DEV_ENTRY environment variable on startup:
 *      rejects unset, empty, whitespace-only, nonexistent, or directory targets.
 *   2. Output hygiene on configuration errors: failure messages must go to stderr
 *      and exit code 1, while stdout remains completely empty to preserve the MCP stream.
 *   3. Successful server bootstrapping when AGY_DEV_ENTRY points to a valid file.
 *   4. Proper URI encoding and import resolution when the file path contains spaces.
 *
 * Why it matters:
 *   The dev extension allows live iteration without repackaging the MCP bundle.
 *   Any diagnostic noise written to stdout on failure corrupts the client's JSON-RPC
 *   parser, turning actionable configuration errors into cryptic protocol failures.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, copyFileSync, rmSync } from "node:fs";
import path from "node:path";
import {
  startBridge,
  DEV_LOADER,
  ENTRY,
  tempDir,
} from "./helpers/harness.mjs";

describe("mcpb-dev/server/dev-loader.mjs", () => {
  test("AGY_DEV_ENTRY unset exits 1 with clean stdout and diagnostic stderr", { timeout: 10_000 }, async () => {
    const bridge = startBridge({ entry: DEV_LOADER, env: { AGY_DEV_ENTRY: undefined } });
    try {
      const { code } = await bridge.exited;
      assert.strictEqual(code, 1);
      assert.ok(bridge.stderr.includes("AGY_DEV_ENTRY is not set"));
      assert.deepStrictEqual(bridge.messages, []);
      assert.deepStrictEqual(bridge.malformed, []);
    } finally {
      await bridge.close();
    }
  });

  test("whitespace-only AGY_DEV_ENTRY behaves identically to unset", { timeout: 10_000 }, async () => {
    const bridge = startBridge({ entry: DEV_LOADER, env: { AGY_DEV_ENTRY: "   " } });
    try {
      const { code } = await bridge.exited;
      assert.strictEqual(code, 1);
      assert.ok(bridge.stderr.includes("AGY_DEV_ENTRY is not set"));
      assert.deepStrictEqual(bridge.messages, []);
      assert.deepStrictEqual(bridge.malformed, []);
    } finally {
      await bridge.close();
    }
  });

  test("nonexistent file path exits 1 with diagnostic stderr", { timeout: 10_000 }, async () => {
    const dir = tempDir("dev-loader-nonexistent-");
    const fakeFile = path.join(dir, "no-such-file.mjs");
    const bridge = startBridge({ entry: DEV_LOADER, env: { AGY_DEV_ENTRY: fakeFile } });
    try {
      const { code } = await bridge.exited;
      assert.strictEqual(code, 1);
      assert.ok(bridge.stderr.includes("no file at"));
      assert.deepStrictEqual(bridge.messages, []);
      assert.deepStrictEqual(bridge.malformed, []);
    } finally {
      await bridge.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("directory path exits 1 with diagnostic stderr", { timeout: 10_000 }, async () => {
    const dir = tempDir("dev-loader-dir-");
    const bridge = startBridge({ entry: DEV_LOADER, env: { AGY_DEV_ENTRY: dir } });
    try {
      const { code } = await bridge.exited;
      assert.strictEqual(code, 1);
      assert.ok(bridge.stderr.includes("is not a file"));
      assert.deepStrictEqual(bridge.messages, []);
      assert.deepStrictEqual(bridge.malformed, []);
    } finally {
      await bridge.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("pointed at ENTRY serves MCP (initialize and tools/list)", { timeout: 10_000 }, async () => {
    const bridge = startBridge({ entry: DEV_LOADER, env: { AGY_DEV_ENTRY: ENTRY } });
    try {
      const initResult = await bridge.initialize();
      assert.strictEqual(initResult.serverInfo.name, "agy-bridge");
      const toolsRes = await bridge.request("tools/list");
      assert.strictEqual(toolsRes.result.tools.length, 6);
      assert.deepStrictEqual(bridge.malformed, []);
    } finally {
      await bridge.close();
    }
  });

  test("pointed at a copy of ENTRY inside directory with spaces still serves MCP", { timeout: 10_000 }, async () => {
    const dir = tempDir("dev-loader-spaces-");
    const spacedDir = path.join(dir, "dir with spaces");
    mkdirSync(spacedDir, { recursive: true });
    const target = path.join(spacedDir, "agy-bridge.mjs");
    copyFileSync(ENTRY, target);

    const bridge = startBridge({ entry: DEV_LOADER, env: { AGY_DEV_ENTRY: target } });
    try {
      const initResult = await bridge.initialize();
      assert.strictEqual(initResult.serverInfo.name, "agy-bridge");
      const toolsRes = await bridge.request("tools/list");
      assert.strictEqual(toolsRes.result.tools.length, 6);
      assert.deepStrictEqual(bridge.malformed, []);
    } finally {
      await bridge.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
