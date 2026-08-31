#!/usr/bin/env node
/**
 * Fetches the pinned omp binary (see omp-pin.json, ADR-0004) for the host
 * platform into crates/shell/binaries/omp, verifying the pinned SHA-256.
 *
 * Usage: node scripts/fetch-omp.mjs [--force]
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pin = JSON.parse(readFileSync(join(root, "omp-pin.json"), "utf8"));
const dest = join(root, "crates", "shell", "binaries", "omp");

const platformKey = `${process.platform}-${process.arch}`;
const expectedSha = pin.platforms[platformKey];
if (!expectedSha) {
  console.error(`no pinned omp binary for platform ${platformKey}`);
  process.exit(1);
}

if (existsSync(dest) && !process.argv.includes("--force")) {
  const actual = createHash("sha256").update(readFileSync(dest)).digest("hex");
  if (actual === expectedSha) {
    console.log(`omp ${pin.version} already fetched and verified (${platformKey})`);
    process.exit(0);
  }
  console.warn(`existing binary sha256 mismatch (${actual}); re-fetching`);
}

const url = `${pin.releaseBase}/omp-${platformKey}`;
console.log(`downloading ${url}`);
const response = await fetch(url);
if (!response.ok || !response.body) {
  console.error(`download failed: ${response.status} ${response.statusText}`);
  process.exit(1);
}

mkdirSync(dirname(dest), { recursive: true });
const tmp = `${dest}.tmp`;
await pipeline(response.body, createWriteStream(tmp));
chmodSync(tmp, 0o755);

const actual = createHash("sha256").update(readFileSync(tmp)).digest("hex");
if (actual !== expectedSha) {
  console.error(`sha256 mismatch: expected ${expectedSha}, got ${actual}`);
  process.exit(1);
}
renameSync(tmp, dest);
console.log(`fetched omp ${pin.version} (${platformKey}) -> ${dest}`);
