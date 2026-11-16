// Lay out the browser runtime in web/dist/runtime/ (web/README.md):
//
//   node web/build-runtime.mjs [--engine]
//
//   craftos.js, craftos.wasm   the engine, from engine/build-web (engine/build-web.cmd builds it; --engine runs it first)
//   rom-1.101.3.pack           the CC:Tweaked 1.101.3 ROM with the ccsim overlay, one gzip file the worker unpacks
//   cc-font.bin                CC's terminal font, 256 glyphs of 6x9 pixels (9 bytes each, bit 5 = leftmost pixel)
//   player.js, worker.js       the page-side runtime (web/src)
//   manifest.json              a hash of each file, so the player can cache them forever and still get new builds
//
// The ROM and the font are CC:Tweaked's, hosted with its author's permission for the website only: they go in this
// gitignored output, never in the public repository. The ROM is the public copy's: the server-mod files are left out
// and @private blocks stripped, as scripts/export-public.mjs does, and the turtle block data is cut (no turtles here).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const WEB = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(WEB, "..");
const OUT = join(WEB, "dist", "runtime");
const ENGINE_OUT =
  process.env.CRAFTOS_WEB_BUILD_DIR ?? join(REPO, "engine", "build-web");
const CC_VERSION = "1.101.3";
const ROM_BASE = join(REPO, "rom", `cc-${CC_VERSION}`);
const OVERLAY = join(REPO, "rom-overlay");

/** ROM paths (relative to the ROM root, folders end in /) that stay out of the browser ROM. */
const ROM_EXCLUDE = ["rom/ccsim/turtle/data/"];

const leaky = () => false;

if (process.argv.includes("--engine")) {
  if (process.platform !== "win32")
    throw new Error("--engine: engine/build-web.cmd is Windows only");
  execFileSync("cmd.exe", ["/c", join(REPO, "engine", "build-web.cmd")], {
    stdio: "inherit",
  });
}

for (const f of ["craftos.js", "craftos.wasm"])
  if (!existsSync(join(ENGINE_OUT, f))) {
    console.error(
      `no ${f} in ${ENGINE_OUT}: run engine\\build-web.cmd (or this script with --engine)`,
    );
    process.exit(1);
  }
if (!existsSync(join(ROM_BASE, "bios.lua"))) {
  console.error(
    `no ROM at ${ROM_BASE}: run node scripts/build-rom.mjs --download`,
  );
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// The markers, spelled so that this file's own lines are not taken for them when it is exported
const PRIVATE = "@" + "private-";
const START = PRIVATE + "start";
const END = PRIVATE + "end";

/** Same rules as scripts/export-public.mjs stripPrivate. */
function stripPrivate(text, path) {
  text = text.replace(/^([ \t]*)(?:\/\/|--|#) @public: ?(.*)$/gm, "$1$2");
  if (!text.includes(PRIVATE)) return text;
  const kept = [];
  let depth = 0;
  for (const [i, line] of text.split("\n").entries()) {
    if (line.includes(START)) depth++;
    else if (line.includes(END)) {
      if (depth === 0)
        throw new Error(`${path}:${i + 1}: ${END} without a start`);
      depth--;
    } else if (depth === 0) kept.push(line);
  }
  if (depth !== 0) throw new Error(`${path}: ${START} never ended`);
  return kept.join("\n");
}

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.push(relative(base, full).split("\\").join("/"));
  }
  return out;
}

const excluded = (path) =>
  ROM_EXCLUDE.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));

// The built ROM first, then the overlay on top, as scripts/build-rom.mjs lays it out (the overlay may be newer)
const romFiles = new Map();
for (const path of walk(ROM_BASE)) romFiles.set(path, join(ROM_BASE, path));
for (const path of walk(OVERLAY)) romFiles.set(path, join(OVERLAY, path));

const leaks = [];
const entries = [];
const chunks = [];
let offset = 0;
for (const [path, src] of [...romFiles].sort(([a], [b]) =>
  a.localeCompare(b),
)) {
  if (excluded(path)) continue;
  let data = readFileSync(src);
  if (!data.subarray(0, 8000).includes(0)) {
    const text = stripPrivate(
      data.toString("utf8").replace(/\r\n/g, "\n"),
      path,
    );
    text.split("\n").forEach((line, i) => {
      if (leaky(line))
        leaks.push(`${path}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
    data = Buffer.from(text, "utf8");
  }
  entries.push({ path: `/craftos/${path}`, offset, size: data.length });
  chunks.push(data);
  offset += data.length;
}
if (leaks.length) {
  console.error(`${leaks.length} private references left in the browser ROM:`);
  for (const l of leaks.slice(0, 50)) console.error("  " + l);
  process.exit(1);
}

// One file, gzipped: "CRAFTOSROM1\0", the index length (uint32 LE), the JSON index ({path, offset, size}), the bytes
const index = Buffer.from(JSON.stringify(entries), "utf8");
const head = Buffer.alloc(16);
head.write("CRAFTOSROM1", 0, "latin1");
head.writeUInt32LE(index.length, 12);
const pack = gzipSync(Buffer.concat([head, index, ...chunks]), { level: 9 });
writeFileSync(join(OUT, `rom-${CC_VERSION}.pack`), pack);

copyFileSync(join(ENGINE_OUT, "craftos.js"), join(OUT, "craftos.js"));
copyFileSync(join(ENGINE_OUT, "craftos.wasm"), join(OUT, "craftos.wasm"));
copyFileSync(
  join(REPO, "packages", "rawterm", "assets", "cc-font.bin"),
  join(OUT, "cc-font.bin"),
);
copyFileSync(join(WEB, "src", "player.js"), join(OUT, "player.js"));
copyFileSync(join(WEB, "src", "worker.js"), join(OUT, "worker.js"));

const files = {};
for (const name of readdirSync(OUT).sort()) {
  const data = readFileSync(join(OUT, name));
  files[name] = {
    hash: createHash("sha256").update(data).digest("hex").slice(0, 16),
    size: data.length,
  };
}
writeFileSync(
  join(OUT, "manifest.json"),
  JSON.stringify(
    { ccVersion: CC_VERSION, rom: `rom-${CC_VERSION}.pack`, files },
    null,
    2,
  ) + "\n",
);

console.log(
  `${entries.length} ROM files (${(offset / 1024).toFixed(0)} KB) -> ${OUT}`,
);
for (const [name, { size }] of Object.entries(files))
  console.log(
    `  ${name.padEnd(20)} ${(size / 1024).toFixed(0).padStart(6)} KB`,
  );
