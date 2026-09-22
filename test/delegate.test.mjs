/**
 * Test suite for agy-bridge `delegate` tool.
 *
 * What this suite guards and why it matters:
 * `delegate` is the primary workhorse of agy-bridge. It translates an MCP client's
 * high-level brief into an invocation of `agy -p`, streaming back a concise digest
 * along with git change metrics rather than dumping entire verbose outputs.
 *
 * It protects against:
 *   1. Directory traversal and unauthorized edits: ensuring operations remain strictly
 *      within AGY_ALLOWED_ROOTS, preventing `..` escapes, prefix collisions, and
 *      unauthorized plan-mode execution.
 *   2. Command-line argument construction: verifying that tasks containing quotes,
 *      newlines, and variables pass unmolested, and that model, reasoning effort,
 *      timeouts, sandbox, and permissions flags are correctly formatted.
 *   3. Credential leaks: confirming that metered API keys (Gemini / Vertex) are stripped
 *      from the environment unless explicitly permitted via AGY_FORCE_OAUTH="0".
 *   4. Digest generation and parsing: testing JSON-RPC responses, model mismatch warnings,
 *      handling of non-zero exit codes, transcript persistence, and character clamping.
 *   5. Git digest accuracy: asserting diffstats, porcelain status, and commit tracking.
 *   6. Plan artifact discovery: ensuring implementation plans under ~/.gemini are
 *      reliably located, parsed, and fall back correctly.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  startBridge,
  makeGitRepo,
  gitHead,
  agyJson,
  argvValue,
  argvValues,
  tempDir,
  POSIX_ONLY,
} from "./helpers/harness.mjs";

describe("input validation and allowed roots", () => {
  test("refuses blank task without running agy", async () => {
    const root = tempDir();
    const bridge = startBridge({ env: { AGY_ALLOWED_ROOTS: root } });
    try {
      await bridge.initialize();
      const res = await bridge.callTool("delegate", { task: "   ", cwd: root });
      assert.equal(res.isError, true);
      assert.ok(res.text.includes("`task` is required"));
      assert.equal(bridge.calls().length, 0);
    } finally {
      await bridge.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses missing cwd without running agy", async () => {
    const root = tempDir();
    const bridge = startBridge({ env: { AGY_ALLOWED_ROOTS: root } });
    try {
      await bridge.initialize();
      const res = await bridge.callTool("delegate", { task: "do work" });
      assert.equal(res.isError, true);
      assert.ok(res.text.includes("`cwd` is required"));
      assert.equal(bridge.calls().length, 0);
    } finally {
      await bridge.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses execution when AGY_ALLOWED_ROOTS is unset and write is default", async () => {
    const dir = tempDir();
    const bridge = startBridge({ env: { AGY_ALLOWED_ROOTS: undefined } });
    try {
      await bridge.initialize();
      const res = await bridge.callTool("delegate", { task: "do work", cwd: dir });
      assert.equal(res.isError, true);
      assert.ok(res.text.includes("AGY_ALLOWED_ROOTS is not set"));
      assert.equal(bridge.calls().length, 0);
    } finally {
      await bridge.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses cwd outside every allowed root", async () => {
    const root = tempDir();
    const outside = tempDir();
    const bridge = startBridge({ env: { AGY_ALLOWED_ROOTS: root } });
    try {
      await bridge.initialize();
      const res = await bridge.callTool("delegate", { task: "do work", cwd: outside });
      assert.equal(res.isError, true);
      assert.ok(res.text.includes("not inside AGY_ALLOWED_ROOTS"));
      assert.equal(bridge.calls().length, 0);
    } finally {
      await bridge.close();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("refuses cwd that attempts to escape allowed root via ..", async () => {
    const root = tempDir();
    const escaping = path.join(root, "..", "elsewhere");
    const bridge = startBridge({ env: { AGY_ALLOWED_ROOTS: root } });
    try {
      await bridge.initialize();
      const res = await bridge.callTool("delegate", { task: "do work", cwd: escaping });
      assert.equal(res.isError, true);
      assert.ok(res.text.includes("not inside AGY_ALLOWED_ROOTS"));
      assert.equal(bridge.calls().length, 0);
    } finally {
      await bridge.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses sibling directory sharing a prefix with allowed root", async () => {
    const base = tempDir();
    const root = path.join(base, "repo");
    const sibling = path.join(base, "repo-other");
    fs.mkdirSync(root);
    fs.mkdirSync(sibling);
    const bridge = startBridge({ env: { AGY_ALLOWED_ROOTS: root } });
    try {
      await bridge.initialize();
      const res = await bridge.callTool("delegate", { task: "do work", cwd: sibling });
      assert.equal(res.isError, true);
      assert.ok(res.text.includes("not inside AGY_ALLOWED_ROOTS"));
      assert.equal(bridge.calls().length, 0);
    } finally {
      await bridge.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test("refuses mode plan outside roots even with write: false", async () => {
    const root = tempDir();
    const outside = tempDir();
    const bridge = startBridge({ env: { AGY_ALLOWED_ROOTS: root } });
    try {
      await bridge.initialize();
      const res = await bridge.callTool("delegate", {
        task: "plan work",
        cwd: outside,
        mode: "plan",
        write: false,
      });
      assert.equal(res.isError, true);
      assert.ok(res.text.includes("not inside AGY_ALLOWED_ROOTS"));
      assert.equal(bridge.calls().length, 0);
    } finally {
      await bridge.close();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("accepts cwd inside the second entry of colon-separated AGY_ALLOWED_ROOTS", { skip: POSIX_ONLY }, async () => {
    const root1 = tempDir();
    const root2 = tempDir();
    const subDir = path.join(root2, "subdir");
    fs.mkdirSync(subDir);
    const bridge = startBridge({
      env: { AGY_ALLOWED_ROOTS: `${root1}:${root2}` },
      stub: { default: { json: agyJson() } },
    });
    try {
      await bridge.initialize();
      const res = await bridge.callTool("delegate", { task: "do work", cwd: subDir });
      assert.equal(res.isError, false);
      assert.equal(bridge.calls().length, 1);
    } finally {
      await bridge.close();
      fs.rmSync(root1, { recursive: true, force: true });
      fs.rmSync(root2, { recursive: true, force: true });
    }
  });

  test("accepts cwd equal to root itself and root configured with trailing slash", { skip: POSIX_ONLY }, async () => {
    const root = tempDir();
    const bridge = startBridge({
      env: { AGY_ALLOWED_ROOTS: `${root}/` },
      stub: { default: { json: agyJson() } },
    });
    try {
      await bridge.initialize();
      const res = await bridge.callTool("delegate", { task: "do work", cwd: root });
      assert.equal(res.isError, false);
      assert.equal(bridge.calls().length, 1);
    } finally {
      await bridge.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("allows write: false with no mode outside roots without skip-permissions or git digest", { skip: POSIX_ONLY }, async () => {
    const root = tempDir();
    const outside = tempDir();
    const bridge = startBridge({
      env: { AGY_ALLOWED_ROOTS: root },
      stub: { default: { json: agyJson() } },
    });
    try {
      await bridge.initialize();
      const res = await bridge.callTool("delegate", {
        task: "read-only task",
        cwd: outside,
        write: false,
      });
      assert.equal(res.isError, false);
      const calls = bridge.calls();
      assert.equal(calls.length, 1);
      assert.ok(!calls[0].argv.includes("--dangerously-skip-permissions"));
      assert.ok(!res.text.includes("git HEAD"));
      assert.ok(!res.text.includes("git:"));
    } finally {
      await bridge.close();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("argv passed to agy", () => {
  test("passes default flags with verbatim task containing quotes, dollars, and newlines", { skip: POSIX_ONLY }, async () => {
    const root = tempDir();
    const bridge = startBridge({
      env: { AGY_ALLOWED_ROOTS: root },
      stub: { default: { json: agyJson() } },
    });
    try {
      await bridge.initialize();
      const task = 'run "quoted" command with $VAR and\na newline character';
      const res = await bridge.callTool("delegate", { task, cwd: root });
      assert.equal(res.isError, false);
      const calls = bridge.calls();
      assert.equal(calls.length, 1);
      const argv = calls[0].argv;
      assert.equal(argv[0], "-p");
      assert.equal(argv[1], task);
      assert.equal(argvValue(argv, "--model"), "gemini-3.8-flash-high");
      assert.equal(argvValue(argv, "--output-format"), "json");
      assert.equal(argvValue(argv, "--print-timeout"), "900s");
      assert.ok(argv.includes("--dangerously-skip-permissions"));
      const logFile = argvValue(argv, "--log-file");
      assert.ok(logFile);
      assert.ok(path.isAbsolute(logFile));
      assert.ok(logFile.endsWith(".log"));
      assert.ok(path.basename(logFile).startsWith("agy-bridge-"));
    } finally {
      await bridge.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses AGY_DEFAULT_MODEL and args.model overrides it", { skip: POSIX_ONLY }, async () => {
    const root = tempDir();
    const bridge = startBridge({
      env: { AGY_ALLOWED_ROOTS: root, AGY_DEFAULT_MODEL: "custom-default-model" },
      stub: { default: { json: agyJson() } },
    });
    try {
      await bridge.initialize();
      await bridge.callTool("delegate", { task: "task1", cwd: root, write: false });
      await bridge.callTool("delegate", { task: "task2", cwd: root, model: "overridden-model", write: false });
      const calls = bridge.calls();
      assert.equal(calls.length, 2);
      assert.equal(argvValue(calls[0].argv, "--model"), "custom-default-model");
      assert.equal(argvValue(calls[1].argv, "--model"), "overridden-model");
    } finally {
      await bridge.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("configures print timeout from timeout_seconds or AGY_TIMEOUT_SEC with fallback", { skip: POSIX_ONLY }, async () => {
    const root = tempDir();
    const bridge = startBridge({
      env: { AGY_ALLOWED_ROOTS: root, AGY_TIMEOUT_SEC: "77" },
      stub: { default: { json: agyJson() } },
    });
    try {
      await bridge.initialize();
      await bridge.callTool("delegate", { task: "t1", cwd: root, timeout_seconds: 120, write: false });
      await bridge.callTool("delegate", { task: "t2", cwd: root, write: false });
      await bridge.callTool("delegate", { task: "t3", cwd: root, timeout_seconds: "abc", write: false });
      await bridge.callTool("delegate", { task: "t4", cwd: root, timeout_seconds: -5, write: false });
      const calls = bridge.calls();
      assert.equal(calls.length, 4);
      assert.equal(argvValue(calls[0].argv, "--print-timeout"), "120s");
      assert.equal(argvValue(calls[1].argv, "--print-timeout"), "77s");
      assert.equal(argvValue(calls[2].argv, "--print-timeout"), "77s");
      assert.equal(argvValue(calls[3].argv, "--print-timeout"), "77s");
    } finally {
      await bridge.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("passes effort for custom models and omits it for models encoding effort in slug", { skip: POSIX_ONLY }, async () => {
    const root = tempDir();
    const bridge = startBridge({
      env: { AGY_ALLOWED_ROOTS: root },
      stub: { default: { json: agyJson() } },
    });
    try {
      await bridge.initialize();
      await bridge.callTool("delegate", { task: "t1", cwd: root, model: "custom-model", effort: "low", write: false });
      await bridge.callTool("delegate", { task: "t2", cwd: root, effort: "low", write: false });
      const calls = bridge.calls();
      assert.equal(calls.length, 2);
      assert.equal(argvValue(calls[0].argv, "--effort"), "low");
      assert.equal(calls[1].argv.includes("--effort"), false);
    } finally {
      await bridge.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("passes agent, conversation_id, sandbox, add_dir, and extra_args", { skip: POSIX_ONLY }, async () => {
    const root = tempDir();
    const bridge = startBridge({
      env: { AGY_ALLOWED_ROOTS: root },
      stub: { default: { json: agyJson() } },
    });
    try {
      await bridge.initialize();
      await bridge.callTool("delegate", {
        task: "t1",
        cwd: root,
        agent: "code-reviewer",
        conversation_id: "conv-12345",
        sandbox: true,
        // Built by hand: path.join would normalise the `..` before the bridge saw it.
        add_dir: [`${root}/a/../b`, `${root}//c/`],
        extra_args: ["--foo", "bar"],
        write: false,
      });
      await bridge.callTool("delegate", { task: "t2", cwd: root, sandbox: false, write: false });
      const calls = bridge.calls();
      assert.equal(calls.length, 2);
      const argv = calls[0].argv;
      assert.equal(argvValue(argv, "--agent"), "code-reviewer");
      assert.equal(argvValue(argv, "--conversation"), "conv-12345");
      assert.equal(argv.includes("--sandbox"), true);
      assert.deepEqual(argvValues(argv, "--add-dir"), [`${root}/b`, `${root}/c/`]);
      assert.deepEqual(argv.slice(-2), ["--foo", "bar"]);
      const logIdx = argv.indexOf("--log-file");
      const fooIdx = argv.indexOf("--foo");
      assert.ok(fooIdx > logIdx + 1);
      assert.equal(calls[1].argv.includes("--sandbox"), false);
    } finally {
      await bridge.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("handles mode plan, accept-edits, strict_permissions, and ignores bogus mode", { skip: POSIX_ONLY }, async () => {
    const root = tempDir();
    const bridge = startBridge({
      env: { AGY_ALLOWED_ROOTS: root },
      stub: { default: { json: agyJson() } },
    });
    try {
      const planDir = path.join(bridge.home, ".gemini", "antigravity-cli", "brain", "conv-stub-1");
      fs.mkdirSync(planDir, { recursive: true });
      fs.writeFileSync(path.join(planDir, "implementation_plan.md"), "# Plan");

      await bridge.initialize();
      await bridge.callTool("delegate", { task: "t1", cwd: root, mode: "plan" });
      await bridge.callTool("delegate", { task: "t2", cwd: root, mode: "plan", strict_permissions: true });
      await bridge.callTool("delegate", { task: "t3", cwd: root, mode: "accept-edits" });
      await bridge.callTool("delegate", { task: "t4", cwd: root, mode: "bogus", write: false });

      const calls = bridge.calls();
      assert.equal(calls.length, 4);
      assert.equal(argvValue(calls[0].argv, "--mode"), "plan");
      assert.equal(calls[0].argv.includes("--dangerously-skip-permissions"), true);
      assert.equal(argvValue(calls[1].argv, "--mode"), "plan");
      assert.equal(calls[1].argv.includes("--dangerously-skip-permissions"), false);
      assert.equal(argvValue(calls[2].argv, "--mode"), "accept-edits");
      assert.equal(calls[2].argv.includes("--dangerously-skip-permissions"), true);
      assert.equal(calls[3].argv.includes("--mode"), false);
    } finally {
      await bridge.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("recorded cwd matches requested cwd using realpath", { skip: POSIX_ONLY }, async () => {
    const root = tempDir();
    const bridge = startBridge({
      env: { AGY_ALLOWED_ROOTS: root },
      stub: { default: { json: agyJson() } },
    });
    try {
      await bridge.initialize();
      await bridge.callTool("delegate", { task: "check cwd", cwd: root, write: false });
      const calls = bridge.calls();
      assert.equal(calls.length, 1);
      assert.equal(fs.realpathSync(calls[0].cwd), fs.realpathSync(root));
    } finally {
      await bridge.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("environment given to agy", () => {
  test("strips metered credentials by default and preserves them when AGY_FORCE_OAUTH is 0", { skip: POSIX_ONLY }, async () => {
    const root = tempDir();
    const bridge1 = startBridge({
      env: {
        AGY_ALLOWED_ROOTS: root,
        GEMINI_API_KEY: "secret-gemini",
        GOOGLE_API_KEY: "secret-google",
        GOOGLE_APPLICATION_CREDENTIALS: "/path/to/creds.json",
      },
      stub: { default: { json: agyJson() } },
    });
    try {
      await bridge1.initialize();
      await bridge1.callTool("delegate", { task: "env test", cwd: root, write: false });
      const env1 = bridge1.calls()[0].env;
      assert.equal(env1.GEMINI_API_KEY, undefined);
      assert.equal(env1.GOOGLE_API_KEY, undefined);
      assert.equal(env1.GOOGLE_APPLICATION_CREDENTIALS, undefined);
    } finally {
      await bridge1.close();
    }

    const bridge2 = startBridge({
      env: {
        AGY_ALLOWED_ROOTS: root,
        AGY_FORCE_OAUTH: "0",
        GEMINI_API_KEY: "secret-gemini",
        GOOGLE_API_KEY: "secret-google",
        GOOGLE_APPLICATION_CREDENTIALS: "/path/to/creds.json",
      },
      stub: { default: { json: agyJson() } },
    });
    try {
      await bridge2.initialize();
      await bridge2.callTool("delegate", { task: "env test oauth 0", cwd: root, write: false });
      const env2 = bridge2.calls()[0].env;
      assert.equal(env2.GEMINI_API_KEY, "secret-gemini");
      assert.equal(env2.GOOGLE_API_KEY, "secret-google");
      assert.equal(env2.GOOGLE_APPLICATION_CREDENTIALS, "/path/to/creds.json");
    } finally {
      await bridge2.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("sets NO_COLOR, defaults CI and TERM, and preserves existing TERM", { skip: POSIX_ONLY }, async () => {
    const root = tempDir();
    const bridge1 = startBridge({
      env: {
        AGY_ALLOWED_ROOTS: root,
        CI: undefined,
        TERM: undefined,
      },
      stub: { default: { json: agyJson() } },
    });
    try {
      await bridge1.initialize();
      await bridge1.callTool("delegate", { task: "t1", cwd: root, write: false });
      const env1 = bridge1.calls()[0].env;
      assert.equal(env1.NO_COLOR, "1");
      assert.equal(env1.CI, "1");
      assert.equal(env1.TERM, "dumb");
    } finally {
      await bridge1.close();
    }

    const bridge2 = startBridge({
      env: {
        AGY_ALLOWED_ROOTS: root,
        TERM: "xterm",
      },
      stub: { default: { json: agyJson() } },
    });
    try {
      await bridge2.initialize();
      await bridge2.callTool("delegate", { task: "t2", cwd: root, write: false });
      const env2 = bridge2.calls()[0].env;
      assert.equal(env2.TERM, "xterm");
    } finally {
      await bridge2.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("digest result text", () => {
  test("formats successful digest with requested model, conversation id, response, and transcript", { skip: POSIX_ONLY }, async () => {
    const root = tempDir();
    const bridge = startBridge({
      env: { AGY_ALLOWED_ROOTS: root },
      stub: { default: { json: agyJson() } },
    });
    try {
      await bridge.initialize();
      const task = "write delegate tests";
      const res = await bridge.callTool("delegate", { task, cwd: root, write: false });
      assert.equal(res.isError, false);
      const firstLine = res.text.split("\n")[0];
      assert.ok(firstLine.startsWith("agy ok ·"));
      assert.ok(res.text.includes("model requested: gemini-3.8-flash-high"));
      assert.ok(res.text.includes("conversation_id: conv-stub-1  (pass this back to continue)"));
      assert.ok(res.text.includes("--- response ---\nstub response"));

      const match = res.text.match(/full transcript: (.+)/);
      assert.ok(match, "full transcript line must be present");
      const transcriptPath = match[1].trim();
      assert.equal(fs.existsSync(transcriptPath), true);
      assert.equal(path.dirname(transcriptPath), bridge.transcripts);
      assert.equal(path.basename(transcriptPath), "conv-stub-1.md");
      const transcriptBody = fs.readFileSync(transcriptPath, "utf8");
      assert.ok(transcriptBody.includes("## Brief"));
      assert.ok(transcriptBody.includes(task));
    } finally {
      await bridge.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports agy status=ERROR when exit code is 1 but JSON output is returned", { skip: POSIX_ONLY }, async () => {
    const root = tempDir();
    const bridge = startBridge({
      env: { AGY_ALLOWED_ROOTS: root },
      stub: { default: { json: agyJson({ status: "ERROR" }), exit: 1 } },
    });
    try {
      await bridge.initialize();
      const res = await bridge.callTool("delegate", { task: "status error", cwd: root, write: false });
      const firstLine = res.text.split("\n")[0];
      assert.ok(firstLine.startsWith("agy status=ERROR"));
    } finally {
      await bridge.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns error on non-zero exit with empty stdout and stderr", { skip: POSIX_ONLY }, async () => {
    const root = tempDir();
    const bridge = startBridge({
      env: { AGY_ALLOWED_ROOTS: root },
      stub: { default: { stdout: "", stderr: "boom", exit: 3 } },
    });
    try {
      await bridge.initialize();
      const res = await bridge.callTool("delegate", { task: "fail task", cwd: root, write: false });
      assert.equal(res.isError, true);
      assert.ok(res.text.includes("agy exited 3"));
      assert.ok(res.text.includes("boom"));
      assert.ok(res.text.includes("Run the 'doctor' tool"));
    } finally {
      await bridge.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("handles nonexistent AGY_BIN gracefully with spawn failed error", { skip: POSIX_ONLY }, async () => {
    const root = tempDir();
    const bridge = startBridge({
      env: { AGY_ALLOWED_ROOTS: root, AGY_BIN: path.join(root, "nonexistent-binary") },
    });
    try {
      await bridge.initialize();
      const res = await bridge.callTool("delegate", { task: "spawn fail", cwd: root });
      assert.equal(res.isError, true);
      assert.ok(res.text.includes("spawn failed"));

      const followUp = await bridge.callTool("delegate", { task: "   ", cwd: root });
      assert.equal(followUp.isError, true);
      assert.ok(followUp.text.includes("`task` is required"));
    } finally {
      await bridge.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("extracts plain non-JSON stdout into the response section", { skip: POSIX_ONLY }, async () => {
    const root = tempDir();
    const bridge = startBridge({
      env: { AGY_ALLOWED_ROOTS: root },
      stub: { default: { stdout: "just text\n" } },
    });
    try {
      await bridge.initialize();
      const res = await bridge.callTool("delegate", { task: "plain text", cwd: root, write: false });
      assert.ok(res.text.includes("--- response ---\njust text"));
    } finally {
      await bridge.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("extracts JSON response when stdout has log noise before the JSON line", { skip: POSIX_ONLY }, async () => {
    const root = tempDir();
    const bridge = startBridge({
      env: { AGY_ALLOWED_ROOTS: root },
      stub: {
        default: {
          stdout: "starting...\nwarming up\n" + JSON.stringify(agyJson({ response: "clean response" })) + "\n",
        },
      },
    });
    try {
      await bridge.initialize();
      const res = await bridge.callTool("delegate", { task: "noise test", cwd: root, write: false });
      assert.ok(res.text.includes("--- response ---\nclean response"));
    } finally {
      await bridge.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("extracts response and conversation_id from nested stdout shape", { skip: POSIX_ONLY }, async () => {
    const root = tempDir();
    const bridge = startBridge({
      env: { AGY_ALLOWED_ROOTS: root },
      stub: {
        default: {
          json: {
            status: "SUCCESS",
            stdout: { response: "nested", conversation_id: "c2" },
          },
        },
      },
    });
    try {
      await bridge.initialize();
      const res = await bridge.callTool("delegate", { task: "nested test", cwd: root, write: false });
      assert.ok(res.text.includes("--- response ---\nnested"));
      assert.ok(res.text.includes("conversation_id: c2"));
    } finally {
      await bridge.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("warns when tool actions are auto-denied in headless mode", { skip: POSIX_ONLY }, async () => {
    const root = tempDir();
    const bridge = startBridge({
      env: { AGY_ALLOWED_ROOTS: root },
      stub: {
        default: {
          json: agyJson({
            denied_actions: ["run_command", { display_name: "Edit file" }],
          }),
        },
      },
    });
    try {
      await bridge.initialize();
      const res = await bridge.callTool("delegate", { task: "denied test", cwd: root, write: false });
      assert.ok(
        res.text.includes("WARNING: 2 tool call(s) auto-denied in headless mode: run_command, Edit file.")
      );
    } finally {
      await bridge.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports JSON model and warns only when different from requested model", { skip: POSIX_ONLY }, async () => {
    const root = tempDir();
    const bridge1 = startBridge({
      env: { AGY_ALLOWED_ROOTS: root },
      stub: { default: { json: agyJson({ model: "gemini-3.8-flash-high" }) } },
    });
    try {
      await bridge1.initialize();
      const res1 = await bridge1.callTool("delegate", { task: "same model", cwd: root, write: false });
      assert.ok(res1.text.includes("model reported:  gemini-3.8-flash-high"));
      assert.equal(res1.text.includes("WARNING: agy served a different model"), false);
    } finally {
      await bridge1.close();
    }

    const bridge2 = startBridge({
      env: { AGY_ALLOWED_ROOTS: root },
      stub: { default: { json: agyJson({ model: "gemini-1.5-pro" }) } },
    });
    try {
      await bridge2.initialize();
      const res2 = await bridge2.callTool("delegate", { task: "diff model", cwd: root, write: false });
      assert.ok(res2.text.includes("model reported:  gemini-1.5-pro"));
      assert.ok(res2.text.includes("WARNING: agy served a different model"));
    } finally {
      await bridge2.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("reads served model from log file and detects mismatches", { skip: POSIX_ONLY }, async () => {
    const root = tempDir();
    const bridge1 = startBridge({
      env: { AGY_ALLOWED_ROOTS: root },
      stub: { default: { json: agyJson(), logModel: "gemini-3.8-flash-high" } },
    });
    try {
      await bridge1.initialize();
      const res1 = await bridge1.callTool("delegate", { task: "log model match", cwd: root, write: false });
      assert.ok(res1.text.includes("model served:    gemini-3.8-flash-high  (read from agy's own log)"));
      assert.equal(res1.text.includes("WARNING: agy served a different model"), false);
    } finally {
      await bridge1.close();
    }

    const bridge2 = startBridge({
      env: { AGY_ALLOWED_ROOTS: root },
      stub: { default: { json: agyJson(), logModel: "gemini-3.1-pro-high" } },
    });
    try {
      await bridge2.initialize();
      const res2 = await bridge2.callTool("delegate", { task: "log model diff", cwd: root, write: false });
      assert.ok(res2.text.includes("WARNING: agy served a different model"));
    } finally {
      await bridge2.close();
    }

    const bridge3 = startBridge({
      env: { AGY_ALLOWED_ROOTS: root },
      stub: { default: { json: agyJson() } },
    });
    try {
      await bridge3.initialize();
      const res3 = await bridge3.callTool("delegate", { task: "no log model", cwd: root, write: false });
      assert.ok(res3.text.includes("(not determinable"));
    } finally {
      await bridge3.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("includes usage, duration, turns, error field, and mode in digest", { skip: POSIX_ONLY }, async () => {
    const root = tempDir();
    const bridge = startBridge({
      env: { AGY_ALLOWED_ROOTS: root },
      stub: {
        default: {
          json: agyJson({
            usage: { input_tokens: 10, output_tokens: 5 },
            duration_seconds: 12.5,
            num_turns: 3,
            error: "bad thing",
          }),
        },
      },
    });
    try {
      const planDir = path.join(bridge.home, ".gemini", "antigravity-cli", "brain", "conv-stub-1");
      fs.mkdirSync(planDir, { recursive: true });
      fs.writeFileSync(path.join(planDir, "implementation_plan.md"), "# Plan");

      await bridge.initialize();
      const res = await bridge.callTool("delegate", { task: "meta test", cwd: root, mode: "plan" });
      const firstLine = res.text.split("\n")[0];
      assert.ok(firstLine.includes("(agy 12.5s)"));
      assert.ok(firstLine.includes("· 3 turns"));
      assert.ok(firstLine.includes("· mode=plan"));
      assert.ok(res.text.includes('usage: {"input_tokens":10,"output_tokens":5}'));
      assert.ok(res.text.includes("agy error field: bad thing"));
    } finally {
      await bridge.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("clamps responses exceeding AGY_MAX_CHARS keeping head and tail", { skip: POSIX_ONLY }, async () => {
    const root = tempDir();
    const head = "A".repeat(600);
    const tail = "C".repeat(400);
    const marker = "MIDDLE_MARKER_";
    const mid = marker + "B".repeat(5000 - 600 - 400 - marker.length);
    const resp5000 = head + mid + tail;
    assert.equal(resp5000.length, 5000);

    const bridge1 = startBridge({
      env: { AGY_ALLOWED_ROOTS: root, AGY_MAX_CHARS: "1000" },
      stub: { default: { json: agyJson({ response: resp5000 }) } },
    });
    try {
      await bridge1.initialize();
      const res1 = await bridge1.callTool("delegate", { task: "clamp 5000", cwd: root, write: false });
      assert.ok(res1.text.includes("chars omitted — full transcript on disk"));
      assert.ok(res1.text.includes(head));
      assert.ok(res1.text.includes(tail));
      assert.equal(res1.text.includes(marker), false);
    } finally {
      await bridge1.close();
    }

    const bridge2 = startBridge({
      env: { AGY_ALLOWED_ROOTS: root, AGY_MAX_CHARS: "1000" },
      stub: { default: { json: agyJson({ response: "X".repeat(1000) }) } },
    });
    try {
      await bridge2.initialize();
      const res2 = await bridge2.callTool("delegate", { task: "exact 1000", cwd: root, write: false });
      assert.equal(res2.text.includes("chars omitted — full transcript on disk"), false);
    } finally {
      await bridge2.close();
    }

    const bridge3 = startBridge({
      env: { AGY_ALLOWED_ROOTS: root, AGY_MAX_CHARS: "abc" },
      stub: { default: { json: agyJson({ response: "Y".repeat(6000) }) } },
    });
    try {
      await bridge3.initialize();
      const res6000 = await bridge3.callTool("delegate", { task: "exact 6000 default", cwd: root, write: false });
      assert.equal(res6000.text.includes("chars omitted — full transcript on disk"), false);
    } finally {
      await bridge3.close();
    }

    const bridge4 = startBridge({
      env: { AGY_ALLOWED_ROOTS: root, AGY_MAX_CHARS: "abc" },
      stub: { default: { json: agyJson({ response: "Z".repeat(6001) }) } },
    });
    try {
      await bridge4.initialize();
      const res6001 = await bridge4.callTool("delegate", { task: "6001 clamped default", cwd: root, write: false });
      assert.ok(res6001.text.includes("chars omitted — full transcript on disk"));
    } finally {
      await bridge4.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("git digest", () => {
  test("reports untracked files with path count and porcelain line", { skip: POSIX_ONLY }, async () => {
    const repo = makeGitRepo();
    const bridge = startBridge({
      env: { AGY_ALLOWED_ROOTS: repo },
      stub: { default: { json: agyJson(), writeFiles: { "new.txt": "x" } } },
    });
    try {
      await bridge.initialize();
      const res = await bridge.callTool("delegate", { task: "new file", cwd: repo });
      assert.equal(res.isError, false);
      const head = gitHead(repo);
      assert.ok(res.text.includes(`git HEAD ${head} · 1 path(s) touched`));
      assert.ok(res.text.includes("?? new.txt"));
    } finally {
      await bridge.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("reports modified files with diffstat and porcelain status", { skip: POSIX_ONLY }, async () => {
    const repo = makeGitRepo();
    const bridge = startBridge({
      env: { AGY_ALLOWED_ROOTS: repo },
      stub: { default: { json: agyJson(), writeFiles: { "README.md": "changed\n" } } },
    });
    try {
      await bridge.initialize();
      const res = await bridge.callTool("delegate", { task: "modify readme", cwd: repo });
      assert.equal(res.isError, false);
      const lines = res.text.split("\n");
      assert.ok(lines.some((l) => /^\s*README\.md \| +\d+ [+-]+$/.test(l)), "diffstat line for README.md");
      // The status column must survive intact: " M" is unstaged, "M " would be staged.
      assert.ok(lines.includes(" M README.md"), "porcelain line keeps its leading space");
    } finally {
      await bridge.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("reports clean working tree when no files were changed", { skip: POSIX_ONLY }, async () => {
    const repo = makeGitRepo();
    const bridge = startBridge({
      env: { AGY_ALLOWED_ROOTS: repo },
      stub: { default: { json: agyJson() } },
    });
    try {
      await bridge.initialize();
      const res = await bridge.callTool("delegate", { task: "no changes", cwd: repo });
      assert.equal(res.isError, false);
      assert.ok(res.text.includes("0 path(s) touched"));
      assert.ok(res.text.includes("(working tree clean — no files were changed)"));
    } finally {
      await bridge.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("detects when Gemini committed and reports short hashes", { skip: POSIX_ONLY }, async () => {
    const repo = makeGitRepo();
    const before = gitHead(repo);
    const bridge = startBridge({
      env: { AGY_ALLOWED_ROOTS: repo },
      stub: {
        default: {
          json: agyJson(),
          writeFiles: { "committed.txt": "hello\n" },
          commit: "gemini commit",
        },
      },
    });
    try {
      await bridge.initialize();
      const res = await bridge.callTool("delegate", { task: "commit task", cwd: repo });
      assert.equal(res.isError, false);
      const after = gitHead(repo);
      assert.ok(res.text.includes(`NOTE: HEAD moved (${before} → ${after}) — Gemini committed.`));
    } finally {
      await bridge.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("notes when cwd is not a git repository", { skip: POSIX_ONLY }, async () => {
    const dir = tempDir();
    const bridge = startBridge({
      env: { AGY_ALLOWED_ROOTS: dir },
      stub: { default: { json: agyJson() } },
    });
    try {
      await bridge.initialize();
      const res = await bridge.callTool("delegate", { task: "non repo", cwd: dir });
      assert.equal(res.isError, false);
      assert.ok(res.text.includes("git: not a git repository — no diff available, inspect the files directly."));
    } finally {
      await bridge.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("plan mode artifact", () => {
  test("reads implementation_plan.md artifact and notes write barrier", { skip: POSIX_ONLY }, async () => {
    const root = tempDir();
    const bridge = startBridge({
      env: { AGY_ALLOWED_ROOTS: root },
      stub: { default: { json: agyJson({ conversation_id: "conv-plan-1" }) } },
    });
    try {
      const planDir = path.join(bridge.home, ".gemini", "antigravity-cli", "brain", "conv-plan-1");
      fs.mkdirSync(planDir, { recursive: true });
      fs.writeFileSync(path.join(planDir, "implementation_plan.md"), "# The Plan\nstep one");

      await bridge.initialize();
      const res = await bridge.callTool("delegate", { task: "plan task", cwd: root, mode: "plan" });
      assert.equal(res.isError, false);
      assert.ok(res.text.includes("--- implementation plan ("));
      assert.ok(res.text.includes("step one"));
      assert.ok(res.text.includes("plan mode: agy blocked all workspace edits"));
    } finally {
      await bridge.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("selects file with plan in name or falls back to notes.md, never walkthrough.md", { skip: POSIX_ONLY }, async () => {
    const root = tempDir();
    const bridge = startBridge({
      env: { AGY_ALLOWED_ROOTS: root },
      stub: { default: { json: agyJson({ conversation_id: "conv-plan-select" }) } },
    });
    try {
      const planDir = path.join(bridge.home, ".gemini", "antigravity-cli", "brain", "conv-plan-select");
      fs.mkdirSync(planDir, { recursive: true });
      fs.writeFileSync(path.join(planDir, "walkthrough.md"), "walkthrough body");
      fs.writeFileSync(path.join(planDir, "notes.md"), "notes body");
      fs.writeFileSync(path.join(planDir, "my-plan.md"), "plan body");

      await bridge.initialize();
      const res1 = await bridge.callTool("delegate", { task: "plan select", cwd: root, mode: "plan" });
      assert.ok(res1.text.includes("plan body"));
      assert.equal(res1.text.includes("notes body"), false);
      assert.equal(res1.text.includes("walkthrough body"), false);

      fs.unlinkSync(path.join(planDir, "my-plan.md"));
      const res2 = await bridge.callTool("delegate", { task: "plan fallback", cwd: root, mode: "plan" });
      assert.ok(res2.text.includes("notes body"));
      assert.equal(res2.text.includes("walkthrough body"), false);
    } finally {
      await bridge.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("retries and reports diagnostic when plan artifact is missing", { skip: POSIX_ONLY }, async () => {
    const root = tempDir();
    const bridge = startBridge({
      env: { AGY_ALLOWED_ROOTS: root },
      stub: { default: { json: agyJson({ conversation_id: "conv-plan-missing" }) } },
    });
    try {
      await bridge.initialize();
      const res = await bridge.callTool(
        "delegate",
        { task: "plan missing", cwd: root, mode: "plan" },
        { timeoutMs: 30000 }
      );
      assert.equal(res.isError, false);
      assert.ok(res.text.includes("plan artifact: no plan artifact found"));
      assert.ok(res.text.includes("(retried for ~7s after agy exited)"));
    } finally {
      await bridge.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
