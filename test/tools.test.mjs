/**
 * Test suite for agy-bridge MCP tools: command, raw, help, models, doctor.
 *
 * What this guards:
 *   1. command: input normalization, slash prefixing, print-safe vs LLM model selection,
 *      permission enforcement with AGY_ALLOWED_ROOTS, exit code handling, and TUI refusal hints;
 *   2. raw: input validation, deny-list security across case and flags, AGY_RAW_DENY overrides,
 *      AGY_DISABLE_RAW tool hiding and RPC error, verbatim argument passing, and stdin piping;
 *   3. help: dual invocation for general help, fallback exit handling, and topic-specific dispatch;
 *   4. models: slug listing and sign-in failure diagnostics;
 *   5. doctor: configuration diagnostics against mcpb manifest, version/model discovery,
 *      default model warnings, OAuth enforcement / API-key leakage scrubbing, and settings.json parsing.
 *
 * Each test runs against an isolated spawned server over stdio with an agy stub.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  startBridge,
  tempDir,
  argvValue,
  POSIX_ONLY,
  REPO_ROOT,
} from "./helpers/harness.mjs";

describe("command", () => {
  test("missing command returns error containing `command` is required", async () => {
    const bridge = startBridge();
    try {
      const res = await bridge.callTool("command", {});
      assert.equal(res.isError, true);
      assert.ok(res.text.includes("`command` is required"));
      assert.equal(bridge.calls().length, 0);
    } finally {
      await bridge.close();
    }
  });

  test("usage without a slash prepends slash, uses text format, 300s timeout, no model, no permissions", { skip: POSIX_ONLY }, async () => {
    const bridge = startBridge({
      stub: { default: { stdout: "usage info\n" } },
    });
    try {
      const res = await bridge.callTool("command", { command: "usage" });
      assert.equal(res.isError, false);
      const calls = bridge.calls();
      assert.equal(calls.length, 1);
      const argv = calls[0].argv;
      assert.equal(argv[0], "-p");
      assert.equal(argv[1], "/usage");
      assert.equal(argvValue(argv, "--output-format"), "text");
      assert.equal(argvValue(argv, "--print-timeout"), "300s");
      assert.equal(argv.includes("--model"), false);
      assert.equal(argv.includes("--dangerously-skip-permissions"), false);
    } finally {
      await bridge.close();
    }
  });

  test("command /plan with input sets prompt and passes default model", { skip: POSIX_ONLY }, async () => {
    const bridge = startBridge({
      stub: { default: { stdout: "plan output\n" } },
    });
    try {
      const res = await bridge.callTool("command", { command: "/plan", input: "build x" });
      assert.equal(res.isError, false);
      const calls = bridge.calls();
      assert.equal(calls.length, 1);
      const argv = calls[0].argv;
      assert.equal(argv[0], "-p");
      assert.equal(argv[1], "/plan build x");
      assert.equal(argvValue(argv, "--model"), "gemini-3.8-flash-high");
    } finally {
      await bridge.close();
    }
  });

  test("command /plan respects AGY_DEFAULT_MODEL", { skip: POSIX_ONLY }, async () => {
    const bridge = startBridge({
      env: { AGY_DEFAULT_MODEL: "m2" },
      stub: { default: { stdout: "plan output\n" } },
    });
    try {
      const res = await bridge.callTool("command", { command: "/plan", input: "build x" });
      assert.equal(res.isError, false);
      const calls = bridge.calls();
      assert.equal(calls.length, 1);
      const argv = calls[0].argv;
      assert.equal(argvValue(argv, "--model"), "m2");
    } finally {
      await bridge.close();
    }
  });

  test("explicit model is passed even for print-safe command; effort, agent, conversation, extra_args appended last", { skip: POSIX_ONLY }, async () => {
    const bridge = startBridge({
      stub: { default: { stdout: "done\n" } },
    });
    try {
      const res = await bridge.callTool("command", {
        command: "/usage",
        model: "custom-model",
        effort: "high",
        agent: "reviewer",
        conversation_id: "conv-42",
        extra_args: ["--extra-flag", "extra-val"],
      });
      assert.equal(res.isError, false);
      const calls = bridge.calls();
      assert.equal(calls.length, 1);
      const argv = calls[0].argv;
      assert.equal(argvValue(argv, "--model"), "custom-model");
      assert.equal(argvValue(argv, "--effort"), "high");
      assert.equal(argvValue(argv, "--agent"), "reviewer");
      assert.equal(argvValue(argv, "--conversation"), "conv-42");
      assert.deepEqual(argv.slice(-2), ["--extra-flag", "extra-val"]);
    } finally {
      await bridge.close();
    }
  });

  test("output_format json, invalid fallback to text, and timeout_seconds 45", { skip: POSIX_ONLY }, async () => {
    const bridge = startBridge({
      stub: { default: { stdout: "out\n" } },
    });
    try {
      await bridge.callTool("command", {
        command: "/usage",
        output_format: "json",
        timeout_seconds: 45,
      });
      await bridge.callTool("command", {
        command: "/usage",
        output_format: "invalid-format",
      });
      const calls = bridge.calls();
      assert.equal(calls.length, 2);
      assert.equal(argvValue(calls[0].argv, "--output-format"), "json");
      assert.equal(argvValue(calls[0].argv, "--print-timeout"), "45s");
      assert.equal(argvValue(calls[1].argv, "--output-format"), "text");
    } finally {
      await bridge.close();
    }
  });

  test("write: true with cwd inside AGY_ALLOWED_ROOTS adds --dangerously-skip-permissions and runs in cwd", { skip: POSIX_ONLY }, async () => {
    const allowed = tempDir();
    let bridge;
    try {
      bridge = startBridge({
        env: { AGY_ALLOWED_ROOTS: allowed },
        stub: { default: { stdout: "ok\n" } },
      });
      const res = await bridge.callTool("command", {
        command: "/usage",
        cwd: allowed,
        write: true,
      });
      assert.equal(res.isError, false);
      const calls = bridge.calls();
      assert.equal(calls.length, 1);
      assert.ok(calls[0].argv.includes("--dangerously-skip-permissions"));
      assert.equal(realpathSync(calls[0].cwd), realpathSync(allowed));
    } finally {
      await bridge?.close();
      rmSync(allowed, { recursive: true, force: true });
    }
  });

  test("write: true with cwd outside AGY_ALLOWED_ROOTS is refused before agy runs", async () => {
    const allowed = tempDir();
    const outside = tempDir();
    let bridge;
    try {
      bridge = startBridge({
        env: { AGY_ALLOWED_ROOTS: allowed },
      });
      const res = await bridge.callTool("command", {
        command: "/usage",
        cwd: outside,
        write: true,
      });
      assert.equal(res.isError, true);
      assert.ok(res.text.includes("Refusing write access in"));
      assert.equal(bridge.calls().length, 0);
    } finally {
      await bridge?.close();
      rmSync(allowed, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("write: true with AGY_ALLOWED_ROOTS unset is refused before agy runs", async () => {
    const bridge = startBridge();
    try {
      const res = await bridge.callTool("command", {
        command: "/usage",
        cwd: "/any/path",
        write: true,
      });
      assert.equal(res.isError, true);
      assert.ok(res.text.includes("write=true requires AGY_ALLOWED_ROOTS to be set on the bridge."));
      assert.equal(bridge.calls().length, 0);
    } finally {
      await bridge.close();
    }
  });

  test("no cwd given defaults to the first allowed root", { skip: POSIX_ONLY }, async () => {
    const root1 = tempDir();
    const root2 = tempDir();
    let bridge;
    try {
      bridge = startBridge({
        env: { AGY_ALLOWED_ROOTS: `${root1}:${root2}` },
        stub: { default: { stdout: "ok\n" } },
      });
      const res = await bridge.callTool("command", { command: "/usage" });
      assert.equal(res.isError, false);
      const calls = bridge.calls();
      assert.equal(calls.length, 1);
      assert.equal(realpathSync(calls[0].cwd), realpathSync(root1));
    } finally {
      await bridge?.close();
      rmSync(root1, { recursive: true, force: true });
      rmSync(root2, { recursive: true, force: true });
    }
  });

  test("output formatting quotes arguments with whitespace, shows cwd, stdout, and stderr after [stderr]", { skip: POSIX_ONLY }, async () => {
    const dir = tempDir();
    let bridge;
    try {
      bridge = startBridge({
        stub: { default: { stdout: "hello from stub\n", stderr: "warning line\n" } },
      });
      const res = await bridge.callTool("command", {
        command: "/plan",
        input: "build x",
        cwd: dir,
      });
      assert.equal(res.isError, false);
      const lines = res.text.split("\n");
      assert.ok(lines[0].startsWith("$ agy "));
      assert.ok(lines[0].includes('"/plan build x"'));
      assert.equal(lines[1], `cwd: ${dir}`);
      assert.ok(res.text.includes("hello from stub"));
      assert.ok(res.text.includes("[stderr]\nwarning line"));
    } finally {
      await bridge?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refusal of a TUI-only command includes interactive explanation", { skip: POSIX_ONLY }, async () => {
    const bridge = startBridge({
      stub: { default: { exit: 1, stderr: "this command is interactive only" } },
    });
    try {
      const res = await bridge.callTool("command", { command: "/plan" });
      assert.equal(res.isError, true);
      assert.ok(res.text.includes("agy refused this command in print mode"));
      assert.ok(res.text.includes("documented as an interactive-TUI feature"));
    } finally {
      await bridge.close();
    }
  });

  test("refusal text for command not in TUI list includes exit code but not TUI explanation", { skip: POSIX_ONLY }, async () => {
    const bridge = startBridge({
      stub: { default: { exit: 1, stderr: "this command is interactive only" } },
    });
    try {
      const res = await bridge.callTool("command", { command: "/usage" });
      assert.equal(res.isError, true);
      assert.ok(res.text.includes("exit 1"));
      assert.equal(res.text.includes("documented as an interactive-TUI feature"), false);
    } finally {
      await bridge.close();
    }
  });

  test("non-zero exit with empty stdout is an error; non-zero exit with stdout is not an error", { skip: POSIX_ONLY }, async () => {
    const bridge = startBridge({
      stub: {
        byArg0: {
          "-p": { exit: 2, stdout: "" },
        },
      },
    });
    try {
      const resEmpty = await bridge.callTool("command", { command: "/usage" });
      assert.equal(resEmpty.isError, true);
      assert.ok(resEmpty.text.includes("exit 2"));
    } finally {
      await bridge.close();
    }

    const bridge2 = startBridge({
      stub: {
        byArg0: {
          "-p": { exit: 2, stdout: "partial output\n" },
        },
      },
    });
    try {
      const resWithStdout = await bridge2.callTool("command", { command: "/usage" });
      assert.equal(resWithStdout.isError, false);
      assert.ok(resWithStdout.text.includes("partial output"));
    } finally {
      await bridge2.close();
    }
  });
});

describe("raw", () => {
  test("missing args or empty array returns error containing `args` is required", async () => {
    const bridge = startBridge();
    try {
      const res1 = await bridge.callTool("raw", {});
      assert.equal(res1.isError, true);
      assert.ok(res1.text.includes("`args` is required"));

      const res2 = await bridge.callTool("raw", { args: [] });
      assert.equal(res2.isError, true);
      assert.ok(res2.text.includes("`args` is required"));
      assert.equal(bridge.calls().length, 0);
    } finally {
      await bridge.close();
    }
  });

  test("deny list refuses login, logout, auth, update, upgrade, uninstall and case-insensitive subcommands", async () => {
    const bridge = startBridge();
    try {
      const deniedList = ["login", "logout", "auth", "update", "upgrade", "uninstall"];
      for (const cmd of deniedList) {
        const res = await bridge.callTool("raw", { args: [cmd] });
        assert.equal(res.isError, true);
        assert.ok(res.text.includes("on the bridge's deny list"));
      }

      const resWithFlags = await bridge.callTool("raw", { args: ["--verbose", "Update"] });
      assert.equal(resWithFlags.isError, true);
      assert.ok(resWithFlags.text.includes("on the bridge's deny list"));
      assert.equal(bridge.calls().length, 0);
    } finally {
      await bridge.close();
    }
  });

  test("AGY_RAW_DENY custom list denies configured subcommands and permits others", { skip: POSIX_ONLY }, async () => {
    const bridge = startBridge({
      env: { AGY_RAW_DENY: "mcp" },
      stub: { default: { stdout: "ok\n" } },
    });
    try {
      const resMcp = await bridge.callTool("raw", { args: ["mcp", "list"] });
      assert.equal(resMcp.isError, true);
      assert.ok(resMcp.text.includes("on the bridge's deny list"));
      assert.equal(bridge.calls().length, 0);

      const resLogin = await bridge.callTool("raw", { args: ["login"] });
      assert.equal(resLogin.isError, false);
      assert.equal(bridge.calls().length, 1);
    } finally {
      await bridge.close();
    }
  });

  test("AGY_RAW_DENY empty string permits all subcommands", { skip: POSIX_ONLY }, async () => {
    const bridge = startBridge({
      env: { AGY_RAW_DENY: "" },
      stub: { default: { stdout: "logged in\n" } },
    });
    try {
      const res = await bridge.callTool("raw", { args: ["login"] });
      assert.equal(res.isError, false);
      assert.equal(bridge.calls().length, 1);
    } finally {
      await bridge.close();
    }
  });

  test("AGY_DISABLE_RAW=1 hides raw from tools/list and returns -32602 JSON-RPC error", async () => {
    const bridge = startBridge({
      env: { AGY_DISABLE_RAW: "1" },
    });
    try {
      const listRes = await bridge.request("tools/list");
      const toolNames = (listRes.result?.tools || []).map((t) => t.name);
      assert.equal(toolNames.includes("raw"), false);

      const callRes = await bridge.callTool("raw", { args: ["version"] });
      assert.equal(callRes.isError, true);
      assert.equal(callRes.error?.code, -32602);
      assert.equal(callRes.error?.message, "Unknown tool: raw");
    } finally {
      await bridge.close();
    }
  });

  test("argv passes through verbatim with spaces, quotes, and symbols", { skip: POSIX_ONLY }, async () => {
    const bridge = startBridge({
      stub: { default: { stdout: "ok\n" } },
    });
    try {
      const verbatimArgs = ["arg with spaces", 'arg"with\'quotes', "$VAR_NAME", "--flag=value"];
      const res = await bridge.callTool("raw", { args: verbatimArgs });
      assert.equal(res.isError, false);
      const calls = bridge.calls();
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].argv, verbatimArgs);
    } finally {
      await bridge.close();
    }
  });

  test("stdin handling: newline appended, already terminated unchanged, omitted", { skip: POSIX_ONLY }, async () => {
    const bridge = startBridge({
      stub: { default: { stdout: "ok\n" } },
    });
    try {
      await bridge.callTool("raw", { args: ["test"], stdin: "hello" });
      await bridge.callTool("raw", { args: ["test"], stdin: "x\n" });
      await bridge.callTool("raw", { args: ["test"] });

      const calls = bridge.calls();
      assert.equal(calls.length, 3);
      assert.equal(calls[0].stdin, "hello\n");
      assert.equal(calls[1].stdin, "x\n");
      assert.equal(calls[2].stdin, "");
    } finally {
      await bridge.close();
    }
  });

  test("--dangerously-skip-permissions with cwd checks AGY_ALLOWED_ROOTS", async () => {
    const allowed = tempDir();
    const outside = tempDir();
    let bridge;
    try {
      bridge = startBridge({
        env: { AGY_ALLOWED_ROOTS: allowed },
      });
      const resOutside = await bridge.callTool("raw", {
        args: ["--dangerously-skip-permissions"],
        cwd: outside,
      });
      assert.equal(resOutside.isError, true);
      assert.ok(resOutside.text.includes("Refusing --dangerously-skip-permissions in"));
      assert.equal(bridge.calls().length, 0);
    } finally {
      await bridge?.close();
      rmSync(allowed, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("--dangerously-skip-permissions inside AGY_ALLOWED_ROOTS runs", { skip: POSIX_ONLY }, async () => {
    const allowed = tempDir();
    let bridge;
    try {
      bridge = startBridge({
        env: { AGY_ALLOWED_ROOTS: allowed },
        stub: { default: { stdout: "ok\n" } },
      });
      const resInside = await bridge.callTool("raw", {
        args: ["--dangerously-skip-permissions"],
        cwd: allowed,
      });
      assert.equal(resInside.isError, false);
      assert.equal(bridge.calls().length, 1);
    } finally {
      await bridge?.close();
      rmSync(allowed, { recursive: true, force: true });
    }
  });

  test("--dangerously-skip-permissions with no cwd argument runs without root check", { skip: POSIX_ONLY }, async () => {
    const bridge = startBridge({
      stub: { default: { stdout: "ok\n" } },
    });
    try {
      const res = await bridge.callTool("raw", {
        args: ["--dangerously-skip-permissions"],
      });
      assert.equal(res.isError, false);
      assert.equal(bridge.calls().length, 1);
    } finally {
      await bridge.close();
    }
  });

  test("output formatting, exit 0 with stderr, and exit 1 with empty vs non-empty stdout", { skip: POSIX_ONLY }, async () => {
    const dir = tempDir();
    let bridge;
    try {
      bridge = startBridge({
        stub: { default: { stdout: "mcp list stdout\n", stderr: "some warning\n" } },
      });
      const res = await bridge.callTool("raw", { args: ["mcp", "list"], cwd: dir });
      assert.equal(res.isError, false);
      const lines = res.text.split("\n");
      assert.equal(lines[0], "$ agy mcp list");
      assert.equal(lines[1], `cwd: ${dir} · exit 0`);
      assert.ok(res.text.includes("mcp list stdout"));
      assert.ok(res.text.includes("[stderr]\nsome warning"));
    } finally {
      await bridge?.close();
      rmSync(dir, { recursive: true, force: true });
    }

    const bridgeFail = startBridge({
      stub: { default: { exit: 1, stdout: "" } },
    });
    try {
      const resEmpty = await bridgeFail.callTool("raw", { args: ["mcp", "list"] });
      assert.equal(resEmpty.isError, true);
      assert.ok(resEmpty.text.includes("exit 1"));
    } finally {
      await bridgeFail.close();
    }

    const bridgeSuccessWithExit1 = startBridge({
      stub: { default: { exit: 1, stdout: "output despite exit 1" } },
    });
    try {
      const resStdout = await bridgeSuccessWithExit1.callTool("raw", { args: ["mcp", "list"] });
      assert.equal(resStdout.isError, false);
      assert.ok(resStdout.text.includes("output despite exit 1"));
    } finally {
      await bridgeSuccessWithExit1.close();
    }
  });
});

describe("help", () => {
  test("no topic triggers --help and -p /help, formats both sections", { skip: POSIX_ONLY }, async () => {
    const bridge = startBridge({
      stub: {
        byArg0: {
          "--help": { stdout: "CLI flags help\n" },
          "-p": { stdout: "Slash commands help\n" },
        },
      },
    });
    try {
      const res = await bridge.callTool("help", {});
      assert.equal(res.isError, false);
      const calls = bridge.calls();
      assert.equal(calls.length, 2);

      const hasCliHelp = calls.some((c) => c.argv.length === 1 && c.argv[0] === "--help");
      const hasSlashHelp = calls.some(
        (c) =>
          c.argv.length === 4 &&
          c.argv[0] === "-p" &&
          c.argv[1] === "/help" &&
          c.argv[2] === "--output-format" &&
          c.argv[3] === "text"
      );
      assert.ok(hasCliHelp, "expected a call with argv ['--help']");
      assert.ok(hasSlashHelp, "expected a call with argv ['-p', '/help', '--output-format', 'text']");

      assert.ok(res.text.includes("=== agy --help (flags and subcommands) ==="));
      assert.ok(res.text.includes("CLI flags help"));
      assert.ok(res.text.includes("=== agy -p /help (slash commands available in print mode) ==="));
      assert.ok(res.text.includes("Slash commands help"));
    } finally {
      await bridge.close();
    }
  });

  test("both empty with exit 3 formats (exit 3, no output)", { skip: POSIX_ONLY }, async () => {
    const bridge = startBridge({
      stub: { default: { exit: 3, stdout: "", stderr: "" } },
    });
    try {
      const res = await bridge.callTool("help", {});
      assert.equal(res.isError, false);
      const occurrences = res.text.split("(exit 3, no output)").length - 1;
      assert.equal(occurrences, 2);
    } finally {
      await bridge.close();
    }
  });

  test("topic mcp invokes mcp --help", { skip: POSIX_ONLY }, async () => {
    const bridge = startBridge({
      stub: { default: { stdout: "mcp subcommand help\n" } },
    });
    try {
      const res = await bridge.callTool("help", { topic: "mcp" });
      assert.equal(res.isError, false);
      const calls = bridge.calls();
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].argv, ["mcp", "--help"]);
      assert.ok(res.text.startsWith("$ agy mcp --help"));
    } finally {
      await bridge.close();
    }
  });

  test("topic /plan invokes -p /help /plan; topic /help foo avoids duplicate prefix", { skip: POSIX_ONLY }, async () => {
    const bridge = startBridge({
      stub: { default: { stdout: "topic help\n" } },
    });
    try {
      await bridge.callTool("help", { topic: "/plan" });
      await bridge.callTool("help", { topic: "/help foo" });

      const calls = bridge.calls();
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0].argv, ["-p", "/help /plan", "--output-format", "text"]);
      assert.deepEqual(calls[1].argv, ["-p", "/help foo", "--output-format", "text"]);
    } finally {
      await bridge.close();
    }
  });
});

describe("models", () => {
  test("success calls agy models and returns trimmed stdout", { skip: POSIX_ONLY }, async () => {
    const bridge = startBridge({
      stub: { default: { stdout: "gemini-3.8-flash-high\ngemini-3.8-pro-high\n" } },
    });
    try {
      const res = await bridge.callTool("models", {});
      assert.equal(res.isError, false);
      const calls = bridge.calls();
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].argv, ["models"]);
      assert.equal(res.text, "gemini-3.8-flash-high\ngemini-3.8-pro-high");
    } finally {
      await bridge.close();
    }
  });

  test("exit 1 with stderr reports failure", { skip: POSIX_ONLY }, async () => {
    const bridge = startBridge({
      stub: { default: { exit: 1, stderr: "not signed in" } },
    });
    try {
      const res = await bridge.callTool("models", {});
      assert.equal(res.isError, true);
      assert.ok(res.text.includes("`agy models` exited 1."));
      assert.ok(res.text.includes("not signed in"));
    } finally {
      await bridge.close();
    }
  });
});

describe("doctor", () => {
  test("configuration lines match manifest version, bridge settings, and defaults", { skip: POSIX_ONLY }, async () => {
    const manifest = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "mcpb", "manifest.json"), "utf8")
    );
    const bridge = startBridge({
      stub: {
        byArg0: {
          "--version": { stdout: "1.0.0\n" },
          models: { stdout: "gemini-3.8-flash-high\n" },
        },
      },
    });
    try {
      const res = await bridge.callTool("doctor", {});
      assert.equal(res.isError, false);
      assert.ok(res.text.includes(`bridge:        agy-bridge ${manifest.version}`));
      assert.ok(res.text.includes(`agy binary:    ${bridge.bin}`));
      assert.ok(res.text.includes("execution:     direct"));
      assert.ok(res.text.includes("default model: gemini-3.8-flash-high"));
      assert.ok(res.text.includes("timeout:       900s"));
      assert.ok(res.text.includes("digest limit:  6000 chars"));
      assert.ok(res.text.includes("write roots:   (none — write delegation disabled)"));
      assert.ok(
        res.text.includes("raw tool:      enabled (deny: login,logout,auth,update,upgrade,uninstall)")
      );
    } finally {
      await bridge.close();
    }
  });

  test("write roots joined when set; raw tool disabled when AGY_DISABLE_RAW=1", { skip: POSIX_ONLY }, async () => {
    const r1 = tempDir();
    const r2 = tempDir();
    let bridge;
    try {
      bridge = startBridge({
        env: {
          AGY_ALLOWED_ROOTS: `${r1}:${r2}`,
          AGY_DISABLE_RAW: "1",
        },
        stub: {
          byArg0: {
            "--version": { stdout: "1.0.0\n" },
            models: { stdout: "gemini-3.8-flash-high\n" },
          },
        },
      });
      const res = await bridge.callTool("doctor", {});
      assert.equal(res.isError, false);
      assert.ok(res.text.includes(`write roots:   ${r1}, ${r2}`));
      assert.ok(res.text.includes("raw tool:      disabled"));
    } finally {
      await bridge?.close();
      rmSync(r1, { recursive: true, force: true });
      rmSync(r2, { recursive: true, force: true });
    }
  });

  test("AGY_TIMEOUT_SEC, AGY_MAX_CHARS overrides and invalid fallback", { skip: POSIX_ONLY }, async () => {
    const bridge1 = startBridge({
      env: {
        AGY_TIMEOUT_SEC: "77",
        AGY_MAX_CHARS: "1234",
      },
      stub: {
        byArg0: {
          "--version": { stdout: "1.0.0\n" },
          models: { stdout: "gemini-3.8-flash-high\n" },
        },
      },
    });
    try {
      const res1 = await bridge1.callTool("doctor", {});
      assert.ok(res1.text.includes("timeout:       77s"));
      assert.ok(res1.text.includes("digest limit:  1234 chars"));
    } finally {
      await bridge1.close();
    }

    const bridge2 = startBridge({
      env: { AGY_TIMEOUT_SEC: "-5" },
      stub: {
        byArg0: {
          "--version": { stdout: "1.0.0\n" },
          models: { stdout: "gemini-3.8-flash-high\n" },
        },
      },
    });
    try {
      const res2 = await bridge2.callTool("doctor", {});
      assert.ok(res2.text.includes("timeout:       900s"));
    } finally {
      await bridge2.close();
    }
  });

  test("--version prints 1.2.3 and models contains default model slug", { skip: POSIX_ONLY }, async () => {
    const bridge = startBridge({
      stub: {
        byArg0: {
          "--version": { stdout: "1.2.3\n" },
          models: { stdout: "gemini-3.8-flash-high\tGemini\nother-model\tOther\n" },
        },
      },
    });
    try {
      const res = await bridge.callTool("doctor", {});
      assert.equal(res.isError, false);
      assert.ok(res.text.includes("agy version:   1.2.3"));
      assert.ok(res.text.includes("available models:"));
      assert.ok(res.text.includes("gemini-3.8-flash-high\tGemini\nother-model\tOther"));
      assert.equal(res.text.includes("WARNING: default model"), false);
    } finally {
      await bridge.close();
    }
  });

  test("models list without default slug emits warning", { skip: POSIX_ONLY }, async () => {
    const bridge = startBridge({
      stub: {
        byArg0: {
          "--version": { stdout: "1.2.3\n" },
          models: { stdout: "other-model\tOther\n" },
        },
      },
    });
    try {
      const res = await bridge.callTool("doctor", {});
      assert.equal(res.isError, false);
      assert.ok(
        res.text.includes("WARNING: default model gemini-3.8-flash-high is not in this list.")
      );
    } finally {
      await bridge.close();
    }
  });

  test("--version exit 127 reports FAILED, skips models, hints AGY_BIN", { skip: POSIX_ONLY }, async () => {
    const bridge = startBridge({
      stub: {
        byArg0: {
          "--version": { exit: 127, stderr: "not found" },
          models: { stdout: "should not be called" },
        },
      },
    });
    try {
      const res = await bridge.callTool("doctor", {});
      assert.equal(res.isError, false);
      assert.ok(res.text.includes("agy version:   FAILED (exit 127)"));
      assert.ok(res.text.includes("Check AGY_BIN"));
      assert.equal(bridge.calls().length, 1);
    } finally {
      await bridge.close();
    }
  });

  test("AGY_BIN pointing at nonexistent path does not crash doctor and reports spawn failed", { skip: POSIX_ONLY }, async () => {
    const bridge = startBridge({
      env: { AGY_BIN: "/nonexistent/agy/path" },
    });
    try {
      const res = await bridge.callTool("doctor", {});
      assert.equal(res.isError, false);
      assert.ok(res.text.includes("FAILED"));
      assert.ok(res.text.includes("spawn failed"));
    } finally {
      await bridge.close();
    }
  });

  test("models exit 1 reports failure and likely not signed in", { skip: POSIX_ONLY }, async () => {
    const bridge = startBridge({
      stub: {
        byArg0: {
          "--version": { stdout: "1.0.0\n" },
          models: { exit: 1, stderr: "auth failed" },
        },
      },
    });
    try {
      const res = await bridge.callTool("doctor", {});
      assert.equal(res.isError, false);
      assert.ok(
        res.text.includes("`agy models` FAILED (exit 1) — most likely not signed in.")
      );
    } finally {
      await bridge.close();
    }
  });

  test("auth enforcement reports stripped keys or pass-through depending on AGY_FORCE_OAUTH", { skip: POSIX_ONLY }, async () => {
    // 1. GEMINI_API_KEY with default AGY_FORCE_OAUTH (1)
    const bridgeEnforced = startBridge({
      env: { GEMINI_API_KEY: "secret-key" },
      stub: {
        byArg0: {
          "--version": { stdout: "1.0.0\n" },
          models: { stdout: "gemini-3.8-flash-high\n" },
        },
      },
    });
    try {
      const res = await bridgeEnforced.callTool("doctor", {});
      assert.ok(res.text.includes("auth enforcement: on"));
      assert.ok(res.text.includes("  stripped: GEMINI_API_KEY"));
      assert.ok(res.text.includes("agy never sees them"));
    } finally {
      await bridgeEnforced.close();
    }

    // 2. GEMINI_API_KEY with AGY_FORCE_OAUTH="0"
    const bridgeDisabled = startBridge({
      env: { GEMINI_API_KEY: "secret-key", AGY_FORCE_OAUTH: "0" },
      stub: {
        byArg0: {
          "--version": { stdout: "1.0.0\n" },
          models: { stdout: "gemini-3.8-flash-high\n" },
        },
      },
    });
    try {
      const res = await bridgeDisabled.callTool("doctor", {});
      assert.ok(res.text.includes("auth enforcement: OFF (AGY_FORCE_OAUTH=0)"));
      assert.ok(res.text.includes("PASSING THROUGH: GEMINI_API_KEY"));
      assert.ok(res.text.includes("WARNING: these will route billing to a metered API key"));
    } finally {
      await bridgeDisabled.close();
    }

    // 3. No metered credentials in env
    const bridgeClean = startBridge({
      stub: {
        byArg0: {
          "--version": { stdout: "1.0.0\n" },
          models: { stdout: "gemini-3.8-flash-high\n" },
        },
      },
    });
    try {
      const res = await bridgeClean.callTool("doctor", {});
      assert.equal(res.text.includes("stripped:"), false);
      assert.equal(res.text.includes("PASSING THROUGH:"), false);
    } finally {
      await bridgeClean.close();
    }
  });

  test("readAgySettings reports absent, gemini, vertex, unset, and unreadable settings", { skip: POSIX_ONLY }, async () => {
    // 1. Absent settings.json
    const bridgeAbsent = startBridge({
      stub: {
        byArg0: {
          "--version": { stdout: "1.0.0\n" },
          models: { stdout: "gemini-3.8-flash-high\n" },
        },
      },
    });
    try {
      const res = await bridgeAbsent.callTool("doctor", {});
      assert.ok(res.text.includes("(not present — fine, defaults apply)"));
    } finally {
      await bridgeAbsent.close();
    }

    // Helper to test settings.json content inside bridge.home
    const testSettings = async (content) => {
      const bridge = startBridge({
        stub: {
          byArg0: {
            "--version": { stdout: "1.0.0\n" },
            models: { stdout: "gemini-3.8-flash-high\n" },
          },
        },
      });
      try {
        const settingsDir = path.join(bridge.home, ".gemini", "antigravity-cli");
        mkdirSync(settingsDir, { recursive: true });
        writeFileSync(path.join(settingsDir, "settings.json"), content, "utf8");
        return await bridge.callTool("doctor", {});
      } finally {
        await bridge.close();
      }
    };

    // 2. modelProvider: gemini
    const resGemini = await testSettings(JSON.stringify({ modelProvider: "gemini" }));
    assert.ok(resGemini.text.includes("  modelProvider: gemini"));
    assert.ok(resGemini.text.includes('WARNING: modelProvider "gemini" is the API-key path'));

    // 3. provider: vertex
    const resVertex = await testSettings(JSON.stringify({ provider: "vertex" }));
    assert.ok(resVertex.text.includes("  modelProvider: vertex"));
    assert.equal(resVertex.text.includes('WARNING: modelProvider "gemini" is the API-key path'), false);

    // 4. empty object {}
    const resEmpty = await testSettings(JSON.stringify({}));
    assert.ok(resEmpty.text.includes("modelProvider: (unset — signed-in Google account is used)"));

    // 5. unreadable / invalid json
    const resUnreadable = await testSettings("{ not json");
    assert.ok(resUnreadable.text.includes("(unreadable)"));
  });
});
