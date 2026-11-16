// The npm package's first run: the engine, the ROMs and Tom's Peripherals' fonts, into the per-user folder.
//
// An installed package (scripts/pack-npm.mjs) carries no engine, no CC:Tweaked ROM and no fonts. This puts them in
// <home>/<version> (packages/runner/src/config.ts craftosHome: CRAFTOS_HOME, else %LOCALAPPDATA%\craftos-mcp or
// ~/.cache/craftos-mcp), the same way `npm run setup` does in a clone:
//   engine/build/  the prebuilt engine from the GitHub release v<version> (the latest release when that has none)
//   rom/cc-<cc>/   one ROM per CC:Tweaked version, built from the jar pinned on Modrinth (sha512 checked)
// The jars are cached in <home>/jars. Every step writes into a .part folder and renames it when done, so an
// interrupted run starts that step again. Progress goes to stderr: stdout is the MCP channel for `serve`.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  craftosHome,
  installRoot,
  packageVersion,
} from "../../packages/runner/dist/config.js";
import { VERSIONS } from "../../packages/runner/dist/versions.js";
import { buildRom, downloadJar } from "../build-rom.mjs";
import { buildTomsFonts } from "../build-toms-fonts.mjs";
import { extractZip, platformKey } from "../setup.mjs";

const WINDOWS = process.platform === "win32";
const RELEASE_REPO = process.env.CRAFTOS_RELEASE_REPO ?? "Akkiruk/craftos-mcp";
const FONTS = join("rom", "ccsim", "addons", "toms-peripherals", "fonts.lua");
const LOCK_STALE_MS = 30 * 60 * 1000;

const say = (line) => process.stderr.write(`craftos-mcp: ${line}\n`);

/** The ROM folders to build (1.20.1 and 1.21.1 share one), each with the first pinned jar of its version. */
function romPlan() {
  const plan = new Map();
  for (const v of VERSIONS)
    if (!plan.has(v.romDir)) plan.set(v.romDir, { mc: v.mc, jar: v.jars[0] });
  return plan;
}

function paths(env = process.env) {
  const root = installRoot(env);
  return {
    root,
    home: craftosHome(env),
    engine: join(root, "engine", "build", WINDOWS ? "craftos.exe" : "craftos"),
    rom: (dir) => join(root, "rom", dir),
  };
}

const romReady = (dir) =>
  existsSync(join(dir, "bios.lua")) && existsSync(join(dir, FONTS));

/** Whether the engine and every ROM are in place (CRAFTOS_ENGINE / CRAFTOS_ROM count as in place). */
export function isSetUp(env = process.env) {
  const p = paths(env);
  const engine = env.CRAFTOS_ENGINE ? true : existsSync(p.engine);
  const roms = env.CRAFTOS_ROM
    ? true
    : [...romPlan().keys()].every((dir) => romReady(p.rom(dir)));
  return engine && roms;
}

/** One setup at a time per install folder, across processes (an MCP server and a CLI command, say). */
async function takeLock(lock) {
  mkdirSync(dirname(lock), { recursive: true });
  let told = false;
  for (;;) {
    try {
      writeFileSync(lock, `${process.pid} ${Date.now()}`, { flag: "wx" });
      return () => rmSync(lock, { force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let pid = 0;
      let started = 0;
      try {
        [pid, started] = readFileSync(lock, "utf8").split(" ").map(Number);
      } catch {}
      // a setup that was killed (an MCP client giving up) leaves its lock behind
      let alive = true; // a lock still being written has no pid yet
      if (pid > 0) {
        try {
          process.kill(pid, 0);
        } catch (e) {
          alive = e.code === "EPERM";
        }
      }
      if (!alive || Date.now() - (started || Date.now()) > LOCK_STALE_MS) {
        rmSync(lock, { force: true });
        continue;
      }
      if (!told) say("another craftos-mcp is setting up; waiting for it");
      told = true;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/** GET a URL into a Buffer, with progress on stderr for big files. Undefined on 404. */
async function download(url, what) {
  const res = await fetch(url, {
    headers: { "User-Agent": "craftos-mcp-first-run" },
  });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const chunks = [];
  let got = 0;
  let shown = 0;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    got += chunk.length;
    if (total && got / total >= shown + 0.25) {
      shown = Math.floor((got / total) * 4) / 4;
      say(`  ${what}: ${Math.round(shown * 100)}% of ${mb(total)}`);
    }
  }
  return Buffer.concat(chunks);
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** The engine zip for this OS: the release matching this package's version, else the latest one. */
async function engineZip(key, version) {
  const override = process.env.CRAFTOS_ENGINE_URL;
  if (override) {
    say(`engine from ${override}`);
    return existsSync(override)
      ? readFileSync(override)
      : download(override, "engine");
  }
  const tag = `v${version}`;
  const direct = `https://github.com/${RELEASE_REPO}/releases/download/${tag}/craftos-mcp-${tag}-${key}.zip`;
  say(`engine: release ${tag} (${key})`);
  const zip = await download(direct, "engine");
  if (zip) return zip;
  const api = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;
  const headers = {
    "User-Agent": "craftos-mcp-first-run",
    Accept: "application/vnd.github+json",
  };
  if (process.env.GITHUB_TOKEN)
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(api, { headers });
  if (!res.ok)
    throw new Error(`no release ${tag}, and ${api}: HTTP ${res.status}`);
  const latest = await res.json();
  const asset = (latest.assets ?? []).find(
    (a) => a.name.startsWith("craftos-mcp-") && a.name.endsWith(`-${key}.zip`),
  );
  if (!asset)
    throw new Error(`release ${latest.tag_name} has no ${key} engine`);
  say(`engine: no release ${tag} yet; using the latest, ${latest.tag_name}`);
  return download(asset.browser_download_url, "engine");
}

async function getEngine(p, version) {
  const key = platformKey();
  if (!key && !process.env.CRAFTOS_ENGINE_URL)
    throw new Error(
      `there is no prebuilt engine for ${process.platform}/${process.arch}: build engine/ from ` +
        `https://github.com/${RELEASE_REPO} and point CRAFTOS_ENGINE at it`,
    );
  const zip = await engineZip(key, version);
  if (!zip) throw new Error("the engine download came back empty");
  const part = join(p.root, "engine.part");
  rmSync(part, { recursive: true, force: true });
  const files = extractZip(zip, part, ["engine/build/"]);
  const exe = join(
    part,
    "engine",
    "build",
    WINDOWS ? "craftos.exe" : "craftos",
  );
  if (!existsSync(exe))
    throw new Error(`the engine zip has no engine/build for this OS`);
  rmSync(join(p.root, "engine"), { recursive: true, force: true });
  renameSync(join(part, "engine"), join(p.root, "engine"));
  rmSync(part, { recursive: true, force: true });
  say(`engine: ${files.length} files in ${dirname(p.engine)}`);
}

async function getRoms(p) {
  const jars = join(p.home, "jars");
  let fonts;
  for (const [dir, { mc, jar }] of romPlan()) {
    const out = p.rom(dir);
    if (romReady(out)) continue;
    say(`ROM ${dir} (Minecraft ${mc}) from ${jar.file}`);
    const jarPath = await downloadJar(jars, jar);
    const part = `${out}.part`;
    buildRom(jarPath, part);
    if (!existsSync(join(part, FONTS))) {
      fonts ??= await buildTomsFonts({
        out: join(p.root, "toms-fonts.lua"),
        cacheDir: jars,
      });
      mkdirSync(dirname(join(part, FONTS)), { recursive: true });
      cpSync(fonts, join(part, FONTS));
    }
    rmSync(out, { recursive: true, force: true });
    renameSync(part, out);
  }
  if (fonts) rmSync(fonts, { force: true });
}

/** Set up whatever is missing (everything with force). Resolves to { ok, error? }; never throws. */
export async function setUp({ force = false, env = process.env } = {}) {
  const version = packageVersion();
  if (!version)
    return {
      ok: false,
      error: "not an installed package: in a clone, run  npm run setup",
    };
  const p = paths(env);
  const started = Date.now();
  let release = () => {};
  try {
    release = await takeLock(join(p.root, "setup.lock"));
    if (!force && isSetUp(env)) return { ok: true };
    say(`setting up ${version} in ${p.root} (once; about a minute)`);
    // build-rom and the fonts script report on stdout; keep that free for the MCP protocol
    const log = console.log;
    console.log = (...a) => say(`  ${a.join(" ")}`);
    try {
      if (force || (!env.CRAFTOS_ENGINE && !existsSync(p.engine)))
        await getEngine(p, version);
      if (force)
        for (const dir of romPlan().keys())
          rmSync(p.rom(dir), { recursive: true, force: true });
      if (!env.CRAFTOS_ROM) await getRoms(p);
    } finally {
      console.log = log;
    }
    say(`ready (${((Date.now() - started) / 1000).toFixed(0)} s)`);
    return { ok: true };
  } catch (error) {
    say(`setup failed: ${error.message}`);
    return { ok: false, error: error.message };
  } finally {
    release();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = await setUp({ force: process.argv.includes("--force") });
  process.exit(result.ok ? 0 : 1);
}
