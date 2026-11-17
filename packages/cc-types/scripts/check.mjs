// Run lua-language-server over real CC programs with the library and fail when it reports something the library is
// there to prevent.
//
//   node packages/cc-types/scripts/check.mjs [--baseline] [--json] [--download] [files or folders...]
//
// Three checks:
//   1. the library itself: no diagnostic at all inside library/ (a broken annotation shows up here)
//   2. coverage: a file that names every global, field and cc.* module the emulator has on either CC:Tweaked version
//      (data/emulator-globals.json) must have no undefined global or field
//   3. the examples (default: workspace/hello.lua and the example folders below): no undefined global, and no call
//      with the wrong number of arguments that is not there without the library too (those are the program's own)
// --baseline prints the counts without and with the library, --list every diagnostic left. Exit code 1 when a check
// fails, 2 when lua-language-server is not there.
//
// lua-language-server is looked for in LUA_LANGUAGE_SERVER, on PATH, in the VS Code Lua extension (sumneko.lua) and
// in packages/cc-types/.cache; --download fetches the pinned release into .cache.
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const REPO = join(PKG, "..", "..");
const LIBRARY = join(PKG, "library");
const CACHE = join(PKG, ".cache");
const PINNED = "3.19.2";

/** Diagnostics that mean the library has an arity wrong, when they only show up with the library. */
const ARITY = ["redundant-parameter", "missing-parameter"];
/** Globals the examples name that are not CC:Tweaked's: lib/surface.lua looks for other platforms it can draw on. */
const NOT_CC = new Set(["love", "gpu"]);
/** What the check runs on when no path is given. */
const EXAMPLES = [
  "workspace/hello.lua",
  "workspace/examples/math.test.lua",
  "workspace/examples/monitor_demo.lua",
  "workspace/examples/touch_counter.lua",
  "workspace/examples/advanced-peripherals",
  "workspace/examples/create",
  "workspace/examples/extreme-reactors",
  "workspace/examples/games",
  "workspace/examples/mekanism",
  "workspace/examples/power",
  "workspace/examples/rednet",
  "workspace/examples/toms-peripherals",
];

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const targets = args.filter((a) => !a.startsWith("--"));

const exe =
  process.platform === "win32"
    ? "lua-language-server.exe"
    : "lua-language-server";

function findServer() {
  const candidates = [];
  if (process.env.LUA_LANGUAGE_SERVER)
    candidates.push(process.env.LUA_LANGUAGE_SERVER);
  for (const dir of (process.env.PATH ?? "").split(
    process.platform === "win32" ? ";" : ":",
  )) {
    if (dir) candidates.push(join(dir, exe));
  }
  for (const root of [
    ".vscode",
    ".vscode-server",
    ".vscode-insiders",
    ".cursor",
    ".vscode-oss",
  ]) {
    const ext = join(homedir(), root, "extensions");
    if (!existsSync(ext)) continue;
    for (const name of readdirSync(ext)
      .filter((n) => n.startsWith("sumneko.lua-"))
      .sort()
      .reverse()) {
      candidates.push(join(ext, name, "server", "bin", exe));
    }
  }
  candidates.push(join(CACHE, "lua-language-server", "bin", exe));
  return candidates.find((c) => existsSync(c));
}

function download() {
  const platform = { win32: "win32", linux: "linux", darwin: "darwin" }[
    process.platform
  ];
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const ext = process.platform === "win32" ? "zip" : "tar.gz";
  const name = `lua-language-server-${PINNED}-${platform}-${arch}.${ext}`;
  const url = `https://github.com/LuaLS/lua-language-server/releases/download/${PINNED}/${name}`;
  const dir = join(CACHE, "lua-language-server");
  mkdirSync(dir, { recursive: true });
  const archive = join(CACHE, name);
  console.log(`downloading ${url}`);
  execFileSync("curl", ["-fsSL", "-o", archive, url], { stdio: "inherit" });
  // bsdtar (Windows 10+, macOS) and GNU tar both read these; bsdtar reads the zip too
  execFileSync("tar", ["-xf", archive, "-C", dir], { stdio: "inherit" });
  rmSync(archive);
}

let server = findServer();
if (!server && flag("--download")) {
  download();
  server = findServer();
}
if (!server) {
  console.error(
    "lua-language-server not found. Install the VS Code Lua extension (sumneko.lua), put it on PATH, set\n" +
      "LUA_LANGUAGE_SERVER, or run this with --download.",
  );
  process.exit(2);
}

const config = JSON.parse(readFileSync(join(PKG, "config.json"), "utf8"));
/** The addon's settings as a .luarc.json wants them (no "Lua." prefix). */
function luarc(withLibrary) {
  const rc = {
    "workspace.checkThirdParty": false,
    "diagnostics.libraryFiles": "Disable",
  };
  if (withLibrary) {
    for (const [key, value] of Object.entries(config.settings))
      rc[key.replace(/^Lua\./, "")] = value;
    rc["workspace.library"] = [LIBRARY];
  } else rc["runtime.version"] = "Lua 5.2";
  return rc;
}

/** Run --check on a folder; returns [{ file, line, code, message, severity }]. */
function check(folder, rc, level = "Hint") {
  writeFileSync(join(folder, ".luarc.json"), JSON.stringify(rc, null, 2));
  const out = join(folder, "..", `${basename(folder)}-diagnostics.json`);
  const logs = join(folder, "..", `${basename(folder)}-log`);
  rmSync(out, { force: true });
  const run = spawnSync(
    server,
    [
      `--check=${folder}`,
      `--checklevel=${level}`,
      "--check_format=json",
      `--check_out_path=${out}`,
      `--logpath=${logs}`,
    ],
    { encoding: "utf8" },
  );
  if (run.status !== 0 && !existsSync(out))
    throw new Error(
      `lua-language-server failed:\n${run.stdout}\n${run.stderr}`,
    );
  if (!existsSync(out)) return [];
  const raw = JSON.parse(readFileSync(out, "utf8"));
  const found = [];
  for (const [uri, list] of Object.entries(raw)) {
    const file = decodeURIComponent(uri.replace(/^file:\/\/\/?/, ""));
    for (const d of list) {
      found.push({
        file,
        line: d.range.start.line + 1,
        code: String(d.code),
        message: String(d.message).split("\n")[0],
        severity: d.severity,
      });
    }
  }
  return found;
}

const countBy = (list) => {
  const counts = {};
  for (const d of list) counts[d.code] = (counts[d.code] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
};
const total = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);

const work = mkdtempSync(join(tmpdir(), "cc-types-check-"));
let failed = false;
const report = {};

try {
  // ===== 0. every function CC:Tweaked defines in Java, and every method of its own peripherals in the emulator =====
  {
    const defined = new Set();
    const read = (dir) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) read(full);
        else if (name.endsWith(".lua")) {
          for (const m of readFileSync(full, "utf8").matchAll(
            /^function ([A-Za-z_]\w*)[.:]([A-Za-z_]\w*)\s*\(/gm,
          ))
            defined.add(`${m[1]}.${m[2]}`);
        }
      }
    };
    read(LIBRARY);
    // tables that take their functions from a class
    const also = {
      term: ["Redirect"],
      Monitor: ["Redirect"],
      Response: ["ReadHandle"],
      TransferredFile: ["ReadHandle"],
    };
    const has = (owner, name) =>
      [owner, ...(also[owner] ?? [])].some((o) => defined.has(`${o}.${name}`));
    const missing = [];
    const java = JSON.parse(
      readFileSync(join(PKG, "data", "cct-java-api.json"), "utf8"),
    );
    let count = 0;
    for (const [owner, names] of Object.entries(java)) {
      for (const name of Object.keys(names)) {
        count++;
        if (!has(owner, name))
          missing.push(
            `${owner}.${name} (CC:Tweaked ${names[name].join(", ")})`,
          );
      }
    }
    const classes = {
      monitor: ["Monitor"],
      modem: ["Modem"],
      computer: ["Computer"],
      inventory: ["Inventory"],
      fluid_storage: ["FluidStorage"],
      energy_storage: ["EnergyStorage"],
    };
    const probed = JSON.parse(
      readFileSync(join(PKG, "data", "emulator-peripherals.json"), "utf8"),
    );
    for (const [type, p] of Object.entries(probed)) {
      if (p.addon) continue;
      const owners = p.types.flatMap((t) => classes[t] ?? []);
      if (owners.length === 0) continue;
      for (const name of Object.keys(p.methods)) {
        count++;
        if (!owners.some((o) => has(o, name)))
          missing.push(`${type}.${name} (the emulator has it)`);
      }
    }
    report.java = { functions: count, missing: missing.length };
    if (missing.length) {
      failed = true;
      console.error(
        `CC:Tweaked's own API: ${missing.length} of ${count} functions are not in the library`,
      );
      for (const m of missing) console.error(`  ${m}`);
    } else
      console.log(
        `CC:Tweaked's own API: all ${count} Java functions and peripheral methods are defined`,
      );
  }

  // ===== 1. the library itself =====
  {
    const folder = join(work, "library-self");
    mkdirSync(folder);
    cpSync(LIBRARY, join(folder, "library"), { recursive: true });
    const rc = luarc(true);
    delete rc["workspace.library"];
    delete rc["diagnostics.libraryFiles"];
    const found = check(folder, rc, "Warning").filter(
      (d) => d.code !== "unused-local" && d.code !== "duplicate-set-field",
    );
    report.library = countBy(found);
    if (found.length) {
      failed = true;
      console.error(
        `library: ${found.length} problems in the definitions themselves`,
      );
      for (const d of found.slice(0, 40))
        console.error(
          `  ${relative(folder, d.file)}:${d.line} ${d.code}: ${d.message}`,
        );
    } else console.log("library: the definitions are clean");
  }

  // ===== 2. coverage of what the emulator has =====
  {
    const folder = join(work, "coverage");
    mkdirSync(folder);
    const emulator = JSON.parse(
      readFileSync(join(PKG, "data", "emulator-globals.json"), "utf8"),
    );
    // the engine's own, not CC:Tweaked's; and what only one of the mods switched off here would add
    const skip = new Set(["_CCPC_UPDATED_VERSION", "debug", "package"]);
    // Lua 5.1 names only the engine keeps
    const skipFields = new Set([
      "string.gfind",
      "table.foreach",
      "table.foreachi",
      "math.mod",
      "math.pow",
      "math.ldexp",
      "math.frexp",
      "math.cosh",
      "math.sinh",
      "math.tanh",
      "math.atan2",
    ]);
    const lines = [];
    const CANARY = "noSuchFieldAnywhere";
    const canaries = new Map(); // line number -> the table it tests
    const names = new Map();
    for (const mc of Object.keys(emulator.globals)) {
      for (const [name, value] of Object.entries(
        emulator.globals[mc].globals,
      )) {
        if (skip.has(name)) continue;
        if (!names.has(name)) names.set(name, new Set());
        if (typeof value === "object")
          for (const field of Object.keys(value)) names.get(name).add(field);
      }
    }
    const isName = (s) =>
      /^[A-Za-z_]\w*$/.test(s) &&
      !["return", "end", "function", "and", "or", "not", "in", "if"].includes(
        s,
      );
    for (const [name, fields] of names) {
      lines.push(`_ = ${name}`);
      for (const field of fields) {
        if (skipFields.has(`${name}.${field}`)) continue;
        lines.push(
          isName(field)
            ? `_ = ${name}.${field}`
            : `_ = ${name}[${JSON.stringify(field)}]`,
        );
      }
    }
    // A table the language server knows nothing about takes any field without complaint, so "no undefined field"
    // would pass for a module that is missing altogether. One field that cannot exist, per table, must be reported.
    for (const [name, fields] of names)
      if (fields.size) canaries.set(lines.push(`_ = ${name}.${CANARY}`), name);
    const modules = new Map();
    for (const mc of Object.keys(emulator.modules)) {
      for (const [name, fields] of Object.entries(emulator.modules[mc])) {
        if (name === "cc.require") continue;
        if (!modules.has(name)) modules.set(name, new Set());
        for (const field of Object.keys(fields)) modules.get(name).add(field);
      }
    }
    let n = 0;
    for (const [name, fields] of modules) {
      n++;
      lines.push(`local m${n} = require(${JSON.stringify(name)})`);
      for (const field of fields) lines.push(`_ = m${n}.${field}`);
      canaries.set(lines.push(`_ = m${n}.${CANARY}`), name);
    }
    writeFileSync(join(folder, "coverage.lua"), lines.join("\n") + "\n");
    const all = check(folder, luarc(true)).filter(
      (d) => d.code === "undefined-global" || d.code === "undefined-field",
    );
    const found = all.filter((d) => !canaries.has(d.line));
    const untyped = [...canaries]
      .filter(([line]) => !all.some((d) => d.line === line))
      .map(([, name]) => name);
    const count = lines.length - canaries.size;
    report.coverage = {
      names: count,
      missing: found.length,
      untyped: untyped.length,
    };
    if (found.length || untyped.length) {
      failed = true;
      console.error(
        `coverage: ${found.length} of ${count} names the emulator has are not in the library`,
      );
      for (const d of found.slice(0, 60))
        console.error(
          `  ${lines[d.line - 1].replace(/^_ = /, "")}: ${d.message}`,
        );
      for (const name of untyped)
        console.error(`  ${name}: not typed at all (any field is accepted)`);
    } else
      console.log(
        `coverage: all ${count} globals, fields and modules the emulator has are defined`,
      );
  }

  // ===== 3. right code stays clean, wrong code is caught (test/usage.lua, test/misuse.lua) =====
  {
    const folder = join(work, "usage");
    mkdirSync(folder);
    cpSync(join(PKG, "test", "usage.lua"), join(folder, "usage.lua"));
    cpSync(join(PKG, "test", "misuse.lua"), join(folder, "misuse.lua"));
    const found = check(folder, luarc(true));
    // what a mistake in the library would cause in code that is right
    const wrong = [
      "undefined-global",
      "undefined-field",
      "param-type-mismatch",
      "redundant-parameter",
      "missing-parameter",
      "deprecated",
      "need-check-nil",
      "assign-type-mismatch",
      "cast-local-type",
      "undefined-doc-name",
      "missing-fields",
      "inject-field",
    ];
    const noise = found.filter(
      (d) => d.file.endsWith("usage.lua") && wrong.includes(d.code),
    );
    const misuse = readFileSync(join(PKG, "test", "misuse.lua"), "utf8").split(
      "\n",
    );
    const missed = [];
    let expected = 0;
    misuse.forEach((text, index) => {
      const want = /--> ([\w-]+)\s*$/.exec(text)?.[1];
      if (!want) return;
      expected++;
      const here = found
        .filter((d) => d.file.endsWith("misuse.lua") && d.line === index + 1)
        .map((d) => d.code);
      if (!here.includes(want))
        missed.push(
          `misuse.lua:${index + 1} wanted ${want}, got ${here.join(", ") || "nothing"}: ${text.trim()}`,
        );
    });
    report.usage = {
      falsePositives: noise.length,
      expected,
      missed: missed.length,
    };
    if (noise.length || missed.length) {
      failed = true;
      console.error(
        `usage: ${noise.length} false positives in right code, ${missed.length} of ${expected} mistakes not caught`,
      );
      for (const d of noise.slice(0, 60))
        console.error(`  usage.lua:${d.line} ${d.code}: ${d.message}`);
      for (const m of missed) console.error(`  ${m}`);
    } else
      console.log(
        `usage: right code is clean, all ${expected} planted mistakes are caught`,
      );
  }

  // ===== 4. real programs =====
  {
    const folder = join(work, "programs");
    mkdirSync(folder);
    const sources = targets.length
      ? targets.map((t) => resolve(t))
      : EXAMPLES.map((e) => join(REPO, e)).filter(existsSync);
    let files = 0;
    const copy = (from, to) => {
      if (statSync(from).isDirectory()) {
        for (const name of readdirSync(from))
          copy(join(from, name), join(to, name));
      } else if (from.endsWith(".lua")) {
        mkdirSync(dirname(to), { recursive: true });
        cpSync(from, to);
        files++;
      }
    };
    for (const source of sources) {
      if (!existsSync(source))
        throw new Error(`no such file or folder: ${source}`);
      copy(
        source,
        join(
          folder,
          relative(REPO, source).startsWith("..")
            ? basename(source)
            : relative(REPO, source),
        ),
      );
    }
    const withLibrary = check(folder, luarc(true));
    const without = check(folder, luarc(false));
    const after = countBy(withLibrary);
    const before = countBy(without);
    report.programs = { files, before, after };
    if (flag("--baseline")) {
      console.log(`programs: ${files} files`);
      console.log(
        `  without the library: ${total(before)} diagnostics, ${before["undefined-global"] ?? 0} undefined globals`,
      );
      console.log(
        `  with the library:    ${total(after)} diagnostics, ${after["undefined-global"] ?? 0} undefined globals`,
      );
      const codes = [
        ...new Set([...Object.keys(before), ...Object.keys(after)]),
      ];
      for (const code of codes)
        console.log(
          `    ${code.padEnd(28)} ${String(before[code] ?? 0).padStart(6)} -> ${String(after[code] ?? 0).padStart(6)}`,
        );
    }
    const key = (d) => `${d.file}:${d.line}:${d.code}`;
    const own = new Set(without.map(key));
    const bad = withLibrary.filter((d) => {
      if (d.code === "undefined-global")
        return !NOT_CC.has(/`([^`]+)`/.exec(d.message)?.[1]);
      return ARITY.includes(d.code) && !own.has(key(d));
    });
    report.programs.failures = bad.length;
    if (bad.length) {
      failed = true;
      console.error(
        `programs: ${bad.length} undefined globals or wrong argument counts in ${files} files`,
      );
      for (const d of bad.slice(0, 60))
        console.error(
          `  ${relative(folder, d.file)}:${d.line} ${d.code}: ${d.message}`,
        );
    } else
      console.log(
        `programs: ${files} files, no undefined CC global, no wrong argument count`,
      );
    if (flag("--list")) {
      for (const d of withLibrary.filter(
        (x) =>
          !["unused-local", "unused-function", "lowercase-global"].includes(
            x.code,
          ),
      )) {
        console.log(
          `  ${relative(folder, d.file)}:${d.line} ${d.code}: ${d.message}`,
        );
      }
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (flag("--json")) console.log(JSON.stringify(report, null, 2));
process.exit(failed ? 1 : 0);
