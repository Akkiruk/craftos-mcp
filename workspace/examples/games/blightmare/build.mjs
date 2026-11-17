#!/usr/bin/env node
// build.mjs
// Part of the craftos-mcp examples (MIT).
// Makes install/: BLIGHTMARE as it goes onto a computer, small enough for the default disk (computer_space_limit,
// 1,000,000 bytes). The source is about 2 MB of Lua, most of it the story's text, and taking out comments, blank lines
// and indents only gets that to about 1.7 MB, so the modules are also squeezed with DEFLATE into one file,
// blightmare.pak, which pack.lua opens on the computer. Nothing in the game changes: every string is kept byte for byte,
// and every line stays on its own line number, so an error on the computer points at the same line as the source.
//
//   node workspace/examples/games/blightmare/build.mjs [outDir]
//
// Then copy install/ onto the computer (see the README). Needs only Node; no packages.

import { deflateRawSync } from "node:zlib";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(process.argv[2] ?? join(HERE, "install"));
const LIMIT = 1_000_000;
const MIN_FILE = 500; // CC:Tweaked counts every file and folder as at least this many bytes

/** Files copied as they are: the program, the unpacker, a startup, and the font (read as data). */
const PLAIN = ["blightmare.lua", "pack.lua", "startup.lua", "lib/font"];
/** Kept whole, licence and all (Surface 2 is MIT: its notice stays with every copy). */
const KEEP_COMMENTS = new Set(["lib/surface.lua"]);

/**
 * Lua with its comments and indents taken out. Strings (quoted and long) are copied as they are, a comment that spans
 * lines leaves its line breaks, and a comment inside a line leaves a space, so no two words run together.
 */
export function strip(src) {
  let out = "";
  let i = 0;
  let lineStart = true;
  const n = src.length;
  const longOpen = (at) => {
    // [[ or [=*[ at `at`: the number of = signs, or -1
    if (src[at] !== "[") return -1;
    let j = at + 1;
    while (src[j] === "=") j++;
    return src[j] === "[" ? j - at - 1 : -1;
  };
  const longEnd = (from, level) => {
    const close = "]" + "=".repeat(level) + "]";
    const end = src.indexOf(close, from);
    if (end < 0) throw new Error("unfinished long bracket");
    return end + close.length;
  };
  while (i < n) {
    const c = src[i];
    if (lineStart && (c === " " || c === "\t" || c === "\r")) {
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      out = out.replace(/[ \t]+$/, "");
      out += "\n";
      lineStart = true;
      i++;
      continue;
    }
    lineStart = false;
    if (c === "-" && src[i + 1] === "-") {
      const level = longOpen(i + 2);
      if (level >= 0) {
        const end = longEnd(i + 4 + level, level);
        const breaks = src.slice(i, end).split("\n").length - 1;
        out += breaks ? "\n".repeat(breaks) : " ";
        if (breaks) lineStart = true;
        i = end;
      } else {
        while (i < n && src[i] !== "\n") i++;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === "\\") j++;
        if (src[j] === "\n" && src[j - 1] !== "\\")
          throw new Error("unfinished string");
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "[") {
      const level = longOpen(i);
      if (level >= 0) {
        const end = longEnd(i + 2 + level, level);
        out += src.slice(i, end);
        i = end;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out.replace(/[ \t]+$/, "");
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

/** Every module the game requires: lib/ and games/, as "lib.shell", "games.blightmare.rules" and so on. */
function modules() {
  const list = [];
  for (const top of ["lib", "games"])
    for (const file of walk(join(HERE, top))) {
      const rel = relative(HERE, file).split("\\").join("/");
      if (!rel.endsWith(".lua")) continue;
      list.push({ rel, name: rel.slice(0, -4).split("/").join(".") });
    }
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

/** Build into out (default install/ beside this file). Returns what the computer will count, in bytes. */
export function build(out = OUT, { quiet = false } = {}) {
  const OUT = out;
  const log = quiet ? () => {} : console.log;
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, "lib"), { recursive: true });
  const index = [];
  const blobs = [];
  let source = 0;
  let stripped = 0;
  for (const { rel, name } of modules()) {
    const text = readFileSync(join(HERE, rel), "utf8").replace(/\r\n/g, "\n");
    const small = KEEP_COMMENTS.has(rel) ? text : strip(text);
    const raw = Buffer.from(small, "utf8");
    const packed = deflateRawSync(raw, { level: 9, memLevel: 9 });
    index.push(`${name}\t${packed.length}\t${raw.length}`);
    blobs.push(packed);
    source += Buffer.byteLength(text);
    stripped += raw.length;
  }
  const pak = Buffer.concat([
    Buffer.from(index.join("\n") + "\n\n", "utf8"),
    ...blobs,
  ]);
  writeFileSync(join(OUT, "blightmare.pak"), pak);
  for (const rel of PLAIN) copyFileSync(join(HERE, rel), join(OUT, rel));

  // what the computer will count: each file's size, at least 500 bytes, and each folder 500
  let bytes = 0;
  let counted = 0;
  const files = walk(OUT);
  for (const file of files) {
    const size = statSync(file).size;
    bytes += size;
    counted += Math.max(size, MIN_FILE);
  }
  counted += MIN_FILE; // lib/
  const kb = (b) => `${(b / 1000).toFixed(1)} kB`;
  log(
    `${index.length} modules: ${kb(source)} of source, ${kb(stripped)} without comments, ${kb(pak.length)} packed`,
  );
  log(
    `install/: ${files.length} files, ${bytes} bytes (${counted} as CC:Tweaked counts them) of ${LIMIT}`,
  );
  log(`room left for saves: ${LIMIT - counted} bytes -> ${OUT}`);
  if (counted > LIMIT)
    throw new Error(
      `install/ is ${counted} bytes: too big for a computer's default disk`,
    );
  return counted;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  build();
