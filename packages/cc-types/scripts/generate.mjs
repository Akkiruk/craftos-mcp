// Write the generated half of the library:
//   library/generated/     every Lua API and cc.* module of CC:Tweaked, from the doc comments in its ROM
//   library/mods/          every mod peripheral the emulator builds, from what the emulator itself answered
//   library/generated/peripheral.lua gets peripheral.find's list of known types from both
//
//   node packages/cc-types/scripts/generate.mjs [--rom rom] [--check]
//
// --rom: the folder with cc-1.101.3 and cc-1.121.0 in it (scripts/build-rom.mjs makes them). --check writes nothing
// and fails when the files on disk are out of date. The hand-written files (library/*.lua) are read to leave out
// what they already define.
//
// The ROM's doc comments are CC:Tweaked's, under its licence, and this repo ships no CC:Tweaked file. So only facts
// are taken from them: names, parameter names, types, defaults and versions. No sentence of theirs is written out,
// and there is no option that does. Descriptions are our own lines in lib/summaries.mjs, and every entry links to
// its page on tweaked.cc.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NEW, OLD, readRom, writeRom } from "./lib/rom.mjs";
import { CORE_TYPES, writeMods } from "./lib/mods.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const REPO = join(PKG, "..", "..");
const LIBRARY = join(PKG, "library");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const romRoot = value("--rom", join(REPO, "rom"));

const warnings = [];
const warn = (message) => {
  if (!warnings.includes(message)) warnings.push(message);
};

/** "module.name" of everything the hand-written files define. */
function handWritten() {
  const found = new Set();
  for (const name of readdirSync(LIBRARY)) {
    if (!name.endsWith(".lua")) continue;
    const text = readFileSync(join(LIBRARY, name), "utf8");
    for (const m of text.matchAll(
      /^function ([A-Za-z_]\w*)[.:]([A-Za-z_]\w*)\s*\(/gm,
    ))
      found.add(`${m[1]}.${m[2]}`);
    for (const m of text.matchAll(/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*=/gm))
      found.add(`${m[1]}.${m[2]}`);
  }
  return found;
}

function listFiles(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) listFiles(full, base, out);
    else
      out.push(
        full
          .slice(base.length + 1)
          .split("\\")
          .join("/"),
      );
  }
  return out;
}

const files = {};
const emulator = JSON.parse(
  readFileSync(join(PKG, "data", "emulator-globals.json"), "utf8"),
);
const peripherals = JSON.parse(
  readFileSync(join(PKG, "data", "emulator-peripherals.json"), "utf8"),
);

// ===== mods =====
const mods = writeMods(peripherals, REPO, warn);
for (const [path, text] of Object.entries(mods.files))
  files[`mods/${path}`] = text;

// ===== the ROM =====
const oldRom = join(romRoot, `cc-${OLD.cc}`);
const newRom = join(romRoot, `cc-${NEW.cc}`);
for (const dir of [oldRom, newRom]) {
  if (!existsSync(join(dir, "rom", "apis"))) {
    console.error(
      `no ROM at ${dir}: build it with scripts/build-rom.mjs --download, or pass --rom`,
    );
    process.exit(2);
  }
}
const rom = writeRom(
  readRom(newRom, warn),
  readRom(oldRom, () => {}),
  {
    old: emulator.globals["1.18.2"].globals,
    new: emulator.globals["1.20.1"].globals,
    oldModules: emulator.modules["1.18.2"],
    newModules: emulator.modules["1.20.1"],
  },
  handWritten(),
  {
    findOverloads: [
      ...Object.entries(CORE_TYPES).map(([type, cls]) => ({
        types: [type],
        type: cls,
      })),
      ...mods.findOverloads,
    ],
  },
  warn,
);
for (const [path, text] of Object.entries(rom.files))
  files[`generated/${path}`] = text;

// ===== write, or compare =====
const stale = [];
for (const [path, text] of Object.entries(files)) {
  const full = join(LIBRARY, path);
  const body = text.replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "\n");
  const current = existsSync(full)
    ? readFileSync(full, "utf8").replace(/\r\n/g, "\n")
    : undefined;
  if (current === body) continue;
  stale.push(path);
  if (!flag("--check")) {
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
}
for (const folder of ["generated", "mods"]) {
  for (const path of listFiles(join(LIBRARY, folder))) {
    if (files[`${folder}/${path}`] !== undefined) continue;
    stale.push(`${folder}/${path} (no longer generated)`);
    if (!flag("--check")) rmSync(join(LIBRARY, folder, path));
  }
}

for (const w of warnings) console.warn(`warning: ${w}`);
const c = rom.counts;
if (c.unsummarised.length) {
  console.warn(
    `warning: no line in lib/summaries.mjs for ${[...new Set(c.unsummarised)].join(", ")}: they get only the link`,
  );
}
console.log(
  `ROM: ${c.modules} modules, ${c.functions} functions, ${c.values} constants, ${c.classes} classes with ${c.methods} methods` +
    (c.filled.length
      ? `; ${c.filled.length} undocumented names filled in from the emulator`
      : ""),
);
console.log(
  `mods: ${mods.counts.types} peripheral types as ${mods.counts.classes} classes, ${mods.counts.methods} methods`,
);
if (flag("--check")) {
  if (stale.length) {
    console.error(`out of date, run generate.mjs:\n  ${stale.join("\n  ")}`);
    process.exit(1);
  }
  console.log("generated files are up to date");
} else
  console.log(stale.length ? `wrote ${stale.length} files` : "nothing changed");
