// The CC:Tweaked ROM and terminal font for the browser engine, made on the user's machine from CC:Tweaked's own jar,
// as the desktop emulator does (scripts/build-rom.mjs): the extension never carries a CC:Tweaked file. The jar comes
// from Modrinth (its CDN allows any origin), is checked against the pinned sha512, and gives
// - the ROM: data/computercraft/lua/ with the same three patches build-rom.mjs makes, and the emulator's own overlay
//   (rom-overlay, packed into the extension by esbuild.mjs) on top, in the one-file format web/src/worker.js unpacks;
// - the font: assets/computercraft/textures/gui/term_font.png cut into 256 glyphs of 6x9, 9 bytes each, bit 5 the
//   leftmost pixel (packages/rawterm/assets/cc-font.bin's layout, which the player draws with).
// Only web APIs: fetch, crypto.subtle, DecompressionStream. Runs in the web extension host and in Node 20+ (tests).
import startupEmulator from "../../../../scripts/rom-patches/startup-emulator.lua";

export const CC_VERSION = "1.101.3";
/** packages/runner/src/versions.ts, Minecraft 1.18.2: the one version the browser engine runs. */
export const JAR = {
  file: "cc-tweaked-1.18.2-1.101.3.jar",
  url: "https://cdn.modrinth.com/data/gu7yAYhd/versions/fmRxKFx2/cc-tweaked-1.18.2-1.101.3.jar",
  sha512:
    "dff864e824f111b5901414b633e13ca2ff3685195f1d2992bdf6a3470fb6e1119ba7e995d99575296415fccb00c6cb99939e6a47fdc7983b322f3f65e805a27f",
};

const LUA_PREFIX = "data/computercraft/lua/";
const FONT_PNG = "assets/computercraft/textures/gui/term_font.png";
const MAGIC = "CRAFTOSROM1";

const latin1 = new TextDecoder("latin1");
const utf8 = new TextDecoder();
const encoder = new TextEncoder();

async function pipe(
  data: Uint8Array,
  format: "deflate" | "deflate-raw" | "gzip",
): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  return data[0] === 0x1f && data[1] === 0x8b ? pipe(data, "gzip") : data;
}

export async function sha512Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-512", data as BufferSource);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The file entries of a zip whose names pass `want` (stored or deflated; no zip64, no encryption). */
export async function readZip(
  buf: Uint8Array,
  want: (name: string) => boolean,
): Promise<Map<string, Uint8Array>> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--)
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error("not a zip file (no end of central directory)");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  if (count === 0xffff || p === 0xffffffff)
    throw new Error("zip64 archives are not supported");
  const out = new Map<string, Uint8Array>();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50)
      throw new Error("corrupt zip central directory");
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = utf8.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/") || !want(name)) continue;
    if (flags & 1)
      throw new Error(`${name}: encrypted zip entries are not supported`);
    if (view.getUint32(local, true) !== 0x04034b50)
      throw new Error(`${name}: corrupt local header`);
    const start =
      local +
      30 +
      view.getUint16(local + 26, true) +
      view.getUint16(local + 28, true);
    const raw = buf.subarray(start, start + compSize);
    let data: Uint8Array;
    if (method === 0) data = raw;
    else if (method === 8) data = await pipe(raw, "deflate-raw");
    else
      throw new Error(`${name}: unsupported zip compression method ${method}`);
    if (data.length !== size)
      throw new Error(`${name}: size mismatch after decompression`);
    out.set(name, data);
  }
  return out;
}

/** A PNG as RGBA: 8-bit grey/RGB/RGBA and palette images of 1 to 8 bits, not interlaced (enough for term_font). */
export async function decodePng(
  png: Uint8Array,
): Promise<{ width: number; height: number; rgba: Uint8Array }> {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (view.getUint32(0) !== 0x89504e47) throw new Error("not a PNG");
  let p = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colour = 0;
  let palette: Uint8Array = new Uint8Array(0);
  let alpha: Uint8Array = new Uint8Array(0);
  const idat: Uint8Array[] = [];
  while (p < png.length) {
    const len = view.getUint32(p);
    const type = latin1.decode(png.subarray(p + 4, p + 8));
    const body = png.subarray(p + 8, p + 8 + len);
    p += 12 + len;
    if (type === "IHDR") {
      const b = new DataView(body.buffer, body.byteOffset, body.byteLength);
      width = b.getUint32(0);
      height = b.getUint32(4);
      depth = body[8]!;
      colour = body[9]!;
      if (body[12] !== 0) throw new Error("interlaced PNGs are not supported");
    } else if (type === "PLTE") palette = body;
    else if (type === "tRNS") alpha = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colour];
  if (!channels || (colour !== 3 && depth !== 8))
    throw new Error(`PNG colour type ${colour} at ${depth} bits`);
  const joined = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  idat.reduce((at, c) => (joined.set(c, at), at + c.length), 0);
  const raw = await pipe(joined, "deflate");
  const bpp = Math.max(1, (channels * depth) / 8);
  const stride = Math.ceil((width * channels * depth) / 8);
  const lines = new Uint8Array(height * stride);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const line = lines.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      let v = src[i]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = v & 0xff;
    }
    prev = line;
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const line = lines.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colour === 3) {
        const bit = x * depth;
        const idx =
          (line[bit >> 3]! >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
        rgba[o] = palette[idx * 3] ?? 0;
        rgba[o + 1] = palette[idx * 3 + 1] ?? 0;
        rgba[o + 2] = palette[idx * 3 + 2] ?? 0;
        rgba[o + 3] = alpha[idx] ?? 255;
      } else {
        const px = line.subarray(x * channels, (x + 1) * channels);
        const grey = channels <= 2;
        rgba[o] = px[0]!;
        rgba[o + 1] = grey ? px[0]! : px[1]!;
        rgba[o + 2] = grey ? px[0]! : px[2]!;
        rgba[o + 3] = channels === 2 ? px[1]! : channels === 4 ? px[3]! : 255;
      }
    }
  }
  return { width, height, rgba };
}

/** CC's term_font.png as 256 glyphs of 9 rows (FixedWidthFontRenderer: 16x16 cells of 8x11, glyph at +1,+1). */
export async function fontFromPng(png: Uint8Array): Promise<Uint8Array> {
  const { width, rgba } = await decodePng(png);
  const glyphs = new Uint8Array(256 * 9);
  for (let c = 0; c < 256; c++) {
    const x0 = 1 + (c % 16) * 8;
    const y0 = 1 + Math.floor(c / 16) * 11;
    for (let row = 0; row < 9; row++) {
      let bits = 0;
      for (let col = 0; col < 6; col++) {
        const o = ((y0 + row) * width + x0 + col) * 4;
        // a lit pixel is opaque and white (the glyphs are tinted when drawn)
        if (rgba[o + 3]! >= 128 && rgba[o]! >= 128) bits |= 1 << (5 - col);
      }
      glyphs[c * 9 + row] = bits;
    }
  }
  return glyphs;
}

export interface PackEntry {
  readonly path: string;
  readonly offset: number;
  readonly size: number;
}

/** Read a "CRAFTOSROM1" pack (web/build-runtime.mjs's format) into path -> bytes. */
export function readPack(pack: Uint8Array): Map<string, Uint8Array> {
  if (latin1.decode(pack.subarray(0, 11)) !== MAGIC)
    throw new Error("not a ROM pack");
  const length = new DataView(
    pack.buffer,
    pack.byteOffset,
    pack.byteLength,
  ).getUint32(12, true);
  const index = JSON.parse(
    utf8.decode(pack.subarray(16, 16 + length)),
  ) as PackEntry[];
  const base = 16 + length;
  return new Map(
    index.map((f) => [
      f.path,
      pack.subarray(base + f.offset, base + f.offset + f.size),
    ]),
  );
}

/** path -> bytes as one "CRAFTOSROM1" pack, paths sorted. */
export function writePack(files: Map<string, Uint8Array>): Uint8Array {
  const entries: PackEntry[] = [];
  let offset = 0;
  const sorted = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [path, data] of sorted) {
    entries.push({ path, offset, size: data.length });
    offset += data.length;
  }
  const index = encoder.encode(JSON.stringify(entries));
  const out = new Uint8Array(16 + index.length + offset);
  out.set(encoder.encode(MAGIC), 0);
  new DataView(out.buffer).setUint32(12, index.length, true);
  out.set(index, 16);
  let at = 16 + index.length;
  for (const [, data] of sorted) {
    out.set(data, at);
    at += data.length;
  }
  return out;
}

/** Replace exactly one occurrence of `find`, or fail: the ROM is not the one the patches were written for. */
function patch(
  text: string,
  find: string,
  replace: string,
  what: string,
): string {
  const at = text.indexOf(find);
  if (at < 0 || text.indexOf(find, at + 1) >= 0)
    throw new Error(
      `${what}: pattern not found exactly once; ROM layout changed?`,
    );
  return text.slice(0, at) + replace + text.slice(at + find.length);
}

/** scripts/build-rom.mjs buildRom's three patches, on bios.lua and rom/startup.lua's text. */
export function patchRom(files: Map<string, string>): void {
  const bios = files.get("bios.lua");
  const startup = files.get("rom/startup.lua");
  if (bios === undefined || startup === undefined)
    throw new Error("the jar has no bios.lua or rom/startup.lua");
  files.set(
    "bios.lua",
    patch(
      bios,
      "function os.shutdown()\n    nativeShutdown()",
      'do local t = term for _, n in ipairs({ "drawPixels", "getFrozen", "getGraphicsMode", "getPixel", "getPixels", ' +
        '"relativeMouse", "screenshot", "setFrozen", "setGraphicsMode", "setPixel", "showMouse" }) do t[n] = nil end end ' +
        "function os.shutdown(...)\n    nativeShutdown(...)",
      "bios.lua os.shutdown",
    ),
  );
  const completionLine = 'local completion = require "cc.shell.completion"\n';
  let s = patch(
    startup,
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
  const userStartupLine =
    "-- Run the user created startup, either from disk drives or the root\n";
  s = patch(
    s,
    userStartupLine,
    startupEmulator.replace(/\r\n/g, "\n").replace(/\n*$/, "\n\n") +
      userStartupLine,
    "startup.lua emulator block",
  );
  files.set("rom/startup.lua", s);
}

export interface BuiltRom {
  /** The ROM pack, not gzipped (paths under /craftos/). */
  readonly rom: Uint8Array;
  /** 256 glyphs x 9 rows. */
  readonly font: Uint8Array;
}

/** The ROM and font from the jar's bytes and the overlay pack (gzipped or not; paths relative to the ROM root). */
export async function buildRom(
  jar: Uint8Array,
  overlayPack: Uint8Array,
): Promise<BuiltRom> {
  const got = await sha512Hex(jar);
  if (got !== JAR.sha512)
    throw new Error(
      `${JAR.file}: sha512 mismatch (expected ${JAR.sha512}, got ${got})`,
    );
  const entries = await readZip(
    jar,
    (n) => n.startsWith(LUA_PREFIX) || n === FONT_PNG,
  );
  const png = entries.get(FONT_PNG);
  if (!png) throw new Error(`${JAR.file}: no ${FONT_PNG}`);
  entries.delete(FONT_PNG);
  const rom = new Map<string, Uint8Array>();
  for (const [name, data] of entries) {
    const rel = name.slice(LUA_PREFIX.length);
    if (rel.split("/").some((part) => part === ".." || part === ""))
      throw new Error(`unsafe zip path ${name}`);
    rom.set(rel, data);
  }
  const text = new Map<string, string>();
  for (const name of ["bios.lua", "rom/startup.lua"]) {
    const data = rom.get(name);
    if (data) text.set(name, utf8.decode(data).replace(/\r\n/g, "\n"));
  }
  patchRom(text);
  for (const [name, t] of text) rom.set(name, encoder.encode(t));
  for (const [path, data] of readPack(await gunzip(overlayPack)))
    rom.set(path, data);
  const packed = new Map<string, Uint8Array>();
  for (const [path, data] of rom) packed.set(`/craftos/${path}`, data);
  return { rom: writePack(packed), font: await fontFromPng(png) };
}
