// Writes src/pinnedLock.ts: every package `npm install <NPM_PACKAGE>` puts in node_modules, with the tarball URL and
// the integrity hash the registry gives for it. The extension downloads exactly these once into its global storage
// (src/pinned.ts) and runs craftos-mcp with node, without npx. Run it after bumping NPM_PACKAGE in src/launcher.ts:
//
//   node pin-lock.mjs
//
// The unit tests fail while the lock and NPM_PACKAGE disagree.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const launcher = readFileSync(join(here, "src", "launcher.ts"), "utf8");
const spec = /export const NPM_PACKAGE = "([^"]+)"/.exec(launcher)?.[1];
if (!spec) throw new Error("no NPM_PACKAGE in src/launcher.ts");
const [, name, version] = /^(.+)@(\d+\.\d+\.\d+)$/.exec(spec) ?? [];
if (!name) throw new Error(`NPM_PACKAGE ${spec} is not name@x.y.z`);

const dir = mkdtempSync(join(tmpdir(), "craftos-pin-"));
try {
  writeFileSync(
    join(dir, "package.json"),
    '{ "name": "pin", "private": true }\n',
  );
  const npm = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    [
      "install",
      spec,
      "--package-lock-only",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    { cwd: dir, stdio: "inherit", shell: process.platform === "win32" },
  );
  if (npm.status !== 0) throw new Error(`npm install ${spec} failed`);
  const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8"));
  const packages = [];
  for (const [path, p] of Object.entries(lock.packages ?? {})) {
    if (!path) continue;
    if (p.dev || p.optional || p.os || p.cpu)
      throw new Error(
        `${path} is dev, optional or platform-specific: src/pinned.ts does not handle that yet`,
      );
    if (!/^sha(256|384|512)-/.test(p.integrity ?? ""))
      throw new Error(`${path} has no sha256/384/512 integrity`);
    if (!String(p.resolved).startsWith("https://registry.npmjs.org/"))
      throw new Error(`${path} is not from registry.npmjs.org: ${p.resolved}`);
    packages.push({
      path,
      version: p.version,
      resolved: p.resolved,
      integrity: p.integrity,
    });
  }
  const root = lock.packages[`node_modules/${name}`];
  if (root?.version !== version)
    throw new Error(`the lock has ${name}@${root?.version}, not ${version}`);
  // the root package's hash is the registry's own, as `npm view` gives it
  const view = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["view", spec, "dist.integrity"],
    {
      encoding: "utf8",
      shell: process.platform === "win32",
    },
  );
  if (view.stdout.trim() !== root.integrity)
    throw new Error(`${spec}: the lock's integrity is not the registry's`);
  const bin = typeof root.bin === "string" ? root.bin : root.bin?.[name];
  if (!bin) throw new Error(`${spec} has no bin`);
  const out = {
    spec,
    bin,
    packages: packages.sort((a, b) => a.path.localeCompare(b.path)),
  };
  writeFileSync(
    join(here, "src", "pinnedLock.ts"),
    "// Written by pin-lock.mjs from `npm install " +
      spec +
      "`: do not edit. What src/pinned.ts downloads, each tarball checked\n" +
      "// against the integrity hash the npm registry gives for it.\n" +
      'import type { PinnedLock } from "./pinned.ts";\n\n' +
      `export const PINNED_LOCK: PinnedLock = ${JSON.stringify(out, null, 2)};\n`,
  );
  console.log(`src/pinnedLock.ts: ${spec}, ${packages.length} packages`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
