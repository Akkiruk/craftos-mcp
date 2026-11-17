// What the web extension (src/web) needs besides its own code, laid out in dist/web/ by esbuild.mjs:
//
//   dist/web/overlay.pack     the emulator's ROM overlay (rom-overlay/), gzipped, in web/build-runtime.mjs's pack
//                             format with paths relative to the ROM root. The CC:Tweaked part of the ROM is made on
//                             the user's machine from CC:Tweaked's jar (src/web/rom.ts), never packed here.
//   dist/web/runtime/         the browser engine: craftos.js and craftos.wasm (engine/build-web.cmd builds them;
//                             CRAFTOS_WEB_BUILD_DIR, else engine/build-web, else web/dist/runtime), and web/src's
//                             player.js and worker.js. Without the engine the web extension says so when asked to run.
//
// The overlay is the public copy's, as web/build-runtime.mjs makes it: turtle block data cut (no turtles in the
// browser), the server-mod files left out and @private blocks stripped. Tom's Peripherals' fonts.lua is left out too:
// it is generated from that mod's jar (scripts/build-toms-fonts.mjs) and is not ours to ship.
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
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";

const EXCLUDE = [
  "rom/ccsim/turtle/data/",
  "rom/ccsim/addons/toms-peripherals/fonts.lua",
];

const leaky = () => false;

const PRIVATE = "@" + "private-";
const START = PRIVATE + "start";
const END = PRIVATE + "end";

/** scripts/export-public.mjs stripPrivate's rules. */
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

function overlayPack(overlay) {
  const excluded = (p) =>
    EXCLUDE.some((e) => (e.endsWith("/") ? p.startsWith(e) : p === e));
  const leaks = [];
  const entries = [];
  const chunks = [];
  let offset = 0;
  for (const path of walk(overlay).sort()) {
    if (excluded(path)) continue;
    let data = readFileSync(join(overlay, path));
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
    entries.push({ path, offset, size: data.length });
    chunks.push(data);
    offset += data.length;
  }
  if (leaks.length)
    throw new Error(
      `private references left in the overlay:\n  ${leaks.slice(0, 50).join("\n  ")}`,
    );
  const index = Buffer.from(JSON.stringify(entries), "utf8");
  const head = Buffer.alloc(16);
  head.write("CRAFTOSROM1", 0, "latin1");
  head.writeUInt32LE(index.length, 12);
  return {
    pack: gzipSync(Buffer.concat([head, index, ...chunks]), { level: 9 }),
    files: entries.length,
  };
}

/** Lay out dist/web/ (overlay.pack, runtime/). Returns whether the browser engine is in. */
export function buildWebAssets(here, repo) {
  const out = join(here, "dist", "web");
  rmSync(join(out, "runtime"), { recursive: true, force: true });
  mkdirSync(join(out, "runtime"), { recursive: true });
  const overlay = join(repo, "rom-overlay");
  if (existsSync(overlay)) {
    const { pack, files } = overlayPack(overlay);
    writeFileSync(join(out, "overlay.pack"), pack);
    console.log(
      `web: ${files} overlay files, ${(pack.length / 1024).toFixed(0)} KB packed`,
    );
  } else console.warn(`no ${overlay}: the web extension has no ROM overlay`);
  for (const f of ["player.js", "worker.js"])
    copyFileSync(join(repo, "web", "src", f), join(out, "runtime", f));
  const engineDirs = [
    process.env.CRAFTOS_WEB_BUILD_DIR,
    join(repo, "engine", "build-web"),
    join(repo, "web", "dist", "runtime"),
  ].filter(Boolean);
  const engine = engineDirs.find(
    (d) =>
      existsSync(join(d, "craftos.js")) && existsSync(join(d, "craftos.wasm")),
  );
  if (!engine) {
    console.warn(
      `no browser engine (craftos.js, craftos.wasm) in ${engineDirs.join(", ")}: run engine\\build-web.cmd`,
    );
    return false;
  }
  for (const f of ["craftos.js", "craftos.wasm"])
    copyFileSync(join(engine, f), join(out, "runtime", f));
  console.log(`web: engine from ${engine}`);
  return true;
}
