// The driver behind scripts/compat/run.mjs: one fresh emulated computer per project, driven the way a person at the
// keyboard would (shell lines, keys, mouse, monitor touches), with screenshots and plain pass or fail checks.
//
// Nothing a project ships is kept in this repository. Programs are fetched when the check runs, either by the
// computer itself (wget, pastebin: what a player types) or by `fetch`/`clone` below into the computer's own folder.
// Fetched files are data: they only ever run inside the emulator.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runner = await import(
  new URL("../../packages/runner/dist/index.js", import.meta.url).href
);
const { Keys } = await import(
  new URL("../../packages/rawterm/dist/index.js", import.meta.url).href
);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What a failed check throws: the run stops there and the project is reported as failed with this text. */
export class CheckFailed extends Error {}

/** Text on a screen that means a Lua program died. Projects may add to it or allow some (`allow`). */
export const CRASH_PATTERNS = [
  /attempt to (?:call|index|perform arithmetic|compare|concatenate)/,
  /bad argument #\d/,
  /\.lua:\d+: /,
  /^bios\.lua:\d+: /m,
  /Too long without yielding/,
  /No such program/,
  /java\.lang\./,
  /stack traceback:/,
  /Press any key to continue/,
];

async function download(url) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: { "User-Agent": "craftos-mcp-compat" },
      });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (error) {
      lastError = error;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw lastError;
}

/** The key that types each character on a US keyboard, and whether shift is held for it. */
const KEY_OF = new Map();
for (const c of "abcdefghijklmnopqrstuvwxyz") {
  KEY_OF.set(c, [c, false]);
  KEY_OF.set(c.toUpperCase(), [c, true]);
}
[
  ["0", "zero", ")"],
  ["1", "one", "!"],
  ["2", "two", "@"],
  ["3", "three", "#"],
  ["4", "four", "$"],
  ["5", "five", "%"],
  ["6", "six", "^"],
  ["7", "seven", "&"],
  ["8", "eight", "*"],
  ["9", "nine", "("],
  [" ", "space"],
  ["'", "apostrophe", '"'],
  [",", "comma", "<"],
  ["-", "minus", "_"],
  [".", "period", ">"],
  ["/", "slash", "?"],
  [";", "semicolon", ":"],
  ["=", "equals", "+"],
  ["[", "leftBracket", "{"],
  ["\\", "backslash", "|"],
  ["]", "rightBracket", "}"],
  ["`", "grave", "~"],
].forEach(([plain, key, shifted]) => {
  KEY_OF.set(plain, [key, false]);
  if (shifted) KEY_OF.set(shifted, [key, true]);
});

/** The character each key types when nothing else is held: "a" for the a key, " " for space. */
const CHAR_OF = new Map();
for (const [char, [key, shift]] of KEY_OF) if (!shift) CHAR_OF.set(key, char);

/**
 * A person typing: each character is a key going down, the character, and the key coming up, with shift held
 * around the ones that need it. Programs that read `key` events (menus, y/n prompts, games) see what they would
 * from a real keyboard; a bare `char` event is something no keyboard sends.
 */
async function typeText(session, text) {
  let sent = 0;
  for (const ch of text) {
    // a computer holds 256 events and drops the rest: nobody types a whole line within one tick
    if (++sent % 4 === 0) await sleep(25);
    const [key, shift] = KEY_OF.get(ch) ?? [];
    if (!key) {
      session.char(ch);
      continue;
    }
    if (shift) session.key("leftShift");
    session.key(key);
    session.char(ch);
    session.key(key, { up: true });
    if (shift) session.key("leftShift", { up: true });
  }
}

const sha = (buf) =>
  createHash("sha256").update(buf).digest("hex").slice(0, 10);

/**
 * One project's run. `project` is an entry of projects.mjs; `options.cacheDir` holds downloads and workspaces,
 * `options.shotsDir` receives PNGs, `options.mc` is the Minecraft version the computer is on.
 */
export async function runProject(project, options) {
  const root = join(options.cacheDir, project.id);
  const src = join(root, "src");
  mkdirSync(src, { recursive: true });
  const shotsDir = join(options.shotsDir, project.id);
  rmSync(shotsDir, { recursive: true, force: true });
  mkdirSync(shotsDir, { recursive: true });

  const config = {
    ...runner.loadConfig(),
    runtimeDir: join(options.cacheDir, ".runtime"),
  };
  mkdirSync(config.runtimeDir, { recursive: true });
  const problems = runner.checkConfig(config);
  if (problems.length) throw new Error(problems.join("; "));

  const versions = [];
  const notes = [];
  const shots = [];
  const manager = new runner.SessionManager(config);
  let transcript = "";
  /** A plain CC:Tweaked computer: no other mod, on the Minecraft version asked for. */
  const worldOf = (spec, computerId) => ({
    addons: "none",
    version: options.mc,
    // Lua at the speed of CC:Tweaked's own VM, about 8 times slower than the engine's: demos and games time
    // themselves, and some pick a code path by how fast the computer is
    cobaltSpeed: true,
    ...(computerId ? { computerId } : {}),
    ...(spec.world ?? {}),
  });

  // `project.computers` (a list of { name, world, monitors }) is several computers whose modems reach each other;
  // the first is the one `run(t)` gets and `t.computer(name)` gives the others. Without it there is one computer,
  // described by the project itself. `project.wired` is the wired networks (packages/runner/src/wired.ts): cables and
  // the peripherals behind their modems, which computers join with a `kind: "wired"` modem naming the network.
  const specs = project.computers ?? [project];
  const linkedUp = Boolean(project.computers || project.wired);
  const nameOf = (spec, index) => spec.name ?? `computer${index + 1}`;
  const drivers = specs.map((spec, index) =>
    makeDriver(spec, linkedUp ? index + 1 : 0),
  );
  const t = drivers[0];

  async function bootAll() {
    if (!linkedUp) {
      const d = drivers[0];
      const session = new runner.SessionManager({
        ...config,
        workspaceDir: d.workspace,
      });
      // one manager would do, but its workspace is fixed when it is made
      extraManagers.push(session);
      d.attach(session.create(specs[0].monitors ?? [], 1, worldOf(specs[0])));
    } else {
      const linked = manager.createNetwork({
        computers: specs.map((spec, index) => ({
          name: nameOf(spec, index),
          world: worldOf(spec, index + 1),
          monitors: spec.monitors ?? [],
          workspaceDir: drivers[index].workspace,
        })),
        wired: project.wired,
      });
      specs.forEach((spec, index) =>
        drivers[index].attach(linked.computers[nameOf(spec, index)]),
      );
    }
    await Promise.all(drivers.map((d) => d.waitForBoot()));
  }
  const extraManagers = [];

  function makeDriver(spec, computerId) {
    const ws = join(
      root,
      project.computers ? `computer-${spec.name}` : "computer",
    );
    rmSync(ws, { recursive: true, force: true });
    mkdirSync(ws, { recursive: true });
    const shotPrefix = project.computers ? `${spec.name}-` : "";
    let session;

    const raw = () => session.handle.session;
    const windowOf = (monitor) => {
      if (!monitor) return 0;
      for (const w of raw().allWindows())
        if (w.peripheral === monitor) return w.id;
      throw new CheckFailed(`no monitor named ${monitor}`);
    };
    const lines = (monitor) => raw().screen(windowOf(monitor))?.lines ?? [];
    const text = (monitor) =>
      lines(monitor)
        .map((l) => l.replace(/\s+$/, ""))
        .join("\n");
    /**
     * The world's state file. A program that plays audio has it rewritten many times a second, and a read can land
     * in the middle of a write: try again for a moment before saying there is none.
     */
    const readState = () => {
      const wait = new Int32Array(new SharedArrayBuffer(4));
      for (let attempt = 0; attempt < 40; attempt++) {
        const state = session.handle.readState();
        if (state) return state;
        Atomics.wait(wait, 0, 0, 15);
      }
      return undefined;
    };
    const matches = (what, monitor) => {
      const t = text(monitor);
      if (typeof what !== "string") return what.test(t);
      // a sentence may be wrapped over several lines: look in the screen read as one run of words too
      return (
        t.includes(what) ||
        t
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .join(" ")
          .includes(what)
      );
    };

    const t = {
      project,
      /** The computer's folder on the host, before and while it runs (the engine reads it live). */
      get dir() {
        return session
          ? join(session.handle.dir, "computer", String(computerId))
          : ws;
      },
      workspace: ws,
      /**
       * A floppy disk's folder on the host, once booted: what a drive spec `{ type: "drive", disk: id }` mounts at
       * /disk. For putting a file on a disk that is not text (a song, say).
       */
      diskDir: (id) => join(session.handle.dir, "computer", "disk", String(id)),
      attach(started) {
        session = started;
      },
      waitForBoot: () => runner.waitForBoot(raw(), 30000),
      /** Another computer of `project.computers`, by name: the same driver, for that one. */
      computer(name) {
        const at = specs.findIndex((s) => s.name === name);
        if (at < 0) throw new Error(`no computer named ${name}`);
        return drivers[at];
      },
      note: (line) => notes.push(line),
      version: (line) => versions.push(line),

      // ---- getting files, on the host, as data ----

      /** Shallow-clone a git repository into the cache and record its commit. Returns the folder. */
      clone(url, name = "repo", ref) {
        const dest = join(src, name);
        rmSync(dest, { recursive: true, force: true });
        execFileSync(
          "git",
          [
            "-c",
            "core.symlinks=false",
            "-c",
            "core.autocrlf=false",
            "clone",
            "--quiet",
            "--depth",
            "1",
            ...(ref ? ["--branch", ref] : []),
            url,
            dest,
          ],
          { stdio: ["ignore", "ignore", "pipe"] },
        );
        const commit = execFileSync("git", ["-C", dest, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim();
        versions.push(`commit ${commit.slice(0, 7)}`);
        rmSync(join(dest, ".git"), { recursive: true, force: true });
        return dest;
      },
      /** Copy a fetched folder or file onto the computer (paths relative to the computer's root). */
      install(from, to = ".") {
        const dest = join(t.dir, to);
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(from, dest, { recursive: true });
      },
      /** Download one file onto the computer and record a hash of it. */
      async fetch(url, to) {
        const buf = await download(url);
        const dest = join(t.dir, to);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, buf);
        versions.push(`${to} sha256 ${sha(buf)}`);
        return buf;
      },
      /** Write a file of our own onto the computer (a demo that uses a library, say). */
      put(path, content) {
        const dest = join(t.dir, path);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, content);
      },
      exists: (path) => existsSync(join(t.dir, path)),
      read: (path) => readFileSync(join(t.dir, path), "utf8"),
      list: (path = ".") => {
        try {
          return readdirSync(join(t.dir, path));
        } catch {
          return [];
        }
      },
      size: (path) => {
        try {
          return statSync(join(t.dir, path)).size;
        } catch {
          return -1;
        }
      },
      /** Wait until the computer has written a file (and it is not empty). */
      async waitForFile(path, timeoutMs = 15000) {
        const end = Date.now() + timeoutMs;
        while (t.size(path) <= 0) {
          if (Date.now() > end)
            throw new CheckFailed(
              `no ${path} after ${timeoutMs} ms; the terminal shows:\n${text()}`,
            );
          await sleep(100);
        }
        await sleep(100);
      },
      /** Double-click a terminal cell. */
      async doubleClick(x, y, button = 1, settleMs = 200) {
        for (let i = 0; i < 2; i++) {
          raw().mouse(0, "click", button, x, y);
          await sleep(40);
          raw().mouse(0, "up", button, x, y);
          await sleep(60);
        }
        await sleep(settleMs);
      },
      /** Record a hash of a file the computer downloaded itself. */
      hash(path) {
        versions.push(`${path} sha256 ${sha(readFileSync(join(t.dir, path)))}`);
      },

      // ---- the computer ----

      /** Turn the computer on (all of them, when there are several). Files put before this are on its disk. */
      async boot() {
        if (session) throw new Error("already booted");
        await bootAll();
        return t;
      },
      /**
       * Wait for a reboot the program asked for (os.reboot, or an installer's "press a key to restart") to come back
       * up, and start the computer again if it shut itself down instead.
       */
      async rebooted(timeoutMs = 30000) {
        await sleep(500);
        if (!raw().running) session.handle.restart();
        await runner.waitForBoot(raw(), timeoutMs);
      },
      /** Hold Ctrl+R as a player does: the computer restarts with its files as they are. */
      async reboot() {
        if (raw().running) session.handle.sendCommand({ cmd: "reboot" });
        await sleep(800);
        if (!raw().running) session.handle.restart();
        await runner.waitForBoot(raw(), 30000);
      },
      get booted() {
        return session !== undefined;
      },
      get running() {
        return raw().running;
      },
      /** Type a line at the shell (or into any prompt) and press Enter. */
      async shell(line, settleMs = 300) {
        // a long line (an installer's address) is pasted, as players do; a short one is typed
        if (line.length > 30) raw().event("paste", line);
        else await typeText(raw(), line);
        raw().tap("enter");
        await sleep(settleMs);
      },
      /** Type text as a keyboard does: `key`, `char` and `key_up` for every character. */
      type: async (chars, settleMs = 150) => {
        await typeText(raw(), chars);
        await sleep(settleMs);
      },
      /** Tap a key by name (packages/rawterm/src/keys.ts): "enter", "up", "leftCtrl", ... */
      async key(name, settleMs = 150) {
        if (!(name in Keys)) throw new Error(`unknown key ${name}`);
        // a key that types something sends its character too, between the press and the release
        raw().key(name);
        if (CHAR_OF.has(name)) raw().char(CHAR_OF.get(name));
        raw().key(name, { up: true });
        await sleep(settleMs);
      },
      /** Hold one key while tapping another: Ctrl+S is `combo("leftCtrl", "s")`. */
      async combo(held, name, settleMs = 150) {
        raw().key(held);
        raw().tap(name);
        raw().key(held, { up: true });
        await sleep(settleMs);
      },
      /** Hold a key down for a while, repeating as a keyboard does. */
      async hold(name, ms) {
        const char = CHAR_OF.get(name);
        raw().key(name);
        if (char) raw().char(char);
        const end = Date.now() + ms;
        while (Date.now() < end) {
          await sleep(50);
          raw().key(name, { held: true });
          if (char) raw().char(char);
        }
        raw().key(name, { up: true });
        await sleep(100);
      },
      /** Click a terminal cell (1-based, as mouse_click reports). Button 1 left, 2 right, 3 middle. */
      async click(x, y, button = 1, settleMs = 200) {
        raw().mouse(0, "click", button, x, y);
        await sleep(40);
        raw().mouse(0, "up", button, x, y);
        await sleep(settleMs);
      },
      async drag(x1, y1, x2, y2, button = 1, settleMs = 200) {
        raw().mouse(0, "click", button, x1, y1);
        const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), 1);
        for (let i = 1; i <= steps; i++) {
          await sleep(20);
          raw().mouse(
            0,
            "drag",
            button,
            Math.round(x1 + ((x2 - x1) * i) / steps),
            Math.round(y1 + ((y2 - y1) * i) / steps),
          );
        }
        await sleep(20);
        raw().mouse(0, "up", button, x2, y2);
        await sleep(settleMs);
      },
      /** Scroll at a cell: direction 1 is down, -1 up. */
      async scroll(x, y, direction = 1, settleMs = 150) {
        raw().mouse(0, "scroll", direction > 0 ? 1 : 0, x, y);
        await sleep(settleMs);
      },
      /** Right-click a monitor cell. */
      async touch(monitor, x, y, settleMs = 200) {
        raw().touchMonitor(monitor, x, y);
        await sleep(settleMs);
      },
      /** Queue any event. */
      event: (name, ...params) => raw().event(name, ...params),
      sleep,

      // ---- looking ----

      text,
      lines,
      has: matches,
      /** Wait until the text (or pattern) is on the terminal or the named monitor. */
      async waitFor(what, timeoutMs = 15000, monitor) {
        const end = Date.now() + timeoutMs;
        for (;;) {
          if (matches(what, monitor)) return;
          if (Date.now() > end) {
            await t.shot("timeout");
            throw new CheckFailed(
              `waited ${timeoutMs} ms for ${what} on ${monitor ?? "the terminal"}; it shows:\n${text(monitor)}`,
            );
          }
          if (!raw().running)
            throw new CheckFailed(
              `the computer turned off while waiting for ${what}`,
            );
          await sleep(100);
        }
      },
      /** Wait for the shell prompt to be the last thing on screen. */
      async waitForPrompt(timeoutMs = 30000) {
        const end = Date.now() + timeoutMs;
        for (;;) {
          const ls = lines().filter((l) => l.trim() !== "");
          const last = ls[ls.length - 1] ?? "";
          // (what a graphics program left behind the prompt may be \x80, the teletext character with no pixel set)
          if (/^[^ ]*> ?$/.test(last.replace(/[\s\0\x80]+$/, ""))) return;
          if (Date.now() > end) {
            await t.shot("timeout");
            throw new CheckFailed(
              `waited ${timeoutMs} ms for the shell prompt (last line ${JSON.stringify(last)}); the terminal shows:\n${text()}`,
            );
          }
          await sleep(100);
        }
      },
      /** Wait until the screen stops changing for `quietMs`. */
      async settle(quietMs = 500, timeoutMs = 10000, monitor) {
        const end = Date.now() + timeoutMs;
        let last = text(monitor);
        let since = Date.now();
        while (Date.now() < end) {
          await sleep(50);
          const now = text(monitor);
          if (now !== last) {
            last = now;
            since = Date.now();
          } else if (Date.now() - since >= quietMs) return true;
        }
        return false;
      },
      expect(what, monitor) {
        if (!matches(what, monitor))
          throw new CheckFailed(
            `expected ${what} on ${monitor ?? "the terminal"}; it shows:\n${text(monitor)}`,
          );
      },
      /** Fail when a screen shows a Lua crash. `allow`: patterns that are fine for this program. */
      noCrash(monitor, allow = []) {
        const shown = text(monitor);
        for (const re of CRASH_PATTERNS) {
          const hit = re.exec(shown);
          if (hit && !allow.some((a) => a.test(shown)))
            throw new CheckFailed(
              `${monitor ?? "the terminal"} shows a crash (${hit[0]}):\n${shown}`,
            );
        }
      },
      /** True when anything but blanks is drawn: text, or any cell with a background that is not black. */
      drawn(monitor) {
        const frame = raw().windows.get(windowOf(monitor))?.frame;
        if (!frame) return false;
        if (text(monitor).trim() !== "") return true;
        const first = frame.colors?.[0];
        return frame.colors ? frame.colors.some((c) => c !== first) : false;
      },
      /** How many different (character, colour) cells are on screen: a cheap "is something really drawn" measure. */
      variety(monitor) {
        const frame = raw().windows.get(windowOf(monitor))?.frame;
        if (!frame) return 0;
        const seen = new Set();
        for (let i = 0; i < frame.width * frame.height; i++)
          seen.add(`${frame.text?.[i]}:${frame.colors?.[i]}`);
        return seen.size;
      },
      /** The simulated world as the computer last wrote it: chest contents, and what each speaker played. */
      state: () => readState(),
      /** What a speaker played so far: `total` calls and the last ones as { kind: "audio" | "sound" | "note", ... }. */
      speaker(name) {
        const p = readState()?.peripherals?.[name] ?? {};
        // CC's JSON writes an empty list as {}
        const sounds = Array.isArray(p.sounds) ? p.sounds : [];
        return { total: p.total ?? 0, sounds, raw: p };
      },
      /** Where a piece of text is on screen: the cell of its first character (1-based), or undefined. */
      find(what, monitor) {
        const rows = lines(monitor);
        for (let y = 0; y < rows.length; y++) {
          const x = rows[y].indexOf(what);
          if (x >= 0) return { x: x + 1, y: y + 1 };
        }
        return undefined;
      },
      /** The same, for the last place the text is (a button under a paragraph that names it). */
      findLast(what, monitor) {
        const rows = lines(monitor);
        for (let y = rows.length - 1; y >= 0; y--) {
          const x = rows[y].lastIndexOf(what);
          if (x >= 0) return { x: x + 1, y: y + 1 };
        }
        return undefined;
      },
      /**
       * Click the middle of a piece of text on the terminal (a button's label, say). `last`: the last place it is
       * on screen instead of the first.
       */
      async clickText(what, button = 1, last = false) {
        const at = last ? t.findLast(what) : t.find(what);
        if (!at)
          throw new CheckFailed(
            `no "${what}" to click; the terminal shows:\n${text()}`,
          );
        await t.click(at.x + Math.floor(what.length / 2), at.y, button);
      },
      /** One cell (1-based): its character code and colours as 0 (white) to 15 (black), the order of `colours`. */
      cell(x, y, monitor) {
        const frame = raw().windows.get(windowOf(monitor))?.frame;
        const i = (y - 1) * (frame?.width ?? 0) + (x - 1);
        const colour = frame?.colors?.[i] ?? 0;
        return {
          code: frame?.text?.[i] ?? 0,
          fg: colour & 15,
          bg: colour >> 4,
        };
      },
      /** A hash of what is on screen, to tell whether an animation moved. */
      frameHash(monitor) {
        const frame = raw().windows.get(windowOf(monitor))?.frame;
        if (!frame) return "";
        return createHash("sha1")
          .update(Buffer.from(frame.text ?? []))
          .update(Buffer.from(frame.colors ?? []))
          .update(JSON.stringify(frame.palette ?? []))
          .digest("hex");
      },
      /** Save PNGs of the terminal and every monitor as <name>.png / <name>-<monitor>.png. */
      async shot(name) {
        await sleep(60);
        const captures = runner.captureScreens(raw(), {
          png: true,
          scale: 2,
          resultsDir: session.handle.resultsDir,
        });
        for (const c of captures) {
          if (!c.png) continue;
          const file = join(
            shotsDir,
            `${shotPrefix}${name}${c.peripheral ? "-" + c.peripheral : ""}.png`,
          );
          writeFileSync(file, Buffer.from(c.png, "base64"));
          shots.push(file);
        }
        transcript += `--- ${shotPrefix}${name} ---\n${text()}\n`;
        for (const m of spec.monitors ?? [])
          transcript += `--- ${shotPrefix}${name} (${m.name}) ---\n${text(m.name)}\n`;
      },
      /**
       * Run Lua of our own from the shell and read what it wrote: the code is saved as a program, run, and its
       * `result(...)` calls come back as a list of lines. Stops the check if the program errors.
       */
      async lua(code, timeoutMs = 30000) {
        const name = `_compat_${Math.random().toString(36).slice(2, 8)}`;
        t.put(
          `${name}.lua`,
          `local __out = {}
local function result(...)
  local parts = table.pack(...)
  for i = 1, parts.n do parts[i] = tostring(parts[i]) end
  __out[#__out + 1] = table.concat(parts, "\\t", 1, parts.n)
end
local __ok, __err = xpcall(function(...)
${code}
end, function(e) return tostring(e) .. "\\n" .. debug.traceback() end, ...)
local __h = fs.open("${name}.out", "w")
__h.write((__ok and "ok\\n" or "error\\n" .. tostring(__err) .. "\\n") .. table.concat(__out, "\\n"))
__h.close()
`,
        );
        await t.shell(name);
        const end = Date.now() + timeoutMs;
        while (!t.exists(`${name}.out`) || t.read(`${name}.out`) === "") {
          if (Date.now() > end) {
            await t.shot("timeout");
            throw new CheckFailed(
              `our Lua did not finish in ${timeoutMs} ms; the terminal shows:\n${text()}`,
            );
          }
          await sleep(100);
        }
        await sleep(100);
        const out = t.read(`${name}.out`).split("\n");
        if (out[0] !== "ok")
          throw new CheckFailed(`Lua error: ${out.slice(1).join("\n")}`);
        return out.slice(1);
      },
      /** End whatever is in front with Ctrl+T (held a second, as in the game). */
      async terminate() {
        await runner.holdKey(session.handle, "t", { ms: 1200, ctrl: true });
        await sleep(300);
      },
      fail(message) {
        throw new CheckFailed(message);
      },
      /** What the engine wrote to stderr. */
      get stderr() {
        return session ? session.handle.stderr.join("").trim() : "";
      },
    };
    return t;
  }

  const started = Date.now();
  let error;
  try {
    await project.run(t);
  } catch (e) {
    error = e;
    for (const d of drivers)
      if (d.booted) await d.shot("failed").catch(() => {});
  }
  const stderr = drivers
    .map((d) => d.stderr)
    .filter(Boolean)
    .join("\n");
  for (const d of drivers)
    if (d.booted) transcript += `--- end ---\n${d.text()}\n`;
  await manager.destroyAll();
  for (const m of extraManagers) await m.destroyAll();
  writeFileSync(join(shotsDir, "transcript.txt"), transcript);
  return {
    id: project.id,
    ok: !error,
    expected: project.expect ?? "works",
    error: error ? String(error.message ?? error) : undefined,
    crashed: error && !(error instanceof CheckFailed),
    versions,
    notes,
    shots,
    stderr,
    ms: Date.now() - started,
  };
}
