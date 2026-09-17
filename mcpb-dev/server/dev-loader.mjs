#!/usr/bin/env node
/**
 * agy-bridge dev loader.
 *
 * Instead of running a copy of the bridge baked into the .mcpb, this imports the
 * working copy at AGY_DEV_ENTRY. Editing that file and restarting the server picks
 * the change up — no repack, no reinstall.
 *
 * Errors go to stderr and exit non-zero rather than being written to stdout, which
 * carries the MCP protocol and must stay clean.
 */
import { pathToFileURL } from "node:url";
import { existsSync, statSync } from "node:fs";

const target = (process.env.AGY_DEV_ENTRY || "").trim();

const die = (msg) => {
  process.stderr.write(`agy-bridge-dev: ${msg}\n`);
  process.exit(1);
};

if (!target) {
  die(
    "AGY_DEV_ENTRY is not set. Open this extension's settings and point " +
      '"Bridge source file" at your working copy of agy-bridge.mjs.'
  );
}
if (!existsSync(target)) {
  die(`no file at ${target} — check the "Bridge source file" setting.`);
}
if (!statSync(target).isFile()) {
  die(`${target} is not a file — point the setting at agy-bridge.mjs itself.`);
}

await import(pathToFileURL(target).href);
