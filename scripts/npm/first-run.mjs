// The npm package's first run: the engine, the ROMs and Tom's Peripherals' fonts, into the per-user folder.
//
// An installed package (scripts/pack-npm.mjs) carries no engine, no CC:Tweaked ROM and no fonts. This puts them in
// <home>/<version> (packages/runner/src/config.ts craftosHome: CRAFTOS_HOME, else %LOCALAPPDATA%\craftos-mcp or
// ~/.cache/craftos-mcp), the same way `npm run setup` does in a clone:
//   engine/build/  the prebuilt engine from the GitHub release v<version> (the latest release when that has none)
//   rom/cc-<cc>/   the ROM of the version in use (CRAFTOS_VERSION, else the default), built from the jar pinned on
//                  Modrinth (sha512 checked). Another version's ROM is built the first time a world asks for it
//                  (buildRomOnDemand, which scripts/npm/craftos-mcp.mjs hands the runner), or all at once by setup --all.
// The engine zip is checked against the SHA-256 its release publishes beside it (<zip>.sha256) before it is unpacked.
// The jars are cached in <home>/jars. Every step writes into a .part folder and renames it when done, so an
// interrupted run starts that step again. Progress goes to stderr: stdout is the MCP channel for `serve`. It is a few
// short lines (what it gets, how big, when it is ready); --verbose (setup --verbose, or CRAFTOS_VERBOSE=1) adds every
// step with its paths.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  craftosHome,
  installRoot,
  packageVersion,
} from "../../packages/runner/dist/config.js";
import {
  DEFAULT_MC,
  VERSIONS,
  resolveVersion,
} from "../../packages/runner/dist/versions.js";
import { buildRom, downloadJar } from "../build-rom.mjs";
import { buildTomsFonts } from "../build-toms-fonts.mjs";
import { extractZip, platformKey } from "../setup.mjs";

const WINDOWS = process.platform === "win32";
const RELEASE_REPO = process.env.CRAFTOS_RELEASE_REPO ?? "Akkiruk/craftos-mcp";
const FONTS = join("rom", "ccsim", "addons", "toms-peripherals", "fonts.lua");
const LOCK_STALE_MS = 30 * 60 * 1000;

const say = (line) => process.stderr.write(`craftos-mcp: ${line}\n`);
let verbose = Boolean(process.env.CRAFTOS_VERBOSE);
/** A step's details and paths: only with --verbose. */
const detail = (line) => verbose && say(line);
/** A line a later one replaces, on a terminal (progress); elsewhere (a log, VS Code reading it) each line stays. */
let overwriting = false;
const sayOver = (line) => {
  if (verbose || !process.stderr.isTTY) return say(line);
  process.stderr.write(`\rcraftos-mcp: ${line}\x1b[K`);
  overwriting = true;
};
/** End a line sayOver left open. */
const endOver = () => {
  if (overwriting) process.stderr.write("\n");
  overwriting = false;
};

/** The Minecraft version runs use when a world names none: CRAFTOS_VERSION, else DEFAULT_MC (also when it is invalid). */
export function versionInUse(env = process.env) {
  try {
    return resolveVersion(undefined, env).mc;
  } catch {
    return DEFAULT_MC;
  }
}

/**
 * The ROM folders to build (1.20.1 and 1.21.1 share one), each with the first pinned jar of its version: only the
 * version in use's (versionInUse), or with `all` every one, the one in use first.
 */
export function romPlan(env = process.env, all = false) {
  const plan = new Map();
  const first = VERSIONS.find((v) => v.mc === versionInUse(env));
  for (const v of [...(first ? [first] : []), ...(all ? VERSIONS : [])])
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
  const big = total > 1024 * 1024;
  if (big) sayOver(`${what}: downloading ${mb(total)}`);
  for await (const chunk of res.body) {
    chunks.push(chunk);
    got += chunk.length;
    if (big && got / total >= shown + 0.25) {
      shown = Math.floor((got / total) * 4) / 4;
      sayOver(`${what}: ${Math.round(shown * 100)}% of ${mb(total)}`);
    }
  }
  if (big) endOver();
  return Buffer.concat(chunks);
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** The hash in a .sha256 file (`<hex>  <name>`, as sha256sum writes it), or undefined when it holds none. */
export function readChecksum(text) {
  return /\b([0-9a-f]{64})\b/i.exec(String(text))?.[1]?.toLowerCase();
}

/**
 * Download an engine zip and check it against the SHA-256 published beside it (<url>.sha256). A mismatch (a broken
 * download, a proxy that rewrote it) is downloaded again once, then fails saying so. A release from before the
 * checksums (no .sha256: 404) is taken as it is, with a line saying it went unchecked.
 */
export async function verifiedEngine(url, what = "engine") {
  for (let attempt = 1; ; attempt++) {
    const zip = await download(url, what);
    if (!zip) return undefined;
    const sum = await download(`${url}.sha256`, `${what} checksum`);
    if (!sum) {
      say(`${what}: no checksum published beside ${url}; not verified`);
      return zip;
    }
    const want = readChecksum(sum);
    if (!want) throw new Error(`${url}.sha256 holds no SHA-256`);
    const got = sha256(zip);
    if (got === want) {
      detail(`${what}: SHA-256 verified`);
      return zip;
    }
    if (attempt >= 2)
      throw new Error(
        `the engine zip from ${url} does not match its published SHA-256, twice (expected ${want}, got ${got}): ` +
          "a broken download or a proxy that changes files. Try again later, or download it yourself and set CRAFTOS_ENGINE_URL to the file",
      );
    say(
      `${what}: the download does not match its SHA-256; downloading it again`,
    );
  }
}

/** The engine zip for this OS: the release matching this package's version, else the latest one. */
async function engineZip(key, version, env) {
  const override = env.CRAFTOS_ENGINE_URL;
  if (override) {
    detail(`engine from ${override}`);
    if (existsSync(override)) return readFileSync(override);
    // a path to a zip that is not there is not a network problem (C:\... would read as a URL scheme)
    if (!/^https?:\/\//i.test(override))
      throw new Error(
        `CRAFTOS_ENGINE_URL is ${override}, which is not a file here and not an http(s) address`,
      );
    return verifiedEngine(override);
  }
  const tag = `v${version}`;
  const direct = `https://github.com/${RELEASE_REPO}/releases/download/${tag}/craftos-mcp-${tag}-${key}.zip`;
  detail(`engine: release ${tag} (${key})`);
  const zip = await verifiedEngine(direct);
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
  return verifiedEngine(asset.browser_download_url);
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
  detail(`engine: ${files.length} files in ${dirname(p.engine)}`);
}

async function getRoms(p, plan) {
  const jars = join(p.home, "jars");
  let fonts;
  for (const [dir, { mc, jar }] of plan) {
    const out = p.rom(dir);
    if (romReady(out)) continue;
    const cc = VERSIONS.find((v) => v.mc === mc)?.cc ?? dir.replace(/^cc-/, "");
    say(`ROM: building the CC:Tweaked ${cc} ROM (Minecraft ${mc})`);
    detail(`  from ${jar.file} into ${out}`);
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
 * Set up whatever is missing (everything with force): the engine and the ROM of the version in use, or with `all`
 * every version's ROM. Resolves to { ok, error?, offline? }; never throws. `offline` is set when the network was the
 * problem (OFFLINE_HINT says what to do). `version` is for tests: a package version to set up without being an
 * installed package.
 */
export async function setUp({
  force = false,
  all = false,
  env = process.env,
  version = packageVersion(),
  verbose: loud = Boolean(env.CRAFTOS_VERBOSE),
} = {}) {
  verbose = loud;
  if (!version)
    return {
      ok: false,
      error: "not an installed package: in a clone, run  npm run setup",
    };
  // Node's fetch only uses HTTPS_PROXY with NODE_USE_ENV_PROXY=1, read at startup: set up in a child that has it
  if (proxied(env) && !env.NODE_USE_ENV_PROXY && !env.CRAFTOS_SETUP_CHILD)
    return setUpInChild({ force, all, env, version, verbose: loud });
  const p = paths(env, version);
  const started = Date.now();
  let release = () => {};
  try {
    release = await takeLock(join(p.root, "setup.lock"));
    const plan = romPlan(env, all);
    if (!force && setUpAt(p, env, plan)) return { ok: true };
    say(`setting up ${version} (once; about a minute)`);
    detail(`  into ${p.root}`);
    // build-rom and the fonts script report on stdout; keep that free for the MCP protocol (and only for --verbose)
    const log = console.log;
    console.log = (...a) => detail(`  ${a.join(" ")}`);
    try {
      if (force || (!env.CRAFTOS_ENGINE && !existsSync(p.engine)))
        await getEngine(p, version, env);
      if (force)
        for (const dir of plan.keys())
          rmSync(p.rom(dir), { recursive: true, force: true });
      if (!env.CRAFTOS_ROM) await getRoms(p, plan);
    } finally {
      console.log = log;
    }
    say(`ready (${((Date.now() - started) / 1000).toFixed(0)} s)`);
    await pruneOld(p.home, version, env);
    return { ok: true };
  } catch (error) {
    endOver();
    const offline = /^could not reach /.test(error.message);
    say(`setup failed: ${error.message}`);
    if (offline) say(OFFLINE_HINT);
    return { ok: false, error: error.message, ...(offline && { offline }) };
  } finally {
    release();
  }
}

/**
 * After a new version set up: the cache keeps it and the newest version before it, and the older ones go
 * (packages/runner/src/cache.ts). Never fails the setup; CRAFTOS_KEEP_OLD=1 keeps everything.
 */
async function pruneOld(home, version, env) {
  if (env.CRAFTOS_KEEP_OLD) return;
  try {
    const { megabytes, pruneCache } = await import(
      "../../packages/runner/dist/cache.js"
    );
    const { removed, failed } = pruneCache(home, version);
    if (removed.length)
      say(
        `removed old versions ${removed.map((v) => v.version).join(", ")} (${megabytes(removed.reduce((n, v) => n + v.bytes, 0))})`,
      );
    for (const f of failed)
      say(`could not remove old version ${f.version}: ${f.error}`);
  } catch (error) {
    say(`could not prune old versions: ${error.message}`);
  }
}

function setUpAt(p, env, plan = romPlan(env)) {
  const engine = env.CRAFTOS_ENGINE ? true : existsSync(p.engine);
  const roms = env.CRAFTOS_ROM
    ? true
    : [...plan.keys()].every((dir) => romReady(p.rom(dir)));
  return engine && roms;
}

/**
 * The runner's RomBuilder (packages/runner/src/versions.ts ensureRom): build the ROM a world's version needs, once,
 * the first time a world asks for it, with one line saying so. Throws when it cannot (the runner's caller reports it).
 * `version` is for tests, as in setUp.
 */
export async function buildRomOnDemand(
  romDir,
  wanted,
  { env = process.env, version = packageVersion() } = {},
) {
  if (!version) return;
  const p = paths(env, version);
  const info =
    VERSIONS.find((v) => v.mc === wanted.mc && v.romDir === wanted.romDir) ??
    VERSIONS.find((v) => v.romDir === wanted.romDir);
  // a ROM folder this setup does not manage (not <install>/rom/<dir>) is left to whoever made it
  if (!info || resolve(romDir) !== resolve(p.rom(wanted.romDir))) return;
  const release = await takeLock(join(p.root, "setup.lock"));
  const log = console.log;
  console.log = (...a) => detail(`  ${a.join(" ")}`);
  try {
    if (romReady(romDir)) return;
    say(
      `building the ROM for Minecraft ${wanted.mc} (CC:Tweaked ${wanted.cc}): a world asked for it; once, about 20 s`,
    );
    await getRoms(
      p,
      new Map([[info.romDir, { mc: info.mc, jar: info.jars[0] }]]),
    );
  } catch (error) {
    throw new Error(
      `could not build the ROM for Minecraft ${wanted.mc}: ${error.message}`,
      { cause: error },
    );
  } finally {
    console.log = log;
    release();
  }
}

const proxied = (env) =>
  Boolean(
    env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy,
  );

/** setUp in a child Node that honours the proxy variables; progress goes to stderr as usual, the result on stdout. */
async function setUpInChild({ force, all, env, version, verbose: loud }) {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  say("using the proxy in HTTPS_PROXY");
  return new Promise((done) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(import.meta.url),
        ...(force ? ["--force"] : []),
        ...(all ? ["--all"] : []),
      ],
      {
        env: {
          ...env,
          NODE_USE_ENV_PROXY: "1",
          CRAFTOS_SETUP_CHILD: "1",
          CRAFTOS_SETUP_VERSION: version,
          ...(loud && { CRAFTOS_VERBOSE: "1" }),
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
        "npx craftos-mcp setup --verbose in a terminal shows every step"
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
    all: process.argv.includes("--all"),
    verbose:
      process.argv.includes("--verbose") ||
      Boolean(process.env.CRAFTOS_VERBOSE),
    ...(process.env.CRAFTOS_SETUP_VERSION && {
      version: process.env.CRAFTOS_SETUP_VERSION,
    }),
  });
  if (process.env.CRAFTOS_SETUP_CHILD)
    process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 1);
}
