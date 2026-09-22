/**
 * Packaging consistency and release integrity test suite.
 *
 * What this guards:
 *   1. scripts/check-release.mjs CLI behavior against the repo as checked in:
 *      exit 0 when versions match, exit 0 with matching tag, exit 1 on tag mismatch.
 *   2. Drift detection: verifies that modifications to any of the four version locations
 *      (agy-bridge.mjs, mcpb/manifest.json, mcpb-dev/manifest.json, CHANGELOG.md) or the
 *      bundled server copy (mcpb/server/agy-bridge.mjs) trigger check-release failures
 *      identifying the modified file.
 *   3. Expected tolerances: permits an "## Unreleased" changelog section and CRLF line endings.
 *   4. Manifest invariants: tool list matching the live server, entry points existing,
 *      args[0] templating, bidirectional 1:1 user_config placeholders, and node engine compatibility.
 *   5. Environment variable contract: all manifest-configured env vars are wired into code.
 *
 * Why it matters:
 *   The MCP bundle format (.mcpb) bundles files statically. In the past, stale copies of
 *   agy-bridge.mjs in mcpb/server/ were packaged by mistake. This suite guarantees that
 *   the release script catches drift, missing files, and version divergence before publish.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  unlinkSync,
  mkdirSync,
  copyFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import {
  startBridge,
  REPO_ROOT,
  tempDir,
} from "./helpers/harness.mjs";

const CHECK_RELEASE_SCRIPT = path.join(REPO_ROOT, "scripts", "check-release.mjs");

describe("scripts/check-release.mjs CLI execution", () => {
  test("exits 0 on repository as checked in", () => {
    const res = spawnSync(process.execPath, [CHECK_RELEASE_SCRIPT], { encoding: "utf8" });
    assert.strictEqual(res.status, 0);
    assert.ok(res.stdout.includes("release check OK:"));
  });

  test("exits 0 when invoked with current version tag", () => {
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, "mcpb", "manifest.json"), "utf8"));
    const res = spawnSync(process.execPath, [CHECK_RELEASE_SCRIPT, `v${manifest.version}`], { encoding: "utf8" });
    assert.strictEqual(res.status, 0);
    assert.ok(res.stdout.includes(`release check OK: ${manifest.version} (tag v${manifest.version})`));
  });

  test("exits 1 and reports tag mismatch for v0.0.0-nope", () => {
    const res = spawnSync(process.execPath, [CHECK_RELEASE_SCRIPT, "v0.0.0-nope"], { encoding: "utf8" });
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes("v0.0.0-nope"));
  });
});

describe("scripts/check-release.mjs drift detection", () => {
  const FIVE_FILES = [
    "agy-bridge.mjs",
    "mcpb/manifest.json",
    "mcpb-dev/manifest.json",
    "mcpb/server/agy-bridge.mjs",
    "CHANGELOG.md",
  ];

  function copyFiveFiles(targetDir) {
    for (const rel of FIVE_FILES) {
      const src = path.join(REPO_ROOT, rel);
      const dest = path.join(targetDir, rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    }
  }

  test("unmodified copy of the five files exits 0", () => {
    const dir = tempDir("release-drift-clean-");
    try {
      copyFiveFiles(dir);
      const res = spawnSync(process.execPath, [CHECK_RELEASE_SCRIPT, "--root", dir], { encoding: "utf8" });
      assert.strictEqual(res.status, 0);
      assert.ok(res.stdout.includes("release check OK:"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("mcpb/manifest.json version mutation exits 1 naming the file", () => {
    const dir = tempDir("release-drift-mcpb-");
    try {
      copyFiveFiles(dir);
      const file = path.join(dir, "mcpb", "manifest.json");
      const data = JSON.parse(readFileSync(file, "utf8"));
      data.version = "0.0.1";
      writeFileSync(file, JSON.stringify(data, null, 2));

      const res = spawnSync(process.execPath, [CHECK_RELEASE_SCRIPT, "--root", dir], { encoding: "utf8" });
      assert.strictEqual(res.status, 1);
      assert.ok(res.stderr.includes("mcpb/manifest.json"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("mcpb-dev/manifest.json version mutation exits 1 naming the file", () => {
    const dir = tempDir("release-drift-dev-");
    try {
      copyFiveFiles(dir);
      const file = path.join(dir, "mcpb-dev", "manifest.json");
      const data = JSON.parse(readFileSync(file, "utf8"));
      data.version = "0.0.1";
      writeFileSync(file, JSON.stringify(data, null, 2));

      const res = spawnSync(process.execPath, [CHECK_RELEASE_SCRIPT, "--root", dir], { encoding: "utf8" });
      assert.strictEqual(res.status, 1);
      assert.ok(res.stderr.includes("mcpb-dev/manifest.json"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("extra line appended to mcpb/server/agy-bridge.mjs exits 1 naming the file", () => {
    const dir = tempDir("release-drift-server-");
    try {
      copyFiveFiles(dir);
      const file = path.join(dir, "mcpb", "server", "agy-bridge.mjs");
      appendFileSync(file, "\n// unexpected modification\n");

      const res = spawnSync(process.execPath, [CHECK_RELEASE_SCRIPT, "--root", dir], { encoding: "utf8" });
      assert.strictEqual(res.status, 1);
      assert.ok(res.stderr.includes("mcpb/server/agy-bridge.mjs"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CHANGELOG newest version heading changed to ## 9.9.9 exits 1 naming CHANGELOG.md", () => {
    const dir = tempDir("release-drift-changelog-");
    try {
      copyFiveFiles(dir);
      const file = path.join(dir, "CHANGELOG.md");
      const content = readFileSync(file, "utf8");
      const modified = content.replace(/^## \d+\.\d+\.\d+\S*/m, "## 9.9.9");
      assert.notStrictEqual(modified, content, "fixture has no versioned heading to change");
      writeFileSync(file, modified);

      const res = spawnSync(process.execPath, [CHECK_RELEASE_SCRIPT, "--root", dir], { encoding: "utf8" });
      assert.strictEqual(res.status, 1);
      assert.ok(res.stderr.includes("CHANGELOG.md"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("## Unreleased section inserted above newest version heading still exits 0", () => {
    const dir = tempDir("release-drift-unreleased-");
    try {
      copyFiveFiles(dir);
      const file = path.join(dir, "CHANGELOG.md");
      const content = readFileSync(file, "utf8");
      const modified = content.replace(/^## (\d+)/m, "## Unreleased\n\n- Upcoming changes\n\n## $1");
      writeFileSync(file, modified);

      const res = spawnSync(process.execPath, [CHECK_RELEASE_SCRIPT, "--root", dir], { encoding: "utf8" });
      assert.strictEqual(res.status, 0);
      assert.ok(res.stdout.includes("release check OK:"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("mcpb/server/agy-bridge.mjs converted to CRLF line endings still exits 0", () => {
    const dir = tempDir("release-drift-crlf-");
    try {
      copyFiveFiles(dir);
      const file = path.join(dir, "mcpb", "server", "agy-bridge.mjs");
      const content = readFileSync(file, "utf8");
      const crlf = content.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
      writeFileSync(file, crlf);

      const res = spawnSync(process.execPath, [CHECK_RELEASE_SCRIPT, "--root", dir], { encoding: "utf8" });
      assert.strictEqual(res.status, 0);
      assert.ok(res.stdout.includes("release check OK:"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing file (deleted CHANGELOG.md) exits 1 naming the file", () => {
    const dir = tempDir("release-drift-missing-");
    try {
      copyFiveFiles(dir);
      const file = path.join(dir, "CHANGELOG.md");
      unlinkSync(file);

      const res = spawnSync(process.execPath, [CHECK_RELEASE_SCRIPT, "--root", dir], { encoding: "utf8" });
      assert.strictEqual(res.status, 1);
      assert.ok(res.stderr.includes("CHANGELOG.md"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("manifest consistency and validation", () => {
  const manifests = [
    { dir: "mcpb", expectedName: "agy-bridge" },
    { dir: "mcpb-dev", expectedName: "agy-bridge-dev" },
  ];

  for (const { dir, expectedName } of manifests) {
    describe(`${dir}/manifest.json`, () => {
      test("tools[].name equals bridge tools/list names in the same order", async () => {
        const bridge = startBridge();
        try {
          const toolsRes = await bridge.request("tools/list");
          const bridgeNames = toolsRes.result.tools.map((t) => t.name);

          const manifestPath = path.join(REPO_ROOT, dir, "manifest.json");
          const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
          const manifestNames = manifest.tools.map((t) => t.name);

          assert.deepStrictEqual(manifestNames, bridgeNames);
        } finally {
          await bridge.close();
        }
      });

      test("version equals initialize serverInfo.version", async () => {
        const bridge = startBridge();
        try {
          const initRes = await bridge.initialize();
          const manifestPath = path.join(REPO_ROOT, dir, "manifest.json");
          const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

          assert.strictEqual(manifest.version, initRes.serverInfo.version);
        } finally {
          await bridge.close();
        }
      });

      test("server.entry_point exists on disk relative to manifest directory", () => {
        const manifestPath = path.join(REPO_ROOT, dir, "manifest.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        const entryPointPath = path.join(REPO_ROOT, dir, manifest.server.entry_point);

        assert.ok(existsSync(entryPointPath), `expected ${entryPointPath} to exist`);
      });

      test("server.mcp_config.args[0] === '${__dirname}/' + server.entry_point", () => {
        const manifestPath = path.join(REPO_ROOT, dir, "manifest.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

        assert.strictEqual(manifest.server.mcp_config.args[0], "${__dirname}/" + manifest.server.entry_point);
      });

      test("every ${user_config.X} placeholder refers to a user_config key, and every user_config key is referenced", () => {
        const manifestPath = path.join(REPO_ROOT, dir, "manifest.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

        const env = manifest.server.mcp_config.env;
        const referencedKeys = new Set();
        for (const [envVar, value] of Object.entries(env)) {
          const match = /^\$\{user_config\.([^}]+)\}$/.exec(value);
          assert.ok(match, `env variable ${envVar} value '${value}' should match placeholder pattern`);
          referencedKeys.add(match[1]);
        }

        const definedKeys = new Set(Object.keys(manifest.user_config));
        assert.deepStrictEqual(referencedKeys, definedKeys);
      });

      test(`manifest name is '${expectedName}'`, () => {
        const manifestPath = path.join(REPO_ROOT, dir, "manifest.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

        assert.strictEqual(manifest.name, expectedName);
      });

      test("compatibility.runtimes.node equals package.json engines.node", () => {
        const manifestPath = path.join(REPO_ROOT, dir, "manifest.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        const packageJson = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));

        assert.strictEqual(manifest.compatibility.runtimes.node, packageJson.engines.node);
      });
    });
  }
});

describe("environment variable audit", () => {
  test("every env var in manifests (except AGY_DEV_ENTRY) is read in agy-bridge.mjs, and AGY_DEV_ENTRY in dev-loader.mjs", () => {
    const bridgeSrc = readFileSync(path.join(REPO_ROOT, "agy-bridge.mjs"), "utf8");
    const devLoaderSrc = readFileSync(path.join(REPO_ROOT, "mcpb-dev", "server", "dev-loader.mjs"), "utf8");

    for (const dir of ["mcpb", "mcpb-dev"]) {
      const manifestPath = path.join(REPO_ROOT, dir, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const envKeys = Object.keys(manifest.server.mcp_config.env);

      for (const key of envKeys) {
        if (key === "AGY_DEV_ENTRY") {
          assert.ok(
            devLoaderSrc.includes("process.env.AGY_DEV_ENTRY"),
            "dev-loader.mjs must read process.env.AGY_DEV_ENTRY"
          );
        } else {
          assert.ok(
            bridgeSrc.includes(`process.env.${key}`),
            `agy-bridge.mjs must read process.env.${key} (from ${dir}/manifest.json)`
          );
        }
      }
    }
  });
});
