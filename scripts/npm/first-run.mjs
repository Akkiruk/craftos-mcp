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
import { DEFAULT_MC, VERSIONS } from "../../packages/runner/dist/versions.js";
import { buildRom, downloadJar } from "../build-rom.mjs";
import { buildTomsFonts } from "../build-toms-fonts.mjs";
import { extractZip, platformKey } from "../setup.mjs";

const WINDOWS = process.platform === "win32";
const RELEASE_REPO = process.env.CRAFTOS_RELEASE_REPO ?? "Akkiruk/craftos-mcp";
const FONTS = join("rom", "ccsim", "addons", "toms-peripherals", "fonts.lua");
const LOCK_STALE_MS = 30 * 60 * 1000;

const say = (line) => process.stderr.write(`craftos-mcp: ${line}\n`);

/**
 * The ROM folders to build (1.20.1 and 1.21.1 share one), each with the first pinned jar of its version: the default
 * version's first (DEFAULT_MC), so the ROM most runs use is there soonest.
 */
function romPlan() {
  const plan = new Map();
  const first = VERSIONS.find((v) => v.mc === DEFAULT_MC);
  for (const v of [...(first ? [first] : []), ...VERSIONS])
    if (!plan.has(v.romDir)) plan.set(v.romDir, { mc: v.mc, jar: v.jars[0] });
  return plan;
}

function paths(env = process.env, version) {
  const root = version ? join(craftosHome(env), version) : installRoot(env);
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
  return setUpAt(paths(env), env);
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

/**
 * fetch, with the reason a request never got an answer spelled out: Node's own error is just "fetch failed", with the
 * real one (ENOTFOUND, ECONNREFUSED, a proxy's certificate) in `cause`.
 */
export async function fetchOrSay(url, init) {
  try {
    return await fetch(url, init);
  } catch (error) {
    throw new Error(`could not reach ${hostOf(url)}: ${causeOf(error)}`, {
      cause: error,
    });
  }
}

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** The innermost reason of a network error: its code and what it names, else its message. */
export function causeOf(error) {
  let e = error;
  while (e?.cause && typeof e.cause === "object") e = e.cause;
  if (e?.errors?.length) e = e.errors[0]; // AggregateError: one per address tried
  const code = e?.code;
  const where = e?.hostname ?? (e?.address ? `${e.address}:${e.port}` : "");
  if (code) return [code, where].filter(Boolean).join(" ");
  return e?.message ?? String(e);
}

/** What to try when the network is the problem: said once, under the failure. */
export const OFFLINE_HINT =
  "No network, or a proxy? Set HTTPS_PROXY (craftos-mcp then sets NODE_USE_ENV_PROXY=1 for the download), or set up " +
  "offline: CRAFTOS_ENGINE_URL=<a downloaded engine zip> and the CC:Tweaked jars in <CRAFTOS_HOME>/jars. " +
  "Then run  npx craftos-mcp setup";

/** GET a URL into a Buffer, with progress on stderr for big files. Undefined on 404. */
async function download(url, what) {
  const res = await fetchOrSay(url, {
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
async function engineZip(key, version, env) {
  const override = env.CRAFTOS_ENGINE_URL;
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
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const res = await fetchOrSay(api, { headers });
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

async function getEngine(p, version, env) {
  const key = platformKey();
  if (!key && !env.CRAFTOS_ENGINE_URL)
    throw new Error(
      `there is no prebuilt engine for ${process.platform}/${process.arch}: build engine/ from ` +
        `https://github.com/${RELEASE_REPO} and point CRAFTOS_ENGINE at it`,
    );
  const zip = await engineZip(key, version, env);
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
    const jarPath = await downloadJar(jars, jar).catch((error) => {
      throw error.message === "fetch failed"
        ? new Error(`could not reach ${hostOf(jar.url)}: ${causeOf(error)}`, {
            cause: error,
          })
        : error;
    });
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

/**
 * Set up whatever is missing (everything with force). Resolves to { ok, error?, offline? }; never throws. `offline` is
 * set when the network was the problem (OFFLINE_HINT says what to do). `version` is for tests: a package version to
 * set up without being an installed package.
 */
export async function setUp({
  force = false,
  env = process.env,
  version = packageVersion(),
} = {}) {
  if (!version)
    return {
      ok: false,
      error: "not an installed package: in a clone, run  npm run setup",
    };
  // Node's fetch only uses HTTPS_PROXY with NODE_USE_ENV_PROXY=1, read at startup: set up in a child that has it
  if (proxied(env) && !env.NODE_USE_ENV_PROXY && !env.CRAFTOS_SETUP_CHILD)
    return setUpInChild({ force, env, version });
  const p = paths(env, version);
  const started = Date.now();
  let release = () => {};
  try {
    release = await takeLock(join(p.root, "setup.lock"));
    if (!force && setUpAt(p, env)) return { ok: true };
    say(`setting up ${version} in ${p.root} (once; about a minute)`);
    // build-rom and the fonts script report on stdout; keep that free for the MCP protocol
    const log = console.log;
    console.log = (...a) => say(`  ${a.join(" ")}`);
    try {
      if (force || (!env.CRAFTOS_ENGINE && !existsSync(p.engine)))
        await getEngine(p, version, env);
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
    const offline = /^could not reach /.test(error.message);
    say(`setup failed: ${error.message}`);
    if (offline) say(OFFLINE_HINT);
    return { ok: false, error: error.message, ...(offline && { offline }) };
  } finally {
    release();
  }
}

function setUpAt(p, env) {
  const engine = env.CRAFTOS_ENGINE ? true : existsSync(p.engine);
  const roms = env.CRAFTOS_ROM
    ? true
    : [...romPlan().keys()].every((dir) => romReady(p.rom(dir)));
  return engine && roms;
}

const proxied = (env) =>
  Boolean(
    env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy,
  );

/** setUp in a child Node that honours the proxy variables; progress goes to stderr as usual, the result on stdout. */
async function setUpInChild({ force, env, version }) {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  say("using the proxy in HTTPS_PROXY");
  return new Promise((done) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), ...(force ? ["--force"] : [])],
      {
        env: {
          ...env,
          NODE_USE_ENV_PROXY: "1",
          CRAFTOS_SETUP_CHILD: "1",
          CRAFTOS_SETUP_VERSION: version,
        },
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", (error) => done({ ok: false, error: error.message }));
    child.on("exit", () => {
      try {
        done(JSON.parse(out.trim().split("\n").pop()));
      } catch {
        done({ ok: false, error: "the setup process ended without a result" });
      }
    });
  });
}

/**
 * The MCP server's view of a setup running in the background: tools that need the engine `wait()` for it. After a
 * failure the next call tries again (at most once every `retryMs`), so fixing the network needs no restart.
 */
export function setupGate(run = () => setUp(), { retryMs = 10_000 } = {}) {
  let current;
  let result;
  let failedAt = 0;
  const start = () => {
    result = undefined;
    current = run().then((r) => {
      result = r;
      if (!r.ok) failedAt = Date.now();
      return r;
    });
    return current;
  };
  start();
  return {
    /** Done and ready. */
    get ready() {
      return result?.ok === true;
    },
    /** The setup's result, waiting for it; a failed one is tried again first when it is old enough. */
    async wait() {
      if (result && !result.ok && Date.now() - failedAt >= retryMs) start();
      return current;
    },
    /** A line for an agent: still going, or why it failed and what to do. */
    note() {
      if (!result)
        return "first-run setup is still downloading the engine and building the ROM (about a minute); tools that run computers wait for it";
      if (result.ok) return "";
      const again = Math.max(
        0,
        Math.ceil((retryMs - (Date.now() - failedAt)) / 1000),
      );
      return (
        `first-run setup failed: ${result.error}. ` +
        (result.offline ? `${OFFLINE_HINT}. ` : "") +
        `The next tool call ${again ? `after ${again} s ` : ""}tries again; ` +
        "npx craftos-mcp setup in a terminal shows every step"
      );
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = await setUp({
    force: process.argv.includes("--force"),
    ...(process.env.CRAFTOS_SETUP_VERSION && {
      version: process.env.CRAFTOS_SETUP_VERSION,
    }),
  });
  if (process.env.CRAFTOS_SETUP_CHILD)
    process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 1);
}
