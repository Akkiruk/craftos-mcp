// What the desktop app does, without Electron: where its files are, the list of Minecraft versions and mods, reading
// and saving a project's craftos.json, the recent projects, and starting the emulator's own command line as a child
// (the browser app for Run, `test` for Run tests). main.mjs is the window around this; core.test.ts runs it under
// plain Node.
import { fork } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PROJECT_FILE = "craftos.json";
const SCHEMA_URL =
  "https://raw.githubusercontent.com/Akkiruk/craftos-mcp/main/schemas/craftos.schema.json";
export const RELEASES_URL = "https://github.com/Akkiruk/craftos-mcp/releases";
const LATEST_API =
  "https://api.github.com/repos/Akkiruk/craftos-mcp/releases/latest";

/**
 * Where the emulator is. Installed: the app's resources hold the npm package's files (craftos/) and this platform's
 * engine (engine/). From a clone (`npm start` in apps/desktop): the clone itself, with its own engine and ROM.
 * CRAFTOS_DESKTOP_PAYLOAD points a clone's app at an unpacked package instead.
 */
export function locate({ packaged, resourcesPath, here, env = process.env }) {
  const exe = process.platform === "win32" ? "craftos.exe" : "craftos";
  const payload =
    env.CRAFTOS_DESKTOP_PAYLOAD ||
    (packaged ? join(resourcesPath, "craftos") : "");
  if (payload) {
    const root = resolve(payload);
    const engine = join(dirname(root), "engine", exe);
    return {
      packaged: true,
      root,
      launcher: join(root, "scripts", "npm", "craftos-mcp.mjs"),
      engine: existsSync(engine) ? engine : undefined,
    };
  }
  const root = resolve(here, "..", "..", "..");
  return {
    packaged: false,
    root,
    launcher: join(root, "apps", "cli", "dist", "index.js"),
    engine: undefined,
  };
}

/** The emulator's own code (versions, mods, craftos.json's rules), loaded from where `locate` found it. */
export async function loadRunner(loc) {
  return import(
    pathToFileURL(join(loc.root, "packages", "runner", "dist", "index.js")).href
  );
}

const newestFirst = (a, b) => {
  const pa = a.mc.split(".").map(Number);
  const pb = b.mc.split(".").map(Number);
  for (let i = 0; i < 3; i++)
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
  return 0;
};

/** The Minecraft versions (newest first) and every mod with its plain description, for the home screen. */
export function catalog(runner) {
  return {
    defaultMc: runner.DEFAULT_MC,
    versions: runner.VERSIONS.map((v) => ({ mc: v.mc, cc: v.cc })).sort(
      newestFirst,
    ),
    addons: runner.ADDONS.map((a) => ({
      id: a.id,
      name: a.name,
      summary: runner.addonSummary?.(a.id) ?? "",
      versions: { ...a.versions },
      simulates: a.simulates ?? null,
      requires: [...(a.requires ?? [])],
    })),
  };
}

const SKIP_DIRS = new Set(["node_modules", "__snapshots__"]);

/** The .lua files of a folder (workspace paths, / separated), without reading a whole disk when the folder is huge. */
export function listLua(dir, { maxFiles = 2000, maxDepth = 6 } = {}) {
  const programs = [];
  const tests = [];
  let seen = 0;
  const walk = (folder, prefix, depth) => {
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (seen >= maxFiles) return;
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth < maxDepth) walk(join(folder, e.name), rel, depth + 1);
      } else if (e.name.endsWith(".lua")) {
        seen++;
        (e.name.endsWith(".test.lua") ? tests : programs).push(rel);
      }
    }
  };
  walk(dir, "", 0);
  // programs at the top of the folder first: they are the ones people run
  const depth = (p) => p.split("/").length;
  programs.sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
  return { programs, tests };
}

const isDir = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** The mods that can be on for a Minecraft version, with the ones they need switched on too, in the list's order. */
function cleanAddons(runner, ids, mc) {
  const byId = new Map(runner.ADDONS.map((a) => [a.id, a]));
  const on = new Set();
  const add = (id) => {
    const a = byId.get(id);
    if (!a || a.versions[mc] === undefined || on.has(id)) return;
    on.add(id);
    for (const need of a.requires ?? []) add(need);
  };
  for (const id of ids) add(id);
  // a mod whose needed mod has no release for this version cannot be on
  for (const id of [...on])
    if ((byId.get(id).requires ?? []).some((need) => !on.has(need)))
      on.delete(id);
  return runner.ADDONS.filter((a) => on.has(a.id)).map((a) => a.id);
}

function readData(runner, dir) {
  const file = join(dir, PROJECT_FILE);
  if (!existsSync(file)) return { file, hasFile: false, data: {} };
  try {
    return { file, hasFile: true, data: runner.readProject(file).data };
  } catch (error) {
    return { file, hasFile: true, data: {}, broken: error.message };
  }
}

/** Everything the home screen shows about a project folder: its choices (craftos.json, else the defaults) and its files. */
export function readProject(runner, dir) {
  dir = resolve(dir);
  if (!isDir(dir)) throw new Error(`${dir} is not a folder`);
  const { file, hasFile, data, broken } = readData(runner, dir);
  const errors = broken
    ? [broken]
    : hasFile
      ? runner.checkProject(data, dir)
      : [];
  const known = (mc) => runner.VERSIONS.some((v) => v.mc === mc);
  const minecraft = known(data.minecraft) ? data.minecraft : runner.DEFAULT_MC;
  const available = runner.ADDONS.filter(
    (a) => a.versions[minecraft] !== undefined,
  ).map((a) => a.id);
  const spec = data.addons;
  let listed;
  if (spec === undefined || spec === "all") listed = available;
  else if (spec === "none") listed = [];
  else
    listed = (Array.isArray(spec) ? spec : String(spec).split(","))
      .map((s) => String(s).trim())
      .filter(Boolean);
  const addons = cleanAddons(runner, listed, minecraft);
  const workspace = resolve(
    dir,
    typeof data.workspace === "string" && data.workspace.trim()
      ? data.workspace
      : ".",
  );
  const { programs, tests } = isDir(workspace)
    ? listLua(workspace)
    : { programs: [], tests: [] };
  const run =
    typeof data.run === "string" && programs.includes(data.run) ? data.run : "";
  return {
    dir,
    name: basename(dir) || dir,
    file,
    hasFile,
    broken: Boolean(broken),
    errors,
    minecraft,
    addons,
    workspace,
    programs,
    tests,
    run,
  };
}

/**
 * Save a choice made on the home screen into the folder's craftos.json: `minecraft`, `addons` (a list of ids) and
 * `run` (a program, or "" for none). Everything else in the file stays as it is. A file that is not valid JSON is
 * never written over.
 */
export function saveProject(runner, dir, change = {}) {
  dir = resolve(dir);
  const { file, hasFile, data: old, broken } = readData(runner, dir);
  if (broken)
    throw new Error(
      `${file} is not valid JSON, so the choice was not saved. Fix or delete the file. (${broken})`,
    );
  const data = hasFile ? { ...old } : { $schema: SCHEMA_URL, workspace: "." };
  const before = readProject(runner, dir);
  const minecraft = change.minecraft ?? before.minecraft;
  if (!runner.VERSIONS.some((v) => v.mc === minecraft))
    throw new Error(`unknown Minecraft version ${minecraft}`);
  const available = runner.ADDONS.filter(
    (a) => a.versions[minecraft] !== undefined,
  ).map((a) => a.id);
  // "all" stays "all" across a version change; a hand-picked list keeps what the new version has
  const wasAll = old.addons === undefined || old.addons === "all" || !hasFile;
  const addons =
    change.addons !== undefined
      ? cleanAddons(runner, change.addons, minecraft)
      : wasAll
        ? available
        : cleanAddons(runner, before.addons, minecraft);
  data.minecraft = minecraft;
  data.addons =
    addons.length === available.length
      ? "all"
      : addons.length === 0
        ? "none"
        : addons;
  if (change.run !== undefined) {
    if (change.run) data.run = change.run;
    else delete data.run;
  }
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return readProject(runner, dir);
}

const BAD_NAME = /[<>:"/\\|?*\x00-\x1f]|^\.+$|^\s*$|[. ]$/;

const HELLO = `-- Your first program. Press Run in CraftOS to start it.
term.clear()
term.setCursorPos(1, 1)
print("Hello from " .. (os.getComputerLabel() or "your computer") .. "!")
print("Edit hello.lua in this folder, then press Run again.")
`;

const HELLO_TEST = `-- A test file: Run tests in CraftOS runs every *.test.lua.
ccunit.test("numbers add up", function()
  ccunit.eq(1 + 1, 2)
end)
`;

/** A new project folder with a craftos.json, a first program and a first test. Returns the folder. */
export function createProject(runner, { parent, name, minecraft }) {
  name = String(name ?? "").trim();
  if (BAD_NAME.test(name) || name.length > 80)
    throw new Error(
      'Pick a name without \\ / : * ? " < > | and not ending in a dot or space.',
    );
  if (!parent) throw new Error("Pick where to put the project.");
  const dir = resolve(parent, name);
  if (existsSync(dir) && (!isDir(dir) || readdirSync(dir).length > 0))
    throw new Error(
      `${dir} is there already and is not empty. Pick another name, or use Open a folder.`,
    );
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "hello.lua"), HELLO);
  writeFileSync(join(dir, "hello.test.lua"), HELLO_TEST);
  const mc = minecraft ?? runner.DEFAULT_MC;
  if (!runner.VERSIONS.some((v) => v.mc === mc))
    throw new Error(`unknown Minecraft version ${mc}`);
  const data = {
    $schema: SCHEMA_URL,
    workspace: ".",
    minecraft: mc,
    // no mods until the person ticks the ones their pack has (the home screen lists them)
    addons: "none",
    tests: ["**/*.test.lua"],
    run: "hello.lua",
  };
  writeFileSync(join(dir, PROJECT_FILE), `${JSON.stringify(data, null, 2)}\n`);
  return dir;
}

/** A small JSON file that never throws: a missing or broken one reads as the default. */
export class JsonStore {
  constructor(file, fallback) {
    this.file = file;
    this.fallback = fallback;
  }
  read() {
    try {
      const value = JSON.parse(readFileSync(this.file, "utf8"));
      return value && typeof value === "object" ? value : this.fallback;
    } catch {
      return this.fallback;
    }
  }
  write(value) {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(value, null, 2)}\n`);
  }
}

const samePath = (a, b) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

/** The recent projects, newest first. */
export class Recents {
  constructor(file, max = 12) {
    this.store = new JsonStore(file, []);
    this.max = max;
  }
  list() {
    const raw = this.store.read();
    return (Array.isArray(raw) ? raw : [])
      .filter((r) => r && typeof r.dir === "string")
      .map((r) => ({
        dir: r.dir,
        name: basename(r.dir) || r.dir,
        opened: Number(r.opened) || 0,
        missing: !isDir(r.dir),
      }));
  }
  add(dir, now = Date.now()) {
    dir = resolve(dir);
    const rest = this.list().filter((r) => !samePath(r.dir, dir));
    this.store.write(
      [
        { dir, opened: now },
        ...rest.map((r) => ({ dir: r.dir, opened: r.opened })),
      ].slice(0, this.max),
    );
  }
  remove(dir) {
    this.store.write(
      this.list()
        .filter((r) => !samePath(r.dir, resolve(dir)))
        .map((r) => ({ dir: r.dir, opened: r.opened })),
    );
  }
}

export const DEFAULT_SETTINGS = { theme: "system", autoUpdate: true };

export function readSettings(store) {
  const s = { ...DEFAULT_SETTINGS, ...store.read() };
  if (!["system", "light", "dark"].includes(s.theme)) s.theme = "system";
  s.autoUpdate = s.autoUpdate !== false;
  return s;
}

/** The environment of a child that runs the emulator's command line for a project. */
export function childEnv(loc, project, env = process.env) {
  const out = { ...env, ELECTRON_RUN_AS_NODE: "1" };
  // the project's craftos.json decides, not a variable left over from a terminal
  for (const key of [
    "CRAFTOS_WORKSPACE",
    "CRAFTOS_ADDONS",
    "CRAFTOS_PROJECT_FILE",
    "CRAFTOS_VERSION",
  ])
    delete out[key];
  // the first run builds this version's CC:Tweaked files first
  if (project?.minecraft) out.CRAFTOS_VERSION = project.minecraft;
  if (loc.engine && !out.CRAFTOS_ENGINE) out.CRAFTOS_ENGINE = loc.engine;
  return out;
}

function lines(stream, each) {
  let rest = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    rest += chunk;
    const parts = rest.split(/\r?\n/);
    rest = parts.pop();
    for (const line of parts) each(line);
  });
  stream.on("end", () => rest && each(rest));
}

/** What a setup line means to a person: the first run fetches CC:Tweaked's own files, which cannot ship with the app. */
export function plainProgress(line) {
  const text = line.replace(/^craftos-mcp: ?/, "").trim();
  if (!text) return "";
  if (/^setting up /.test(text))
    return "First run: getting CC:Tweaked's files from the official download (once, about a minute)";
  if (/^building the ROM for Minecraft (\S+)/.test(text))
    return `Getting CC:Tweaked's files for Minecraft ${/Minecraft (\S+)/.exec(text)[1]} (once, about 20 seconds)`;
  if (/^ready \(/.test(text)) return "Ready";
  // the command line's advice is about variables and npx: the app's is to get online and try again
  if (/^No network, or a proxy\?/.test(text))
    return "CraftOS needs the internet once, to download CC:Tweaked's files. Connect, then try again.";
  const unreachable = /^setup failed: could not reach ([^\s:]+)/.exec(text);
  if (unreachable)
    return `The download did not work: could not reach ${unreachable[1]}.`;
  if (/^cannot \w+ without the engine and ROM/.test(text)) return "";
  const download = /^Downloading https?:\/\/([^/\s]+)\/\S*?([^/\s]+)$/.exec(
    text,
  );
  if (download) return `Downloading ${download[2]} from ${download[1]}`;
  if (/^ROM cc-\S+ \(Minecraft (\S+)\)/.test(text))
    return `Getting CC:Tweaked's files for Minecraft ${/Minecraft ([^)\s]+)/.exec(text)[1]}`;
  if (/^(ROM written to|Wrote) /.test(text))
    return "Putting CC:Tweaked's files in place";
  return text;
}

/**
 * Start the browser app for a project (`craftos-mcp app` in the project's folder, on a free port) and resolve with
 * its address once it listens. `stop()` shuts its computers down and ends it.
 */
export function startApp(loc, project, { onLog = () => {}, env } = {}) {
  return new Promise((done, fail) => {
    const child = fork(loc.launcher, ["app", "--port", "0", "--no-open"], {
      cwd: project.dir,
      env: childEnv(loc, project, env),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    const tail = [];
    let url;
    let exited = false;
    const exit = new Promise((r) => child.once("exit", r));
    const stop = async () => {
      if (exited) return;
      try {
        if (child.connected) child.send("stop");
        else child.kill();
      } catch {
        child.kill();
      }
      const timer = setTimeout(() => child.kill(), 8000);
      await exit;
      clearTimeout(timer);
    };
    lines(child.stdout, (line) => {
      const m = /^craftos-mcp app: (http:\/\/\S+)/.exec(line);
      if (m && !url) {
        url = m[1];
        done({ url, stop, exit });
      }
    });
    lines(child.stderr, (line) => {
      if (!line.trim()) return;
      tail.push(line);
      if (tail.length > 12) tail.shift();
      onLog(plainProgress(line));
    });
    child.once("error", (error) => fail(error));
    child.once("exit", (code) => {
      exited = true;
      if (!url)
        fail(
          new Error(
            tail.map(plainProgress).filter(Boolean).join("\n") ||
              `The emulator stopped before it started (code ${code}).`,
          ),
        );
    });
  });
}

/**
 * The world craftos.json names (`world`: a JSON file in the project, or the name of a saved world), as the browser
 * app's form takes it. Run starts the computer in it, the same world `craftos-mcp run` and Run tests use.
 */
export function projectWorld(runner, dir) {
  dir = resolve(dir);
  const { data, broken } = readData(runner, dir);
  if (broken || typeof data.world !== "string" || !data.world.trim()) return {};
  const name = data.world.trim();
  if (!/\.json$/i.test(name)) return { worldFile: name };
  let world;
  try {
    world = JSON.parse(readFileSync(resolve(dir, name), "utf8"));
  } catch (error) {
    throw new Error(
      `The world file ${name} (the "world" in craftos.json) could not be read: ${error.message}`,
    );
  }
  if (!world || typeof world !== "object" || Array.isArray(world))
    throw new Error(
      `The world file ${name} (the "world" in craftos.json) must be a JSON object.`,
    );
  const { monitors, $schema: _schema, ...rest } = world;
  return { world: rest, ...(Array.isArray(monitors) && { monitors }) };
}

/**
 * Make the project's computer in a started browser app and (with a program) run it. `world`, `monitors` and
 * `worldFile` are what projectWorld gives. Resolves with its id.
 */
export async function openComputer(
  url,
  { name, program, world, monitors, worldFile } = {},
) {
  const res = await fetch(new URL("api/sessions", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...(name && { name }),
      ...(program && { program }),
      ...(world && { world }),
      ...(monitors && { monitors }),
      ...(worldFile && { worldFile }),
    }),
  });
  if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
  const made = await res.json();
  return made.ids[0];
}

/** The text on every screen of a computer in a started browser app (terminal first). */
export async function screenText(url, id) {
  const res = await fetch(new URL(`api/sessions/${id}/screens`, url));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const screens = await res.json();
  return screens
    .map((s) => (Array.isArray(s.lines) ? s.lines.join("\n") : ""))
    .join("\n");
}

/**
 * Run the project's tests (`craftos-mcp test --json` in its folder). Resolves with { ok, result } (the runner's
 * TestRunResult: passed, failed, files) or { ok: false, message } when they could not run at all.
 */
export function runTests(loc, project, { onLog = () => {}, env } = {}) {
  return new Promise((done) => {
    const child = fork(loc.launcher, ["test", "--json"], {
      cwd: project.dir,
      env: childEnv(loc, project, env),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    let out = "";
    const err = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (out += chunk));
    lines(child.stderr, (line) => {
      if (!line.trim()) return;
      err.push(line);
      onLog(plainProgress(line));
    });
    child.once("error", (error) => done({ ok: false, message: error.message }));
    child.once("exit", (code) => {
      if (code === 0 || code === 1) {
        try {
          const result = JSON.parse(out.slice(out.indexOf("{")));
          return done({ ok: true, result });
        } catch {
          // fall through: say what was printed
        }
      }
      const message = err.map(plainProgress).join("\n").trim();
      done({
        ok: false,
        message: /no \*\.test\.lua files|match no \*\.test\.lua/.test(message)
          ? "This project has no test files yet. A test file ends in .test.lua, like hello.test.lua."
          : message || out.trim() || `The tests stopped (code ${code}).`,
      });
    });
  });
}

/** Build the CC:Tweaked files of every Minecraft version now (`craftos-mcp setup --all`), not on first use. */
export function setUpAll(loc, { onLog = () => {}, env } = {}) {
  return new Promise((done) => {
    if (!loc.packaged)
      return done({
        ok: true,
        message: "A clone builds them with npm run setup.",
      });
    const child = fork(loc.launcher, ["setup", "--all"], {
      env: childEnv(loc, undefined, env),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    const err = [];
    lines(child.stderr, (line) => {
      if (!line.trim()) return;
      err.push(plainProgress(line));
      onLog(plainProgress(line));
    });
    child.once("error", (error) => done({ ok: false, message: error.message }));
    child.once("exit", (code) =>
      done(
        code === 0
          ? { ok: true, message: "Every version is ready." }
          : { ok: false, message: err.slice(-4).join("\n") },
      ),
    );
  });
}

/** -1, 0 or 1 for two x.y.z versions (a leading v is fine; a pre-release sorts before its release). */
export function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v).replace(/^v/, "").split("-");
    return { n: core.split(".").map((x) => Number(x) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++)
    if ((x.n[i] ?? 0) !== (y.n[i] ?? 0))
      return (x.n[i] ?? 0) < (y.n[i] ?? 0) ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * The newest release when it is newer than this app (for the platforms that cannot update themselves: the unsigned
 * macOS app and the .deb). Resolves with { version, url } or undefined; never throws.
 */
export async function newerRelease(current, fetcher = fetch) {
  try {
    const res = await fetcher(LATEST_API, {
      headers: {
        "User-Agent": "craftos-desktop",
        Accept: "application/vnd.github+json",
      },
    });
    if (!res.ok) return undefined;
    const latest = await res.json();
    const version = String(latest.tag_name ?? "").replace(/^v/, "");
    if (!/^\d+\.\d+\.\d+/.test(version)) return undefined;
    return compareVersions(version, current) > 0
      ? { version, url: latest.html_url ?? RELEASES_URL }
      : undefined;
  } catch {
    return undefined;
  }
}
