#!/usr/bin/env node
/**
 * Release packager for agy-bridge.
 *
 * Builds reproducible Claude Desktop / Cowork extension bundles (.mcpb), copies
 * the standalone server script, and writes SHA256SUMS.
 *
 * The zip CLI is not available on Windows dev machines, so this produces
 * deterministic zip archives using only Node standard library modules.
 * To ensure byte-identical outputs across operating systems:
 *   - CRLF line endings are normalised to LF for all packed files;
 *   - a fixed DOS timestamp is used (1980-01-01 00:00:00);
 *   - entry order and zip headers are fixed without extra fields or comments.
 *
 * To avoid shipping stale server code (which happened in release 1.3.0),
 * agy-bridge.mcpb always packs the repository root agy-bridge.mjs directly,
 * never the hand-maintained copy in mcpb/server/.
 *
 * Usage:
 *   node scripts/pack.mjs [--out <dir>]
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

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

function createZip(entries) {
  const localChunks = [];
  const cdChunks = [];
  let currentOffset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const uncompSize = entry.data.length;
    const crc = calculateCrc32(entry.data);
    const compressedData = zlib.deflateRawSync(entry.data, { level: 9 });
    const compSize = compressedData.length;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
    localHeader.writeUInt16LE(20, 4);         // version needed to extract (2.0)
    localHeader.writeUInt16LE(0x0800, 6);     // general purpose bit flag (UTF-8)
    localHeader.writeUInt16LE(8, 8);          // compression method: deflate
    localHeader.writeUInt16LE(0, 10);         // last mod file time: 00:00:00
    localHeader.writeUInt16LE(33, 12);        // last mod file date: 1980-01-01
    localHeader.writeUInt32LE(crc, 14);       // crc-32
    localHeader.writeUInt32LE(compSize, 18);  // compressed size
    localHeader.writeUInt32LE(uncompSize, 22);// uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26); // file name length
    localHeader.writeUInt16LE(0, 28);         // extra field length: 0

    const entryOffset = currentOffset;
    localChunks.push(localHeader, nameBuf, compressedData);
    currentOffset += 30 + nameBuf.length + compSize;

    const cdHeader = Buffer.alloc(46);
    cdHeader.writeUInt32LE(0x02014b50, 0);            // central directory header signature
    cdHeader.writeUInt16LE((3 << 8) | 20, 4);         // version made by (UNIX, 20)
    cdHeader.writeUInt16LE(20, 6);                    // version needed to extract
    cdHeader.writeUInt16LE(0x0800, 8);                // general purpose bit flag (UTF-8)
    cdHeader.writeUInt16LE(8, 10);                    // compression method: deflate
    cdHeader.writeUInt16LE(0, 12);                    // last mod file time: 00:00:00
    cdHeader.writeUInt16LE(33, 14);                   // last mod file date: 1980-01-01
    cdHeader.writeUInt32LE(crc, 16);                  // crc-32
    cdHeader.writeUInt32LE(compSize, 20);             // compressed size
    cdHeader.writeUInt32LE(uncompSize, 24);           // uncompressed size
    cdHeader.writeUInt16LE(nameBuf.length, 28);       // file name length
    cdHeader.writeUInt16LE(0, 30);                    // extra field length: 0
    cdHeader.writeUInt16LE(0, 32);                    // file comment length: 0
    cdHeader.writeUInt16LE(0, 34);                    // disk number start: 0
    cdHeader.writeUInt16LE(0, 36);                    // internal file attributes: 0
    cdHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38);// external file attributes (regular file)
    cdHeader.writeUInt32LE(entryOffset, 42);          // relative offset of local header

    cdChunks.push(cdHeader, nameBuf);
  }

  const cdOffset = currentOffset;
  const cdBuffer = Buffer.concat(cdChunks);
  const cdSize = cdBuffer.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);       // end of central dir signature
  eocd.writeUInt16LE(0, 4);                // number of this disk: 0
  eocd.writeUInt16LE(0, 6);                // number of disk with start of CD: 0
  eocd.writeUInt16LE(entries.length, 8);   // total entries on this disk
  eocd.writeUInt16LE(entries.length, 10);  // total entries in CD
  eocd.writeUInt32LE(cdSize, 12);          // CD size
  eocd.writeUInt32LE(cdOffset, 16);        // CD offset
  eocd.writeUInt16LE(0, 20);               // comment length: 0

  return Buffer.concat([...localChunks, cdBuffer, eocd]);
}

function readNormalized(filePath) {
  const content = fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
  return Buffer.from(content, "utf8");
}

function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const argv = process.argv.slice(2);
  let outDir = path.join(repoRoot, "dist");

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") {
      const val = argv[++i];
      if (!val) {
        throw new Error("--out requires a directory path");
      }
      outDir = path.resolve(process.cwd(), val);
    } else {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
  }

  fs.mkdirSync(outDir, { recursive: true });

  const rootBridge = readNormalized(path.join(repoRoot, "agy-bridge.mjs"));
  const mcpbManifest = readNormalized(path.join(repoRoot, "mcpb", "manifest.json"));
  const devManifest = readNormalized(path.join(repoRoot, "mcpb-dev", "manifest.json"));
  const devLoader = readNormalized(path.join(repoRoot, "mcpb-dev", "server", "dev-loader.mjs"));

  const agyBridgeMcpb = createZip([
    { name: "manifest.json", data: mcpbManifest },
    { name: "server/agy-bridge.mjs", data: rootBridge },
  ]);

  const agyBridgeDevMcpb = createZip([
    { name: "manifest.json", data: devManifest },
    { name: "server/dev-loader.mjs", data: devLoader },
  ]);

  const outputs = [
    { name: "agy-bridge.mcpb", data: agyBridgeMcpb },
    { name: "agy-bridge-dev.mcpb", data: agyBridgeDevMcpb },
    { name: "agy-bridge.mjs", data: rootBridge },
  ];

  // Write files
  for (const item of outputs) {
    fs.writeFileSync(path.join(outDir, item.name), item.data);
  }

  // SHA256SUMS covering the three files, sorted by filename
  const sorted = [...outputs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const sumsLines = sorted.map((item) => {
    const hash = crypto.createHash("sha256").update(item.data).digest("hex");
    return `${hash}  ${item.name}\n`;
  });
  const sumsBuf = Buffer.from(sumsLines.join(""), "utf8");
  fs.writeFileSync(path.join(outDir, "SHA256SUMS"), sumsBuf);

  // Print one line per output file with size and sha256
  const allOutputs = [...sorted, { name: "SHA256SUMS", data: sumsBuf }];
  for (const item of allOutputs) {
    const hash = crypto.createHash("sha256").update(item.data).digest("hex");
    console.log(`${item.name}: ${item.data.length} bytes, sha256 ${hash}`);
  }
}

try {
  main();
} catch (err) {
  console.error(`pack failed: ${err.message}`);
  process.exit(1);
}
