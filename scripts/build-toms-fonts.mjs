// Build rom-overlay/rom/ccsim/addons/toms-peripherals/fonts.lua from Tom's Peripherals' own font files.
// usage: node scripts/build-toms-fonts.mjs [--jar <toms-peripherals-1.18.2-1.2.1.jar>] [--out <fonts.lua>]
// Without --jar the pinned jar is fetched from Modrinth (sha512 checked against the pin and against what Modrinth
// publishes) and cached under .cache/. The glyphs likely derive from Minecraft's font, so fonts.lua is generated, not
// shipped in the public copy. build-rom.mjs runs this when fonts.lua is missing.
// Output: full glyph data for ascii, ascii_sga and unicode_page_00 (every character a Lua string can hold); for the
// other unicode pages their size, height and glyph 0 (all a Lua string can draw with them); editable pages a marker.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const JAR_NAME = "toms-peripherals-1.18.2-1.2.1.jar";
const MODRINTH_PROJECT = "toms-peripherals";
const JAR_SHA512 =
  "82dff698ef3e2c218ebe5d8fb116f889cded1547eeaaaec8895ef55f56506b38449dd90d838c923adcb4c114bbfab88f0c855abb48198220eaeffae79704f8dd";
const FONT_PREFIX = "com/tom/peripherals/gpu/font/";
const FULL = new Set(["ascii", "ascii_sga", "unicode_page_00"]);
export const FONTS_LUA = join(
  repoRoot,
  "rom-overlay",
  "rom",
  "ccsim",
  "addons",
  "toms-peripherals",
  "fonts.lua",
);

const sha512 = (buf) => createHash("sha512").update(buf).digest("hex");

/** Fetch the pinned jar from Modrinth into cacheDir (once). */
async function downloadJar(cacheDir) {
  const dest = join(cacheDir, JAR_NAME);
  if (existsSync(dest) && sha512(readFileSync(dest)) === JAR_SHA512) {
    console.log(`Using cached ${dest}`);
    return dest;
  }
  const headers = { "User-Agent": "craftos-agent-build-toms-fonts" };
  const url = `https://api.modrinth.com/v2/project/${MODRINTH_PROJECT}/version`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Modrinth API ${url}: HTTP ${res.status}`);
  const file = (await res.json())
    .flatMap((v) => v.files ?? [])
    .find((f) => f.filename === JAR_NAME);
  if (!file)
    throw new Error(
      `Modrinth has no file named ${JAR_NAME} in project ${MODRINTH_PROJECT}`,
    );
  if (file.hashes?.sha512 !== JAR_SHA512)
    throw new Error(
      `${JAR_NAME}: Modrinth's sha512 ${file.hashes?.sha512} is not the pinned ${JAR_SHA512}`,
    );
  console.log(`Downloading ${file.url}`);
  const dl = await fetch(file.url, { headers });
  if (!dl.ok) throw new Error(`download ${file.url}: HTTP ${dl.status}`);
  const body = Buffer.from(await dl.arrayBuffer());
  if (sha512(body) !== JAR_SHA512)
    throw new Error(`${JAR_NAME}: sha512 mismatch (got ${sha512(body)})`);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(`${dest}.part`, body);
  renameSync(`${dest}.part`, dest);
  return dest;
}

/** {name, data} for each file of a zip (stored or deflated; no zip64), as in build-rom.mjs. */
function* readZip(buf) {
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
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50)
      throw new Error("corrupt zip central directory");
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
    const start =
      local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compSize);
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null;
    if (!data)
      throw new Error(`${name}: unsupported zip compression method ${method}`);
    if (data.length !== size)
      throw new Error(`${name}: size mismatch after decompression`);
    yield { name, data };
  }
}

/** Font.java's format: height byte (-1: editable font), int count, count chars, then per glyph a width byte and h ints. */
function readFont(b, name) {
  const h = b.readInt8(0);
  if (h === -1) return null;
  const size = b.readInt32BE(1);
  let p = 5;
  const chars = [];
  for (let i = 0; i < size; i++, p += 2) chars.push(b.readUInt16BE(p));
  const widths = [];
  const rows = [];
  for (let i = 0; i < size; i++) {
    widths.push(b.readInt8(p));
    p += 1;
    const r = [];
    for (let j = 0; j < h; j++, p += 4) r.push(b.readInt32BE(p));
    rows.push(r);
  }
  if (p !== b.length)
    throw new Error(`${name}: ${b.length - p} bytes left over`);
  return { h, chars, widths, rows };
}

const list = (xs) => `{${xs.join(",")}}`;

/** fonts.lua text from the jar's bytes. */
export function fontsLua(jarBytes) {
  const fonts = new Map();
  for (const { name, data } of readZip(jarBytes)) {
    if (
      name.startsWith(FONT_PREFIX) &&
      name.endsWith(".bin") &&
      !name.slice(FONT_PREFIX.length).includes("/")
    )
      fonts.set(name.slice(FONT_PREFIX.length, -4), data);
  }
  if (!fonts.has("ascii"))
    throw new Error(
      `no ${FONT_PREFIX}ascii.bin: is this the Tom's Peripherals jar?`,
    );
  const lines = [
    "-- Generated from Tom's Peripherals 1.18.2-1.2.1 (MIT) font files, com/tom/peripherals/gpu/font/*.bin.",
    "-- h: font height; chars: the font's characters in file order; widths: signed byte per glyph; rows: h ints per",
    "-- glyph, bit k = column k. partial = only glyph 0 is kept (see docs/toms-peripherals.md).",
    "return {",
  ];
  for (const name of [...fonts.keys()].sort((a, b) =>
    `${a}.bin` < `${b}.bin` ? -1 : 1,
  )) {
    const f = readFont(fonts.get(name), name);
    if (!f) {
      lines.push(`  ["${name}"] = { custom = true },`);
    } else if (FULL.has(name)) {
      lines.push(
        `  ["${name}"] = { h = ${f.h}, n = ${f.chars.length}, chars = ${list(f.chars)}, widths = ${list(f.widths)}, rows = ${list(f.rows.flat())} },`,
      );
    } else {
      if (f.chars.some((c) => c < 256 || c === 0x3f))
        throw new Error(`${name}: has characters below 256`);
      lines.push(
        `  ["${name}"] = { h = ${f.h}, n = ${f.chars.length}, partial = true, widths = {${f.widths[0]}}, rows = ${list(f.rows[0])} },`,
      );
    }
  }
  lines.push("}");
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * Build fonts.lua (default: the overlay's) from a local jar, or the pinned one from Modrinth, cached in cacheDir
 * (default .cache/).
 */
export async function buildTomsFonts({
  jar,
  out = FONTS_LUA,
  cacheDir = join(repoRoot, ".cache"),
} = {}) {
  const path = jar ? resolve(jar) : await downloadJar(cacheDir);
  const bytes = readFileSync(path);
  if (sha512(bytes) !== JAR_SHA512)
    console.warn(`warning: ${path} is not the pinned ${JAR_NAME}`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, fontsLua(bytes));
  console.log(`Wrote ${out}`);
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === "--jar" && args[i + 1]) opts.jar = args[i + 1];
    else if (args[i] === "--out" && args[i + 1])
      opts.out = resolve(args[i + 1]);
    else {
      console.error(
        "usage: node scripts/build-toms-fonts.mjs [--jar <toms-peripherals jar>] [--out <fonts.lua>]",
      );
      process.exit(2);
    }
  }
  await buildTomsFonts(opts);
}
