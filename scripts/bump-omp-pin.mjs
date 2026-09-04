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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
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
  console.error(
    `failed to resolve latest ${REPO} release: ${releaseResponse.status} ${releaseResponse.statusText}`,
  );
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
const hostKey = `${process.platform}-${process.arch}`;
for (const platformKey of PLATFORMS) {
  const url = `${releaseBase}/omp-${platformKey}`;
  console.log(`hashing ${url}`);
  const assetResponse = await fetch(url);
  if (!assetResponse.ok) {
    console.error(
      `download failed for ${url}: ${assetResponse.status} ${assetResponse.statusText}`,
    );
    process.exit(1);
  }
  const bytes = new Uint8Array(await assetResponse.arrayBuffer());
  platforms[platformKey] = createHash("sha256").update(bytes).digest("hex");
  if (platformKey === hostKey) assertSettingsSurface(bytes, tag);
}

/**
 * The Settings page (ADR-0011) needs `omp config schema --json` and
 * `omp config unset`, which landed upstream via can1357/oh-my-pi#10847.
 * While the pin points at a fork release carrying them, an upstream
 * release without them must not replace it — refuse the bump loudly
 * instead of opening a PR the smoke suite would fail anyway.
 */
function assertSettingsSurface(bytes, releaseTag) {
  const dir = mkdtempSync(join(tmpdir(), "omp-pin-bump-"));
  const binary = join(dir, "omp");
  writeFileSync(binary, bytes, { mode: 0o755 });
  const agentDir = mkdtempSync(join(tmpdir(), "omp-pin-bump-agent-"));
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  const schema = spawnSync(binary, ["config", "schema", "--json"], {
    env,
    cwd: dir,
    encoding: "utf8",
  });
  const unset = spawnSync(binary, ["config", "unset", "autoResume"], {
    env,
    cwd: dir,
    encoding: "utf8",
  });
  rmSync(dir, { recursive: true, force: true });
  rmSync(agentDir, { recursive: true, force: true });
  if (schema.status !== 0 || unset.status !== 0) {
    console.error(
      `${releaseTag} lacks \`omp config schema --json\` / \`omp config unset\` (ADR-0011); keeping the current pin (${pin.releaseBase}). See can1357/oh-my-pi#10847.`,
    );
    process.exit(1);
  }
}

writeFileSync(pinPath, `${JSON.stringify({ ...pin, version, releaseBase, platforms }, null, 2)}\n`);
console.log(`wrote ${pinPath}`);

const ipcPackage = JSON.parse(readFileSync(ipcPackagePath, "utf8"));
if (ipcPackage.dependencies?.[pin.npmPackage] !== undefined) {
  ipcPackage.dependencies[pin.npmPackage] = version;
  writeFileSync(ipcPackagePath, `${JSON.stringify(ipcPackage, null, 2)}\n`);
  console.log(`wrote ${ipcPackagePath} (${pin.npmPackage}@${version})`);
}
