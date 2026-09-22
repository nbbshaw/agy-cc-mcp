/**
 * Tests for scripts/pack.mjs, the zero-dependency .mcpb builder the release workflow uses.
 *
 * What this guards: that each bundle is a valid ZIP with exactly the expected entries;
 * that it carries the ROOT agy-bridge.mjs even when mcpb/server/ has drifted (1.3.0
 * shipped a stale copy); that CRLF checkouts produce the same LF bundle as LF ones;
 * and that the output is reproducible — fixed timestamps and headers — so SHA256SUMS
 * for a tag can be rebuilt and checked by anyone. Runs on every OS; needs no zip binary.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const PACK_SCRIPT = path.join(REPO_ROOT, "scripts", "pack.mjs");

const tempDirs = [];
function makeTempDir(prefix = "pack-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore errors during temp directory cleanup
    }
  }
});

const normalizeLf = (strOrBuf) => {
  const str = typeof strOrBuf === "string" ? strOrBuf : strOrBuf.toString("utf8");
  return str.replace(/\r\n/g, "\n");
};

// CRC-32 implementation (reused in test, independent of pack.mjs)
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c >>> 0;
}

function calculateCrc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Small ZIP reader: finds EOCD, reads central directory, inflates entries
function parseZip(zipBuf) {
  let eocdOffset = -1;
  for (let i = zipBuf.length - 22; i >= 0; i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  assert.notEqual(eocdOffset, -1, "EOCD record not found in zip");

  const entryCount = zipBuf.readUInt16LE(eocdOffset + 10);
  const cdOffset = zipBuf.readUInt32LE(eocdOffset + 16);

  const entries = [];
  let curCd = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    const cdSig = zipBuf.readUInt32LE(curCd);
    assert.equal(cdSig, 0x02014b50, `Invalid CD header signature at offset ${curCd}`);
    const versionMadeBy = zipBuf.readUInt16LE(curCd + 4);
    const flags = zipBuf.readUInt16LE(curCd + 8);
    const method = zipBuf.readUInt16LE(curCd + 10);
    const time = zipBuf.readUInt16LE(curCd + 12);
    const date = zipBuf.readUInt16LE(curCd + 14);
    const externalAttrs = zipBuf.readUInt32LE(curCd + 38);
    const crc = zipBuf.readUInt32LE(curCd + 16);
    const compSize = zipBuf.readUInt32LE(curCd + 20);
    const uncompSize = zipBuf.readUInt32LE(curCd + 24);
    const nameLen = zipBuf.readUInt16LE(curCd + 28);
    const extraLen = zipBuf.readUInt16LE(curCd + 30);
    const commentLen = zipBuf.readUInt16LE(curCd + 32);
    const localHeaderOffset = zipBuf.readUInt32LE(curCd + 42);
    const name = zipBuf.toString("utf8", curCd + 46, curCd + 46 + nameLen);

    const localSig = zipBuf.readUInt32LE(localHeaderOffset);
    assert.equal(localSig, 0x04034b50, `Invalid local header signature at ${localHeaderOffset}`);
    const localNameLen = zipBuf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = zipBuf.readUInt16LE(localHeaderOffset + 28);
    const local = {
      flags: zipBuf.readUInt16LE(localHeaderOffset + 6),
      method: zipBuf.readUInt16LE(localHeaderOffset + 8),
      time: zipBuf.readUInt16LE(localHeaderOffset + 10),
      date: zipBuf.readUInt16LE(localHeaderOffset + 12),
      crc: zipBuf.readUInt32LE(localHeaderOffset + 14),
      extraLen: localExtraLen,
    };
    const dataOffset = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const compData = zipBuf.subarray(dataOffset, dataOffset + compSize);

    let data;
    if (method === 8) {
      data = zlib.inflateRawSync(compData);
    } else if (method === 0) {
      data = compData;
    } else {
      assert.fail(`Unsupported compression method ${method}`);
    }

    entries.push({ name, data, crc, compSize, uncompSize, versionMadeBy, flags, method, time, date, externalAttrs, extraLen, commentLen, local });
    curCd += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

// Pinned so a rebuild is byte-identical: 1980-01-01 00:00, UNIX 0644, UTF-8 names, deflate.
function assertReproducibleHeaders(entry) {
  const where = `entry ${entry.name}`;
  assert.equal(entry.time, 0, `${where}: DOS time must be fixed at 00:00:00`);
  assert.equal(entry.date, 33, `${where}: DOS date must be fixed at 1980-01-01`);
  assert.equal(entry.flags, 0x0800, `${where}: general purpose flag`);
  assert.equal(entry.method, 8, `${where}: compression method`);
  assert.equal(entry.versionMadeBy, (3 << 8) | 20, `${where}: version made by`);
  assert.equal(entry.externalAttrs, (0o100644 << 16) >>> 0, `${where}: external attributes`);
  assert.equal(entry.extraLen, 0, `${where}: central extra field`);
  assert.equal(entry.commentLen, 0, `${where}: comment`);
  assert.deepEqual(entry.local, { flags: entry.flags, method: entry.method, time: 0, date: 33, crc: entry.crc, extraLen: 0 },
    `${where}: local header disagrees with central directory`);
}

test("pack.mjs builds valid, reproducible bundles, standalone script and SHA256SUMS", () => {
  const tempDir1 = makeTempDir("pack-out-1-");
  const tempDir2 = makeTempDir("pack-out-2-");

  // Run pack.mjs into tempDir1
  const res1 = spawnSync(process.execPath, [PACK_SCRIPT, "--out", tempDir1], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(res1.status, 0, `pack failed: ${res1.stderr}`);

  // Assert the four output files exist
  const expectedFiles = ["agy-bridge.mcpb", "agy-bridge-dev.mcpb", "agy-bridge.mjs", "SHA256SUMS"];
  for (const file of expectedFiles) {
    assert.ok(fs.existsSync(path.join(tempDir1, file)), `Expected file ${file} missing`);
  }

  // Run pack.mjs into tempDir2 and assert byte-identical outputs
  const res2 = spawnSync(process.execPath, [PACK_SCRIPT, "--out", tempDir2], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(res2.status, 0, `pack second run failed: ${res2.stderr}`);

  for (const file of expectedFiles) {
    const buf1 = fs.readFileSync(path.join(tempDir1, file));
    const buf2 = fs.readFileSync(path.join(tempDir2, file));
    assert.ok(buf1.equals(buf2), `File ${file} is not byte-identical between runs`);
  }

  // Source contents (CRLF normalised to LF)
  const rootBridge = normalizeLf(fs.readFileSync(path.join(REPO_ROOT, "agy-bridge.mjs")));
  const mcpbManifest = normalizeLf(fs.readFileSync(path.join(REPO_ROOT, "mcpb", "manifest.json")));
  const devManifest = normalizeLf(fs.readFileSync(path.join(REPO_ROOT, "mcpb-dev", "manifest.json")));
  const devLoader = normalizeLf(fs.readFileSync(path.join(REPO_ROOT, "mcpb-dev", "server", "dev-loader.mjs")));

  // Assert standalone agy-bridge.mjs matches source with CRLF normalised to LF
  const standaloneContent = normalizeLf(fs.readFileSync(path.join(tempDir1, "agy-bridge.mjs")));
  assert.equal(standaloneContent, rootBridge, "standalone agy-bridge.mjs does not match root source");

  // Parse agy-bridge.mcpb
  const mcpbBuf = fs.readFileSync(path.join(tempDir1, "agy-bridge.mcpb"));
  const mcpbEntries = parseZip(mcpbBuf);
  assert.deepEqual(
    mcpbEntries.map((e) => e.name),
    ["manifest.json", "server/agy-bridge.mjs"],
    "agy-bridge.mcpb entry names or order incorrect"
  );
  for (const entry of mcpbEntries) {
    assert.equal(calculateCrc32(entry.data), entry.crc, `CRC mismatch for entry ${entry.name}`);
    assert.equal(entry.data.length, entry.uncompSize, `Size mismatch for entry ${entry.name}`);
    assertReproducibleHeaders(entry);
  }
  assert.equal(mcpbEntries[0].data.toString("utf8"), mcpbManifest, "mcpb manifest.json content mismatch");
  assert.equal(mcpbEntries[1].data.toString("utf8"), rootBridge, "mcpb server/agy-bridge.mjs content mismatch");

  // Parse agy-bridge-dev.mcpb
  const devMcpbBuf = fs.readFileSync(path.join(tempDir1, "agy-bridge-dev.mcpb"));
  const devEntries = parseZip(devMcpbBuf);
  assert.deepEqual(
    devEntries.map((e) => e.name),
    ["manifest.json", "server/dev-loader.mjs"],
    "agy-bridge-dev.mcpb entry names or order incorrect"
  );
  for (const entry of devEntries) {
    assert.equal(calculateCrc32(entry.data), entry.crc, `CRC mismatch for dev entry ${entry.name}`);
    assert.equal(entry.data.length, entry.uncompSize, `Size mismatch for dev entry ${entry.name}`);
    assertReproducibleHeaders(entry);
  }
  assert.equal(devEntries[0].data.toString("utf8"), devManifest, "dev manifest.json content mismatch");
  assert.equal(devEntries[1].data.toString("utf8"), devLoader, "dev server/dev-loader.mjs content mismatch");

  // Parse manifest JSON inside each bundle and check version
  const parsedMcpbManifest = JSON.parse(mcpbEntries[0].data.toString("utf8"));
  const parsedDevManifest = JSON.parse(devEntries[0].data.toString("utf8"));
  const expectedRootManifest = JSON.parse(mcpbManifest);
  assert.equal(parsedMcpbManifest.version, expectedRootManifest.version);
  assert.equal(parsedDevManifest.version, expectedRootManifest.version);

  // Assert SHA256SUMS lines match crypto sha256 of each file and are sorted
  const sumsText = fs.readFileSync(path.join(tempDir1, "SHA256SUMS"), "utf8");
  assert.ok(sumsText.endsWith("\n"), "SHA256SUMS must end with a newline");
  const sumLines = sumsText.trimEnd().split("\n");
  assert.equal(sumLines.length, 3, "SHA256SUMS should contain exactly 3 lines");

  const sumFilenames = [];
  for (const line of sumLines) {
    const match = /^([0-9a-f]{64})  (\S+)$/.exec(line);
    assert.ok(match, `Invalid SHA256SUMS line format: ${line}`);
    const [, hash, filename] = match;
    sumFilenames.push(filename);
    const fileBuf = fs.readFileSync(path.join(tempDir1, filename));
    const computedHash = crypto.createHash("sha256").update(fileBuf).digest("hex");
    assert.equal(hash, computedHash, `SHA256 mismatch for ${filename}`);
  }

  const sortedFilenames = [...sumFilenames].sort();
  assert.deepEqual(sumFilenames, sortedFilenames, "SHA256SUMS entries must be sorted by filename");
  assert.deepEqual(
    sumFilenames,
    ["agy-bridge-dev.mcpb", "agy-bridge.mcpb", "agy-bridge.mjs"],
    "SHA256SUMS filenames do not match expected set"
  );
});

test("agy-bridge.mcpb packs root agy-bridge.mjs even when mcpb/server/ is stale", () => {
  const staleRepo = makeTempDir("stale-repo-");
  const staleOut = makeTempDir("stale-out-");

  // Copy agy-bridge.mjs, mcpb/, mcpb-dev/, and scripts/pack.mjs into temp repo
  // Written with CRLF so normalisation is exercised even on an LF checkout (Linux CI).
  const lfSource = normalizeLf(fs.readFileSync(path.join(REPO_ROOT, "agy-bridge.mjs")));
  fs.writeFileSync(path.join(staleRepo, "agy-bridge.mjs"), lfSource.replace(/\n/g, "\r\n"));
  fs.cpSync(path.join(REPO_ROOT, "mcpb"), path.join(staleRepo, "mcpb"), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, "mcpb-dev"), path.join(staleRepo, "mcpb-dev"), { recursive: true });
  fs.mkdirSync(path.join(staleRepo, "scripts"), { recursive: true });
  fs.copyFileSync(PACK_SCRIPT, path.join(staleRepo, "scripts", "pack.mjs"));

  // Append a stale line to the copy in mcpb/server/agy-bridge.mjs
  const staleServerFile = path.join(staleRepo, "mcpb", "server", "agy-bridge.mjs");
  fs.appendFileSync(staleServerFile, "\n// STALE COPY DRIFT LINE ADDED FOR TEST\n");

  // Run the temp copy of pack.mjs
  const res = spawnSync(
    process.execPath,
    [path.join(staleRepo, "scripts", "pack.mjs"), "--out", staleOut],
    {
      cwd: staleRepo,
      encoding: "utf8",
    }
  );
  assert.equal(res.status, 0, `pack in temp repo failed: ${res.stderr}`);

  // Check the bundle carries the unmodified root file
  const bundleBuf = fs.readFileSync(path.join(staleOut, "agy-bridge.mcpb"));
  const entries = parseZip(bundleBuf);
  const serverEntry = entries.find((e) => e.name === "server/agy-bridge.mjs");
  assert.ok(serverEntry, "server/agy-bridge.mjs entry not found in bundle");

  const rootBridge = normalizeLf(fs.readFileSync(path.join(REPO_ROOT, "agy-bridge.mjs")));
  const entryText = serverEntry.data.toString("utf8");
  assert.equal(entryText, rootBridge, "server/agy-bridge.mjs in bundle must match root agy-bridge.mjs");
  assert.ok(!entryText.includes("STALE COPY DRIFT LINE"), "bundle erroneously included stale mcpb/server copy");
  assert.ok(!entryText.includes("\r"), "CRLF source must be packed as LF");
  const standalone = fs.readFileSync(path.join(staleOut, "agy-bridge.mjs"), "utf8");
  assert.ok(!standalone.includes("\r"), "standalone agy-bridge.mjs must be LF");
});
