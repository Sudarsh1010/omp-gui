#!/usr/bin/env node
/**
 * ADR-0008 weekly pin bump: resolves the latest can1357/oh-my-pi GitHub
 * release, downloads each platform's `omp` binary asset, and rewrites:
 *   - omp-pin.json (ADR-0004): version, releaseBase, per-platform sha256
 *   - platform/ipc/package.json: the "@oh-my-pi/pi-coding-agent" dependency
 *     pin, so `tsc` typechecks platform/ipc/src/session/session.ts's
 *     `rpc-types.ts` import against the SAME release the binary pin points
 *     at (ADR-0007's "compiler is the wire-compat checker" only holds when
 *     both pins move together).
 *
 * Does not run `pnpm install` or fetch the binary itself -- the caller (the
 * weekly workflow, or a human) does that afterward so the lockfile updates
 * and the smoke suite can run against the fresh pin.
 *
 * Usage: node scripts/bump-omp-pin.mjs
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "can1357/oh-my-pi";
const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pinPath = join(root, "omp-pin.json");
const ipcPackagePath = join(root, "platform", "ipc", "package.json");
const pin = JSON.parse(readFileSync(pinPath, "utf8"));

const releaseHeaders = { Accept: "application/vnd.github+json", "User-Agent": "omp-gui-pin-bump" };
if (process.env.GITHUB_TOKEN) releaseHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

const releaseResponse = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
  headers: releaseHeaders,
});
if (!releaseResponse.ok) {
  console.error(`failed to resolve latest ${REPO} release: ${releaseResponse.status} ${releaseResponse.statusText}`);
  process.exit(1);
}
const release = await releaseResponse.json();
const tag = release.tag_name;
if (typeof tag !== "string" || !tag.startsWith("v")) {
  console.error(`unexpected release tag shape: ${JSON.stringify(tag)}`);
  process.exit(1);
}

const version = tag.slice(1);
if (version === pin.version) {
  console.log(`omp-pin.json is already pinned to the latest release (${version}); nothing to do`);
  process.exit(0);
}

const releaseBase = `https://github.com/${REPO}/releases/download/${tag}`;
console.log(`bumping omp pin ${pin.version} -> ${version}`);

const platforms = {};
for (const platformKey of PLATFORMS) {
  const url = `${releaseBase}/omp-${platformKey}`;
  console.log(`hashing ${url}`);
  const assetResponse = await fetch(url);
  if (!assetResponse.ok) {
    console.error(`download failed for ${url}: ${assetResponse.status} ${assetResponse.statusText}`);
    process.exit(1);
  }
  const bytes = new Uint8Array(await assetResponse.arrayBuffer());
  platforms[platformKey] = createHash("sha256").update(bytes).digest("hex");
}

writeFileSync(pinPath, `${JSON.stringify({ ...pin, version, releaseBase, platforms }, null, 2)}\n`);
console.log(`wrote ${pinPath}`);

const ipcPackage = JSON.parse(readFileSync(ipcPackagePath, "utf8"));
if (ipcPackage.dependencies?.[pin.npmPackage] !== undefined) {
  ipcPackage.dependencies[pin.npmPackage] = version;
  writeFileSync(ipcPackagePath, `${JSON.stringify(ipcPackage, null, 2)}\n`);
  console.log(`wrote ${ipcPackagePath} (${pin.npmPackage}@${version})`);
}
