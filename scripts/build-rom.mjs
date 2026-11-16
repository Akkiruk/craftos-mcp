// Compose a ROM directory from a CC:Tweaked jar plus our overlay.
// usage: node scripts/build-rom.mjs <cc-tweaked.jar> <outDir>
//        node scripts/build-rom.mjs --download [outDir]
// --download fetches the pinned CC:Tweaked jar from Modrinth (checked against the sha512 Modrinth publishes), caches it
// under .cache/ and builds from it. outDir defaults to rom/cc-1.101.3.
// The jar is read with a small built-in zip reader, so no tar/unzip is needed on any OS.
// No CC:Tweaked file is kept in this repo: bios.lua and rom/startup.lua are patched in place from the jar's own copies
// (our startup additions live in scripts/rom-patches/). A missing Tom's Peripherals fonts.lua is generated first.
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const JAR_NAME = "cc-tweaked-1.18.2-1.101.3.jar";
const MODRINTH_PROJECT = "cc-tweaked";
const LUA_PREFIX = "data/computercraft/lua/";

const usage = [
  "usage: node scripts/build-rom.mjs <cc-tweaked.jar> <outDir>",
  "       node scripts/build-rom.mjs --download [outDir]",
].join("\n");

const args = process.argv.slice(2);
let jar;
let out;
if (args[0] === "--download") {
  if (args.length > 2) fail(usage);
  out = args[1] ?? join(repoRoot, "rom", "cc-1.101.3");
  jar = await downloadJar(join(repoRoot, ".cache"));
} else {
  [jar, out] = args;
  if (!jar || !out || args.length > 2) fail(usage);
}
// Tom's Peripherals' GPU fonts are generated from that mod's jar, not kept in the public copy: make them before the
// overlay is copied into the ROM (scripts/build-toms-fonts.mjs)
const toms = await import("./build-toms-fonts.mjs");
if (!existsSync(toms.FONTS_LUA)) await toms.buildTomsFonts();
buildRom(resolve(jar), resolve(out));

function fail(message) {
  console.error(message);
  process.exit(2);
}

/** Fetch the pinned jar from Modrinth into cacheDir (once), verifying the sha512 the API reports. */
async function downloadJar(cacheDir) {
  const headers = { "User-Agent": "craftos-agent-build-rom" };
  const url = `https://api.modrinth.com/v2/project/${MODRINTH_PROJECT}/version`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Modrinth API ${url}: HTTP ${res.status}`);
  const versions = await res.json();
  const file = versions
    .flatMap((v) => v.files ?? [])
    .find((f) => f.filename === JAR_NAME);
  if (!file)
    throw new Error(
      `Modrinth has no file named ${JAR_NAME} in project ${MODRINTH_PROJECT}`,
    );
  const want = file.hashes?.sha512;
  if (!want) throw new Error(`Modrinth gave no sha512 for ${JAR_NAME}`);

  const dest = join(cacheDir, JAR_NAME);
  const sha512 = (buf) => createHash("sha512").update(buf).digest("hex");
  if (existsSync(dest) && sha512(readFileSync(dest)) === want) {
    console.log(`Using cached ${dest}`);
    return dest;
  }
  console.log(`Downloading ${file.url}`);
  const dl = await fetch(file.url, { headers });
  if (!dl.ok) throw new Error(`download ${file.url}: HTTP ${dl.status}`);
  const body = Buffer.from(await dl.arrayBuffer());
  const got = sha512(body);
  if (got !== want)
    throw new Error(
      `${JAR_NAME}: sha512 mismatch (expected ${want}, got ${got})`,
    );
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(`${dest}.part`, body);
  renameSync(`${dest}.part`, dest);
  return dest;
}

/** Yield {name, data} for each file entry of a zip (stored or deflated; no zip64, no encryption). */
function* readZip(buf) {
  // End of central directory: fixed 22 bytes plus an optional comment of up to 64 KiB.
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
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (flags & 1)
      throw new Error(`${name}: encrypted zip entries are not supported`);
    if (buf.readUInt32LE(local) !== 0x04034b50)
      throw new Error(`${name}: corrupt local header`);
    const start =
      local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = inflateRawSync(raw);
    else
      throw new Error(`${name}: unsupported zip compression method ${method}`);
    if (data.length !== size)
      throw new Error(`${name}: size mismatch after decompression`);
    yield { name, data };
  }
}

/** Replace exactly one occurrence of `find` in a ROM file, or fail loudly if the ROM changed. */
function patchFile(path, find, replace, what) {
  const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const at = text.indexOf(find);
  if (at < 0 || text.indexOf(find, at + 1) >= 0)
    throw new Error(
      `${path}: ${what} pattern not found exactly once; ROM layout changed?`,
    );
  writeFileSync(
    path,
    text.slice(0, at) + replace + text.slice(at + find.length),
  );
}

function buildRom(jarPath, outDir) {
  const zip = readFileSync(jarPath);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  let files = 0;
  for (const { name, data } of readZip(zip)) {
    if (!name.startsWith(LUA_PREFIX)) continue;
    const rel = name.slice(LUA_PREFIX.length);
    if (rel.split("/").some((part) => part === ".." || part === ""))
      throw new Error(`unsafe zip path ${name}`);
    const dest = join(outDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, data);
    files++;
  }
  if (!existsSync(join(outDir, "bios.lua")))
    throw new Error(
      `${jarPath}: no ${LUA_PREFIX}bios.lua inside; is this a CC:Tweaked jar?`,
    );

  // The overlay supplies the engine hooks the vanilla ROM lacks (e.g. --script support, ccsim).
  cpSync(join(repoRoot, "rom-overlay"), outDir, { recursive: true });

  // Vanilla bios drops os.shutdown's argument; pass it through so scripts can
  // report an exit code (this engine turns it into the process exit status).
  patchFile(
    join(outDir, "bios.lua"),
    "function os.shutdown()\n    nativeShutdown()",
    "function os.shutdown(...)\n    nativeShutdown(...)",
    "os.shutdown",
  );

  // Start ccsim (simulated mod APIs and virtual peripherals) before the shell sets up, but only for runs
  // that were given a world.
  const completionLine = 'local completion = require "cc.shell.completion"\n';
  patchFile(
    join(outDir, "rom", "startup.lua"),
    completionLine,
    completionLine +
      [
        "",
        "-- craftos-agent: simulated mod APIs and virtual peripherals (rom/ccsim)",
        'if fs.exists("/rom/ccsim/init.lua") and fs.exists("/results/world.json") then',
        '    local ok, err = pcall(dofile, "/rom/ccsim/init.lua")',
        '    if not ok then printError("ccsim failed to start: " .. tostring(err)) end',
        "end",
        "",
      ].join("\n"),
    "startup.lua ccsim hook",
  );

  // Run the engine's --script boot script (with the emulator-only APIs), then hide those APIs from everything after
  // it. This has to run before the user's startup files.
  const userStartupLine =
    "-- Run the user created startup, either from disk drives or the root\n";
  const emulatorBlock = readFileSync(
    join(repoRoot, "scripts", "rom-patches", "startup-emulator.lua"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  patchFile(
    join(outDir, "rom", "startup.lua"),
    userStartupLine,
    emulatorBlock.replace(/\n*$/, "\n\n") + userStartupLine,
    "startup.lua emulator block",
  );
  console.log(`ROM written to ${outDir} (${files} files from ${jarPath})`);
}
