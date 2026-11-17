// Build the `craftos-mcp` npm package from a public export (scripts/export-public.mjs), never from the private tree.
//
//   node scripts/pack-npm.mjs <export dir> [--out <folder>] [--version <x.y.z>]
//
// Builds the export (npm ci when it has no node_modules, then npm run build), stages the package and runs npm pack;
// the tarball lands in --out (default: the current folder). The version is server.json's unless --version says.
//
// The package keeps the clone's layout, so every path the code finds through import.meta.url still holds: the
// compiled JS of apps/cli, apps/mcp-server and packages/{runner,rawterm,protocol} (tests and .d.ts left out, the
// @craftos-mcp/* imports turned into relative paths), the ccsim overlay, worlds, the ccunit Lua, the browser app and
// the scripts the first run needs. It never holds the CC:Tweaked ROM, Tom's Peripherals' fonts or the engine: the
// first run fetches and builds those per user (scripts/npm/first-run.mjs). craftos-package.json marks the install
// (packages/runner/src/config.ts packageVersion).
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const WINDOWS = process.platform === "win32";
const REPO_URL = "https://github.com/Akkiruk/craftos-mcp";

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (!value) fail(`${name} needs a value`);
  args.splice(at, 2);
  return value;
};
const outDir = resolve(option("--out") ?? process.cwd());
const versionOption = option("--version");
if (args.length !== 1)
  fail(
    "usage: node scripts/pack-npm.mjs <export dir> [--out <folder>] [--version <x.y.z>]",
  );
const SRC = resolve(args[0]);

function fail(message) {
  console.error(message);
  process.exit(2);
}

function run(command, argv, cwd) {
  const [file, list] =
    WINDOWS && command === "npm"
      ? ["cmd.exe", ["/d", "/s", "/c", ["npm", ...argv].join(" ")]]
      : [command, argv];
  const result = spawnSync(file, list, {
    cwd,
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(`${command} ${argv.join(" ")} failed in ${cwd}`);
  return result.stdout;
}

function walk(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else found.push(full);
  }
  return found;
}

const posix = (p) => p.split("\\").join("/");

for (const need of [
  "package.json",
  "apps/cli/src",
  "packages/runner/src",
  "rom-overlay",
])
  if (!existsSync(join(SRC, need)))
    fail(`${SRC} is not a public export (no ${need})`);
// the export leaves its own script behind: finding it means this is the private tree
if (existsSync(join(SRC, "scripts", "export-public.mjs")))
  fail(
    `${SRC} is the private tree: pack only from scripts/export-public.mjs output`,
  );

const server = JSON.parse(readFileSync(join(SRC, "server.json"), "utf8"));
const version = versionOption ?? server.version;
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? ""))
  fail(`bad version ${version}`);

// ---- build the export ----
if (!existsSync(join(SRC, "node_modules", "typescript"))) {
  console.log("npm ci in the export");
  run("npm", ["ci", "--no-audit", "--no-fund"], SRC);
}
console.log("npm run build in the export");
run("npm", ["run", "build"], SRC);

// ---- stage ----
const STAGE = mkdtempSync(join(tmpdir(), "craftos-mcp-pack-"));
const PKG = join(STAGE, "package");
mkdirSync(PKG);

/** Where each workspace package's entry lands in the package. */
const ENTRIES = {
  "@craftos-mcp/cli": "apps/cli/dist/index.js",
  "@craftos-mcp/mcp-server": "apps/mcp-server/dist/index.js",
  "@craftos-mcp/runner": "packages/runner/dist/index.js",
  "@craftos-mcp/rawterm": "packages/rawterm/dist/index.js",
  "@craftos-mcp/protocol": "packages/protocol/dist/index.js",
};
const RUNTIME_DEPS = new Set(); // bare imports left after the rewrite: they become dependencies
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"']+)\2/g;

function stageJs(rel) {
  const text = readFileSync(join(SRC, rel), "utf8").replace(/\r\n/g, "\n");
  if (/from\s*["']vitest["']/.test(text)) return false; // a test or a test helper
  const out = text.replace(SPECIFIER, (whole, lead, quote, spec) => {
    if (spec.startsWith(".") || spec.startsWith("node:")) return whole;
    // text that only looks like an import (`"from":"src"` in a tool description) names no package
    if (!/^(@[\w.-]+\/)?[\w.-]+(\/[\w./-]*)?$/.test(spec)) return whole;
    const entry = ENTRIES[spec];
    if (entry) {
      let to = posix(relative(dirname(rel), entry));
      if (!to.startsWith(".")) to = `./${to}`;
      return `${lead}${quote}${to}${quote}`;
    }
    const name = spec.startsWith("@")
      ? spec.split("/").slice(0, 2).join("/")
      : spec.split("/")[0];
    RUNTIME_DEPS.add(name);
    return whole;
  });
  mkdirSync(dirname(join(PKG, rel)), { recursive: true });
  writeFileSync(join(PKG, rel), out);
  return true;
}

let jsFiles = 0;
for (const dist of [
  "apps/cli/dist",
  "apps/mcp-server/dist",
  "packages/runner/dist",
  "packages/rawterm/dist",
  "packages/protocol/dist",
]) {
  for (const file of walk(join(SRC, dist))) {
    const rel = posix(relative(SRC, file));
    if (!rel.endsWith(".js") || /\.test\.js$/.test(rel)) continue;
    if (stageJs(rel)) jsFiles++;
  }
}

/** Copied as they are (text files with LF endings). */
const COPY = [
  "packages/runner/lua",
  "packages/runner/webapp",
  "packages/rawterm/assets",
  "rom-overlay",
  "worlds",
  "scripts/rom-patches",
  "scripts/build-rom.mjs",
  "scripts/build-toms-fonts.mjs",
  "scripts/setup.mjs",
  "scripts/npm",
  "LICENSE",
  "NOTICE.md",
  "README.md",
  // what the MCP server serves as craftos://docs/<name> and craftos://examples/<path>
  "docs",
  "workspace/examples",
];
/** Left out of COPY's folders: pictures and the docs' subfolders, and the games (megabytes, and in the repo). */
const SKIP = [/^docs\/.+\//, /^workspace\/examples\/games\//];
const NEVER = [
  /(^|\/)fonts\.lua$/, // Tom's Peripherals' fonts: built per user
  /^rom\//, // a built CC:Tweaked ROM
  /(^|\/)bios\.lua$/,
  /\.(exe|dll|so(\.\d+)*|dylib|jar|zip)$/i, // the engine, jars
];
for (const item of COPY) {
  const from = join(SRC, item);
  if (!existsSync(from)) fail(`${item} is missing from the export`);
  const files = statSync(from).isDirectory() ? walk(from) : [from];
  for (const file of files) {
    const rel = posix(relative(SRC, file));
    if (NEVER.some((re) => re.test(rel)) || SKIP.some((re) => re.test(rel)))
      continue;
    const dest = join(PKG, rel);
    mkdirSync(dirname(dest), { recursive: true });
    const buf = readFileSync(file);
    if (/\.(m?js|lua|json|md|html|css|txt)$/i.test(rel) && !buf.includes(0))
      writeFileSync(dest, buf.toString("utf8").replace(/\r\n/g, "\n"));
    else cpSync(file, dest);
  }
}
writeFileSync(
  join(PKG, "craftos-package.json"),
  JSON.stringify({ version }, null, 2) + "\n",
);

// ---- package.json ----
const exportPkg = (p) =>
  JSON.parse(readFileSync(join(SRC, p, "package.json"), "utf8"));
const known = {};
for (const p of [
  "apps/mcp-server",
  "apps/cli",
  "packages/runner",
  "packages/rawterm",
  "packages/protocol",
])
  Object.assign(known, exportPkg(p).dependencies ?? {});
const dependencies = {};
for (const name of [...RUNTIME_DEPS].sort()) {
  if (!known[name])
    fail(`the JS imports ${name}, which no workspace package depends on`);
  dependencies[name] = known[name];
}
const pkg = {
  name: "craftos-mcp",
  version,
  description:
    "CC:Tweaked (ComputerCraft) emulator for testing and AI agents: run, test and screenshot Lua programs, monitors, modems, turtles and modded peripherals, as an MCP server or a command line.",
  mcpName: server.name,
  type: "module",
  bin: { "craftos-mcp": "scripts/npm/craftos-mcp.mjs" },
  engines: { node: ">=22" },
  dependencies,
  repository: { type: "git", url: `git+${REPO_URL}.git` },
  homepage: `${REPO_URL}#readme`,
  bugs: { url: `${REPO_URL}/issues` },
  license: "MIT",
  keywords: [
    "computercraft",
    "cc-tweaked",
    "cctweaked",
    "minecraft",
    "lua",
    "emulator",
    "mcp",
    "model-context-protocol",
    "mcp-server",
    "testing",
    "turtle",
  ],
  files: [
    "apps/",
    "packages/",
    "rom-overlay/",
    "worlds/",
    "docs/",
    "workspace/",
    "scripts/",
    "craftos-package.json",
    "NOTICE.md",
  ],
};
writeFileSync(join(PKG, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

// ---- check: nothing unresolved, nothing that must not ship ----
for (const file of walk(PKG)) {
  const rel = posix(relative(PKG, file));
  if (NEVER.some((re) => re.test(rel)))
    fail(`${rel} must not be in the package`);
  if (!rel.endsWith(".js") && !rel.endsWith(".mjs")) continue;
  const text = readFileSync(file, "utf8");
  for (const [, , , spec] of text.matchAll(SPECIFIER)) {
    if (spec.startsWith("node:")) continue;
    if (spec.startsWith(".")) {
      if (!existsSync(resolve(dirname(file), spec)))
        fail(`${rel}: ${spec} does not exist in the package`);
      continue;
    }
    if (spec.startsWith("@craftos-mcp/"))
      fail(`${rel}: ${spec} left unresolved`);
  }
}

// ---- pack ----
mkdirSync(outDir, { recursive: true });
// packed in the staging folder, then copied out (cmd.exe makes a quoted --pack-destination awkward)
// npm 11 and older print an array of packages, npm 12 an object keyed by package name
const packOut = JSON.parse(run("npm", ["pack", "--json"], PKG));
const packed = Array.isArray(packOut) ? packOut[0] : Object.values(packOut)[0];
const tarball = join(outDir, packed.filename);
cpSync(join(PKG, packed.filename), tarball);
rmSync(STAGE, { recursive: true, force: true });
console.log(
  `${tarball}\n  ${packed.entryCount} files (${jsFiles} compiled JS), ${(packed.size / 1024 / 1024).toFixed(2)} MB packed, ` +
    `${(packed.unpackedSize / 1024 / 1024).toFixed(2)} MB unpacked; dependencies: ${Object.keys(dependencies).join(", ")}`,
);
