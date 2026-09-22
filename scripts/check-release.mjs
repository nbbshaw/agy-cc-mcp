#!/usr/bin/env node
/**
 * Release consistency check. CI runs it on every push; the release workflow runs
 * it with the tag being published.
 *
 * The version lives in four places and the bundled server in two, all kept in
 * sync by hand. 1.3.0 shipped a .mcpb built from a stale mcpb/server/ copy before
 * anyone noticed, which is what this exists to stop. It fails when:
 *
 *   - SERVER_VERSION in agy-bridge.mjs, mcpb/manifest.json and
 *     mcpb-dev/manifest.json disagree;
 *   - the newest versioned CHANGELOG heading is not that version
 *     (a "## Unreleased" section above it is fine);
 *   - mcpb/server/agy-bridge.mjs differs from agy-bridge.mjs;
 *   - a tag was given and it is not v<version>.
 *
 * Usage:
 *   node scripts/check-release.mjs [--root <repo>] [tag]
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let tag = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--root") root = path.resolve(argv[++i] ?? "");
  else tag = argv[i];
}

const problems = [];
const read = (rel) => {
  try {
    return readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
  } catch (e) {
    problems.push(`cannot read ${rel}: ${e.code || e.message}`);
    return null;
  }
};
const manifestVersion = (rel) => {
  const text = read(rel);
  if (text === null) return null;
  try {
    return JSON.parse(text).version ?? null;
  } catch (e) {
    problems.push(`${rel} is not valid JSON: ${e.message}`);
    return null;
  }
};

const source = read("agy-bridge.mjs");
const version = source && /const SERVER_VERSION = "([^"]+)"/.exec(source)?.[1];
if (source && !version) problems.push("no SERVER_VERSION found in agy-bridge.mjs");

if (version) {
  for (const rel of ["mcpb/manifest.json", "mcpb-dev/manifest.json"]) {
    const v = manifestVersion(rel);
    if (v !== null && v !== version) problems.push(`${rel} is version ${v}, agy-bridge.mjs is ${version}`);
  }

  const changelog = read("CHANGELOG.md");
  if (changelog !== null) {
    const newest = /^## v?(\d+\.\d+\.\d+\S*)\s*$/m.exec(changelog)?.[1];
    if (newest !== version) {
      problems.push(`CHANGELOG.md's newest version is ${newest ?? "(none)"}, expected ${version}`);
    }
  }

  if (tag !== null && tag !== `v${version}`) problems.push(`tag ${tag} does not match version v${version}`);
}

const packed = read("mcpb/server/agy-bridge.mjs");
if (source !== null && packed !== null && packed !== source) {
  problems.push(
    "mcpb/server/agy-bridge.mjs differs from agy-bridge.mjs — copy it over before packing:\n" +
      "    cp agy-bridge.mjs mcpb/server/agy-bridge.mjs"
  );
}

if (problems.length) {
  console.error("release check FAILED:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`release check OK: ${version}${tag ? ` (tag ${tag})` : ""}`);
