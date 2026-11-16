// One command after cloning:  npm run setup
//
// Installs the npm packages, builds the TypeScript, builds the CC:Tweaked ROM from the real jar (and Tom's
// Peripherals' fonts), and gets the engine: it downloads the prebuilt engine for this OS from the latest GitHub
// release. Every step is skipped when its result is already there, so running it again takes a second or two.
//
//   node scripts/setup.mjs [--force-engine]
//
// Environment (for forks and for testing):
//   CRAFTOS_RELEASE_REPO  owner/name of the repository whose latest release holds the engine zips
//   CRAFTOS_RELEASE_API   the "latest release" API URL (default: derived from CRAFTOS_RELEASE_REPO)
//   CRAFTOS_ENGINE_URL    a zip URL or a local zip path to use instead of looking at releases
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_REPO = process.env.CRAFTOS_RELEASE_REPO ?? "Akkiruk/craftos-mcp";
const WINDOWS = process.platform === "win32";
const ENGINE_DIR = join(REPO, "engine", "build");
const ENGINE_EXE = join(ENGINE_DIR, WINDOWS ? "craftos.exe" : "craftos");
const ROM_DIR = join(REPO, "rom", "cc-1.101.3");
const FONTS = "rom/ccsim/addons/toms-peripherals/fonts.lua";

/** The release asset suffix for this machine, or undefined where there is no prebuilt engine. */
export function platformKey(platform = process.platform, arch = process.arch) {
  if (arch !== "x64") return undefined;
  if (platform === "win32") return "windows-x64";
  if (platform === "linux") return "linux-x64";
  return undefined;
}

/**
 * Yield { name, data, mode } for each file entry of a zip (stored or deflated, no zip64, no encryption). `mode` is
 * the Unix permission word when the zip was made on Unix (it carries the executable bit and symlinks), else 0.
 */
export function* readZip(buf) {
  let eocd = -1;
  for (
    let i = buf.length - 22;
    i >= Math.max(0, buf.length - 22 - 0xffff);
    i--
  ) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file (no end of central directory)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff)
    throw new Error("zip64 archives are not supported");
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50)
      throw new Error("corrupt zip central directory");
    const madeBy = buf.readUInt16LE(p + 4) >> 8;
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const external = buf.readUInt32LE(p + 38);
    const local = buf.readUInt32LE(p + 42);
    // some Windows tools write backslashes
    const name = buf
      .toString("utf8", p + 46, p + 46 + nameLen)
      .replace(/\\/g, "/");
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (flags & 1)
      throw new Error(`${name}: encrypted entries are not supported`);
    if (buf.readUInt32LE(local) !== 0x04034b50)
      throw new Error(`${name}: corrupt local header`);
    const start =
      local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`${name}: unsupported compression method ${method}`);
    if (data.length !== size) throw new Error(`${name}: size mismatch`);
    yield { name, data, mode: madeBy === 3 ? external >>> 16 : 0 };
  }
}

/**
 * Write the entries of a release zip whose path starts with one of `prefixes` under `root`. Returns the files
 * written. Refuses any path that would land outside `root`.
 */
export function extractZip(buf, root, prefixes = ["engine/build/"]) {
  const written = [];
  for (const { name, data, mode } of readZip(buf)) {
    if (!prefixes.some((p) => name.startsWith(p))) continue;
    const dest = resolve(root, name);
    const rel = relative(root, dest);
    if (rel.startsWith("..") || rel.startsWith(sep) || /^[a-zA-Z]:/.test(rel))
      throw new Error(`unsafe path in zip: ${name}`);
    mkdirSync(dirname(dest), { recursive: true });
    if ((mode & 0o170000) === 0o120000) {
      // a symlink (Linux shared libraries): the data is the link target
      try {
        symlinkSync(data.toString("utf8"), dest);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    } else {
      writeFileSync(dest, data);
      if (!WINDOWS && (mode & 0o111 || /\/craftos$/.test(name)))
        chmodSync(dest, 0o755);
    }
    written.push(name);
  }
  return written;
}

/** Where a running setup says so (the Claude Code plugin starts setup in the background and waits on it). */
export const LOCK = join(REPO, ".cache", "setup.lock");
const LOCK_STALE_MS = 30 * 60 * 1000;

/** One setup at a time: wait for another running one to finish, then hold the lock until this process exits. */
async function takeLock() {
  mkdirSync(dirname(LOCK), { recursive: true });
  for (;;) {
    try {
      writeFileSync(LOCK, String(Date.now()), { flag: "wx" });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const started = Number(readFileSync(LOCK, "utf8")) || 0;
      if (Date.now() - started > LOCK_STALE_MS) {
        rmSync(LOCK, { force: true });
        continue;
      }
      console.log("another setup is running here; waiting for it");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  process.on("exit", () => rmSync(LOCK, { force: true }));
}

function step(n, total, title) {
  console.log(`\n[${n}/${total}] ${title}`);
}

function run(command, args, options = {}) {
  // npm is npm.cmd on Windows, which only cmd.exe can start
  const [file, argv] =
    WINDOWS && command === "npm"
      ? ["cmd.exe", ["/d", "/s", "/c", ["npm", ...args].join(" ")]]
      : [command, args];
  const result = spawnSync(file, argv, {
    cwd: REPO,
    stdio: "inherit",
    ...options,
  });
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed (exit ${result.status ?? result.signal})`,
    );
}

/** The engine zip as a Buffer, or undefined when the repository has no release (or none for this OS). */
async function fetchEngineZip(key) {
  const override = process.env.CRAFTOS_ENGINE_URL;
  if (override) {
    if (existsSync(override)) return readFileSync(override);
    return download(override);
  }
  const api =
    process.env.CRAFTOS_RELEASE_API ??
    `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;
  const headers = {
    "User-Agent": "craftos-mcp-setup",
    Accept: "application/vnd.github+json",
  };
  if (process.env.GITHUB_TOKEN)
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(api, { headers });
  if (res.status === 404) {
    console.log(`  no release found at ${api}`);
    return undefined;
  }
  if (!res.ok) throw new Error(`${api}: HTTP ${res.status}`);
  const release = await res.json();
  const asset = (release.assets ?? []).find(
    (a) => a.name.startsWith("craftos-mcp-") && a.name.endsWith(`-${key}.zip`),
  );
  if (!asset) {
    console.log(`  release ${release.tag_name} has no ${key} engine zip`);
    return undefined;
  }
  console.log(`  release ${release.tag_name}: ${asset.name}`);
  return download(asset.browser_download_url);
}

async function download(url) {
  console.log(`  downloading ${url}`);
  const res = await fetch(url, {
    headers: { "User-Agent": "craftos-mcp-setup" },
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`  ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
  return buf;
}

function buildInstructions() {
  return WINDOWS
    ? [
        "  Build it yourself: Visual Studio 2022 (or Build Tools) with C++, CMake, Ninja and a vcpkg checkout in",
        "  VCPKG_ROOT, then run  engine\\build.cmd",
      ]
    : [
        "  Build it yourself: a C++17 compiler, CMake, Ninja and a vcpkg checkout in VCPKG_ROOT, then run",
        "  bash engine/build.sh   (the package list is at the top of that file)",
      ];
}

async function getEngine(force) {
  if (existsSync(ENGINE_EXE) && !force) {
    console.log(`  already there: ${relative(REPO, ENGINE_EXE)}`);
    return true;
  }
  const key = platformKey();
  if (!key && !process.env.CRAFTOS_ENGINE_URL) {
    console.log(
      `  there is no prebuilt engine for ${process.platform}/${process.arch}.`,
    );
    for (const l of buildInstructions()) console.log(l);
    return false;
  }
  let zip;
  try {
    zip = await fetchEngineZip(key);
  } catch (error) {
    console.log(`  could not download the engine: ${error.message}`);
  }
  if (!zip) {
    console.log("  No prebuilt engine is available.");
    for (const l of buildInstructions()) console.log(l);
    return false;
  }
  const files = extractZip(zip, REPO);
  if (files.length === 0 || !existsSync(ENGINE_EXE)) {
    console.log("  the zip held no engine/build/ files for this OS");
    for (const l of buildInstructions()) console.log(l);
    return false;
  }
  console.log(`  unpacked ${files.length} files into engine/build`);
  return true;
}

export async function main(argv = process.argv.slice(2)) {
  const force = argv.includes("--force-engine");
  const total = 5;
  if (Number(process.versions.node.split(".")[0]) < 22) {
    console.error(
      `Node.js 22 or newer is needed (this is ${process.version}).`,
    );
    return 1;
  }
  console.log(`craftos-mcp setup in ${REPO}`);
  await takeLock();

  step(1, total, "npm packages");
  if (
    existsSync(join(REPO, "node_modules", "typescript", "package.json")) &&
    existsSync(join(REPO, "node_modules", "@modelcontextprotocol", "sdk"))
  )
    console.log("  already installed");
  else run("npm", ["install", "--no-audit", "--no-fund"]);

  step(2, total, "build the TypeScript");
  run("npm", ["run", "build"]);

  step(3, total, "ROM (CC:Tweaked 1.101.3) and Tom's Peripherals fonts");
  if (existsSync(join(ROM_DIR, "bios.lua")) && existsSync(join(ROM_DIR, FONTS)))
    console.log(`  already built: ${relative(REPO, ROM_DIR)}`);
  else
    run(process.execPath, [
      join(REPO, "scripts", "build-rom.mjs"),
      "--download",
    ]);

  step(4, total, "engine");
  const haveEngine = await getEngine(force);

  step(5, total, "check");
  const runner = await import(
    pathToFileURL(join(REPO, "packages", "runner", "dist", "index.js")).href
  );
  const problems = runner.checkConfig(runner.loadConfig());
  if (problems.length === 0) console.log("  engine and ROM found: ready");
  else for (const p of problems) console.log(`  - ${p}`);

  const server = join(REPO, "apps", "mcp-server", "dist", "index.js");
  const q = (s) => (/\s/.test(s) ? `"${s}"` : s);
  console.log("\nNext steps");
  if (!haveEngine || problems.length)
    console.log(
      "  First get the engine (see above), then run  npm run setup  again.",
    );
  console.log("\n  Claude Code:");
  console.log(`    claude mcp add craftos -- node ${q(server)}`);
  console.log(
    "  Or as a plugin (skill and server in one install):  /plugin marketplace add " +
      RELEASE_REPO +
      "   then   /plugin install craftos-mcp@craftos-mcp",
  );
  console.log(
    "\n  VS Code: open this folder; .vscode/mcp.json is already set up for it.",
  );
  console.log("  Other MCP clients: run  node " + q(server) + "  over stdio.");
  console.log("\n  Command line, from your own Lua project folder:");
  console.log(
    `    npx craftos-mcp help        (inside this folder; or node ${q(join(REPO, "apps", "cli", "dist", "index.js"))} help)`,
  );
  console.log("    craftos-mcp test | run | info | serve");
  return problems.length ? 1 : 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`\nsetup failed: ${error.message}`);
      process.exit(1);
    },
  );
}
