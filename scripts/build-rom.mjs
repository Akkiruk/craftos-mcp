// Compose a ROM directory from a CC:Tweaked jar plus our overlay.
// usage: node scripts/build-rom.mjs <cc-tweaked.jar> <outDir>
//        node scripts/build-rom.mjs --download [mc] [outDir]
// --download fetches the CC:Tweaked jar pinned for Minecraft <mc> (default 1.18.2, CC:Tweaked 1.101.3) from Modrinth,
// checks it against the pinned sha512 (packages/runner/src/versions.ts, so `npm run build` first), caches it under
// .cache/ and builds from it. outDir defaults to that version's ROM: rom/cc-1.101.3 for 1.18.2, rom/cc-1.121.0 for
// 1.20.1 and 1.21.1 (one ROM serves both).
// The jar is read with a small built-in zip reader, so no tar/unzip is needed on any OS.
// No CC:Tweaked file is kept in this repo: bios.lua and rom/startup.lua are patched in place from the jar's own copies
// (our startup additions live in scripts/rom-patches/). A missing Tom's Peripherals fonts.lua is generated first.
// Imported (the npm package's first run, scripts/npm/first-run.mjs) it only exports pinnedJar, downloadJar and buildRom.
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
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_MC = "1.18.2";
const LUA_PREFIX = "data/computercraft/lua/";

const usage = [
  "usage: node scripts/build-rom.mjs <cc-tweaked.jar> <outDir>",
  "       node scripts/build-rom.mjs --download [mc] [outDir]   (mc: 1.18.2, 1.20.1 or 1.21.1; default 1.18.2)",
].join("\n");

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}

async function main(args) {
  let jar;
  let out;
  if (args[0] === "--download") {
    const rest = args.slice(1);
    // a Minecraft version first is the version; anything else is the output folder (the old form)
    const mc = /^\d+\.\d+(\.\d+)?$/.test(rest[0] ?? "")
      ? rest.shift()
      : DEFAULT_MC;
    if (rest.length > 1) throw new Error(usage);
    const pinned = await pinnedJar(mc);
    out = rest[0] ?? join(repoRoot, "rom", pinned.romDir);
    jar = await downloadJar(join(repoRoot, ".cache"), pinned.jar);
  } else {
    [jar, out] = args;
    if (!jar || !out || args.length > 2) throw new Error(usage);
  }
  // Tom's Peripherals' GPU fonts are generated from that mod's jar, not kept in the public copy: make them before the
  // overlay is copied into the ROM (scripts/build-toms-fonts.mjs)
  const toms = await import("./build-toms-fonts.mjs");
  if (!existsSync(toms.FONTS_LUA)) await toms.buildTomsFonts();
  buildRom(resolve(jar), resolve(out));
}

/** The jar pinned for a Minecraft version (packages/runner/src/versions.ts) and the ROM folder it builds. */
export async function pinnedJar(mc) {
  const versionsJs = join(
    repoRoot,
    "packages",
    "runner",
    "dist",
    "versions.js",
  );
  if (!existsSync(versionsJs))
    throw new Error(`${versionsJs} is missing: run  npm run build  first`);
  const { VERSIONS } = await import(pathToFileURL(versionsJs).href);
  const info = VERSIONS.find((v) => v.mc === mc);
  if (!info)
    throw new Error(
      `unknown Minecraft version ${mc}; known: ${VERSIONS.map((v) => v.mc).join(", ")}`,
    );
  return { jar: info.jars[0], romDir: info.romDir };
}

/** Fetch a pinned jar from Modrinth into cacheDir (once), verifying its pinned sha512. */
export async function downloadJar(cacheDir, pinned) {
  const headers = { "User-Agent": "craftos-agent-build-rom" };
  const want = pinned.sha512;
  const dest = join(cacheDir, pinned.file);
  const sha512 = (buf) => createHash("sha512").update(buf).digest("hex");
  if (existsSync(dest) && sha512(readFileSync(dest)) === want) {
    console.log(`Using cached ${dest}`);
    return dest;
  }
  console.log(`Downloading ${pinned.url}`);
  const dl = await fetch(pinned.url, { headers });
  if (!dl.ok) throw new Error(`download ${pinned.url}: HTTP ${dl.status}`);
  const body = Buffer.from(await dl.arrayBuffer());
  const got = sha512(body);
  if (got !== want)
    throw new Error(
      `${pinned.file}: sha512 mismatch (expected ${want}, got ${got})`,
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

export function buildRom(jarPath, outDir) {
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
