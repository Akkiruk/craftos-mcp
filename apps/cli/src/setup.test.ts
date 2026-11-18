import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import * as versions from "@craftos-mcp/runner";

// scripts/setup.mjs is plain JavaScript outside this package: load it by URL so tsc does not follow it.
const setupUrl = pathToFileURL(
  join(import.meta.dirname, "..", "..", "..", "scripts", "setup.mjs"),
).href;
const setup = (await import(/* @vite-ignore */ setupUrl)) as {
  platformKey(platform: string, arch: string): string | undefined;
  readZip(buf: Buffer): Generator<{ name: string; data: Buffer; mode: number }>;
  extractZip(buf: Buffer, root: string, prefixes?: string[]): string[];
  romVersions(
    argv: string[],
    versions: { mc: string }[],
    env?: Record<string, string>,
  ): string[];
};

interface Entry {
  name: string;
  data: string;
  deflate?: boolean;
  /** Unix mode in the high half of the external attributes (zip made on Unix). */
  mode?: number;
}

/** A small zip writer: enough to test the reader without a zip tool. */
function makeZip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const raw = Buffer.from(e.data);
    const body = e.deflate ? deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(e.mode ? (3 << 8) | 20 : 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(e.deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((e.mode ?? 0) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

const scratch = mkdtempSync(join(tmpdir(), "setup-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("setup: engine zip", () => {
  it("picks the release asset suffix by OS", () => {
    expect(setup.platformKey("win32", "x64")).toBe("windows-x64");
    expect(setup.platformKey("linux", "x64")).toBe("linux-x64");
    expect(setup.platformKey("darwin", "arm64")).toBe("macos-arm64");
    expect(setup.platformKey("darwin", "x64")).toBe("macos-x64");
    expect(setup.platformKey("linux", "arm64")).toBeUndefined();
  });

  it("reads stored and deflated entries and the Unix mode", () => {
    const zip = makeZip([
      { name: "a.txt", data: "stored" },
      {
        name: "b/c.txt",
        data: "deflated ".repeat(50),
        deflate: true,
        mode: 0o100755,
      },
    ]);
    const [a, b] = [...setup.readZip(zip)];
    expect(a!.data.toString()).toBe("stored");
    expect(a!.mode).toBe(0);
    expect(b!.data.toString()).toBe("deflated ".repeat(50));
    expect(b!.mode & 0o777).toBe(0o755);
  });

  it("unpacks only engine/build, accepting backslash names", () => {
    const root = join(scratch, "ok");
    const written = setup.extractZip(
      makeZip([
        { name: "engine/build/craftos.exe", data: "exe" },
        { name: "engine\\build\\lib.dll", data: "dll" },
        { name: "package.json", data: "{}" },
        { name: "rom-overlay/x.lua", data: "no" },
      ]),
      root,
    );
    expect(written.sort()).toEqual([
      "engine/build/craftos.exe",
      "engine/build/lib.dll",
    ]);
    expect(readFileSync(join(root, "engine", "build", "lib.dll"), "utf8")).toBe(
      "dll",
    );
    expect(existsSync(join(root, "package.json"))).toBe(false);
  });

  it("refuses a path that escapes the folder", () => {
    const root = join(scratch, "evil");
    expect(() =>
      setup.extractZip(
        makeZip([{ name: "engine/build/../../../evil.txt", data: "x" }]),
        root,
      ),
    ).toThrow(/unsafe path/);
    expect(existsSync(join(scratch, "evil.txt"))).toBe(false);
  });

  it("rejects something that is not a zip", () => {
    expect(() => [
      ...setup.readZip(Buffer.from("<html>not found</html>".repeat(5))),
    ]).toThrow(/not a zip/);
  });
});

describe("setup: ROM versions", () => {
  const versions = [{ mc: "1.18.2" }, { mc: "1.20.1" }, { mc: "1.21.1" }];
  it("builds 1.18.2 by default, others with --mc or CRAFTOS_SETUP_MC", () => {
    expect(setup.romVersions([], versions, {})).toEqual(["1.18.2"]);
    expect(setup.romVersions(["--mc", "1.20.1,1.21.1"], versions, {})).toEqual([
      "1.20.1",
      "1.21.1",
    ]);
    expect(setup.romVersions(["--mc", "all"], versions, {})).toEqual([
      "1.18.2",
      "1.20.1",
      "1.21.1",
    ]);
    expect(
      setup.romVersions([], versions, { CRAFTOS_SETUP_MC: "1.21.1" }),
    ).toEqual(["1.21.1"]);
  });

  it("refuses an unknown version", () => {
    expect(() => setup.romVersions(["--mc", "1.12.2"], versions, {})).toThrow(
      /known: 1\.18\.2, 1\.20\.1, 1\.21\.1/,
    );
  });
});

// scripts/npm/first-run.mjs: the npm package's first run, offline and failing
const firstRun = (await import(
  /* @vite-ignore */ pathToFileURL(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "scripts",
      "npm",
      "first-run.mjs",
    ),
  ).href
)) as {
  setUp(o: {
    env?: Record<string, string>;
    version?: string;
    all?: boolean;
    verbose?: boolean;
  }): Promise<{ ok: boolean; error?: string; offline?: boolean }>;
  romPlan(
    env: Record<string, string>,
    all?: boolean,
  ): Map<string, { mc: string }>;
  versionInUse(env: Record<string, string>): string;
  readChecksum(text: string): string | undefined;
  buildRomOnDemand(
    romDir: string,
    wanted: { mc: string; cc: string; romDir: string },
    o?: { env?: Record<string, string>; version?: string },
  ): Promise<void>;
  setupGate(
    run: () => Promise<{ ok: boolean; error?: string; offline?: boolean }>,
    o?: { retryMs?: number },
  ): {
    ready: boolean;
    wait(): Promise<{ ok: boolean }>;
    note(): string;
  };
  causeOf(error: unknown): string;
};

describe("first run: offline", () => {
  it("says which host it could not reach and why, and that it is the network", async () => {
    const home = mkdtempSync(join(scratch, "home-"));
    // a port that was free a moment ago: nothing listens, so it is refused at once, like a machine with no network
    const { createServer } = await import("node:net");
    const port = await new Promise<number>((done) => {
      const s = createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => done(p));
      });
    });
    const result = await firstRun.setUp({
      version: "9.9.9",
      env: {
        CRAFTOS_HOME: home,
        CRAFTOS_ENGINE_URL: `http://127.0.0.1:${port}/craftos-mcp-v9.9.9-windows-x64.zip`,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.offline).toBe(true);
    expect(result.error).toBe(
      `could not reach 127.0.0.1:${port}: ECONNREFUSED 127.0.0.1:${port}`,
    );
    // the lock is gone, so the next try can start
    expect(existsSync(join(home, "9.9.9", "setup.lock"))).toBe(false);
  });

  it("a new version that set up prunes the old ones, keeping the newest before it", async () => {
    const home = mkdtempSync(join(scratch, "home-"));
    for (const v of ["0.1.0", "0.2.0", "0.3.0"])
      mkdirSync(join(home, v, "engine", "build"), { recursive: true });
    const exe = process.platform === "win32" ? "craftos.exe" : "craftos";
    const zip = join(scratch, "engine.zip");
    writeFileSync(
      zip,
      makeZip([{ name: `engine/build/${exe}`, data: "not really an engine" }]),
    );
    const rom = mkdtempSync(join(scratch, "rom-"));
    const result = await firstRun.setUp({
      version: "0.4.0",
      env: { CRAFTOS_HOME: home, CRAFTOS_ENGINE_URL: zip, CRAFTOS_ROM: rom },
    });
    expect(result).toEqual({ ok: true });
    expect(existsSync(join(home, "0.4.0", "engine", "build", exe))).toBe(true);
    expect(existsSync(join(home, "0.3.0"))).toBe(true);
    expect(existsSync(join(home, "0.2.0"))).toBe(false);
    expect(existsSync(join(home, "0.1.0"))).toBe(false);
    // CRAFTOS_KEEP_OLD=1 keeps them
    mkdirSync(join(home, "0.0.1"));
    rmSync(join(home, "0.4.0", "engine"), { recursive: true });
    await firstRun.setUp({
      version: "0.4.0",
      env: {
        CRAFTOS_HOME: home,
        CRAFTOS_ENGINE_URL: zip,
        CRAFTOS_ROM: rom,
        CRAFTOS_KEEP_OLD: "1",
      },
    });
    expect(existsSync(join(home, "0.0.1"))).toBe(true);
  });

  it("says what it does in a few short lines, with paths only under --verbose", async () => {
    const exe = process.platform === "win32" ? "craftos.exe" : "craftos";
    const zip = join(scratch, "engine-quiet.zip");
    writeFileSync(zip, makeZip([{ name: `engine/build/${exe}`, data: "x" }]));
    const rom = mkdtempSync(join(scratch, "rom-"));
    const lines = async (verbose: boolean) => {
      const home = mkdtempSync(join(scratch, "home-"));
      const out: string[] = [];
      const write = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string | Uint8Array) => {
        out.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      try {
        const result = await firstRun.setUp({
          version: "0.4.0",
          verbose,
          env: {
            CRAFTOS_HOME: home,
            CRAFTOS_ENGINE_URL: zip,
            CRAFTOS_ROM: rom,
          },
        });
        expect(result).toEqual({ ok: true });
      } finally {
        process.stderr.write = write;
      }
      return { text: out.join(""), home };
    };
    const quiet = await lines(false);
    expect(quiet.text).toMatch(
      /^craftos-mcp: setting up 0\.4\.0 \(once; about a minute\)\n/,
    );
    expect(quiet.text).toMatch(/craftos-mcp: ready \(\d+ s\)\n$/);
    expect(quiet.text).not.toContain(quiet.home);
    expect(quiet.text).not.toContain(".part");
    expect(quiet.text.trim().split("\n").length).toBeLessThanOrEqual(4);
    const loud = await lines(true);
    expect(loud.text).toContain(loud.home);
  });

  it("names the innermost cause of a fetch failure", () => {
    const inner = Object.assign(new Error("getaddrinfo ENOTFOUND github.com"), {
      code: "ENOTFOUND",
      hostname: "github.com",
    });
    expect(
      firstRun.causeOf(new TypeError("fetch failed", { cause: inner })),
    ).toBe("ENOTFOUND github.com");
  });

  it("the MCP server's gate tries a failed setup again on a later call", async () => {
    let calls = 0;
    const gate = firstRun.setupGate(
      async () =>
        ++calls === 1
          ? {
              ok: false,
              error: "could not reach github.com: ENOTFOUND",
              offline: true,
            }
          : { ok: true },
      { retryMs: 0 },
    );
    expect(gate.note()).toMatch(/still downloading/);
    expect((await gate.wait()).ok).toBe(false);
    expect(gate.note()).toMatch(
      /failed: could not reach github\.com.*HTTPS_PROXY.*tries again/,
    );
    // the network is back: the next call sets up, no restart needed
    expect((await gate.wait()).ok).toBe(true);
    expect(gate.ready).toBe(true);
    expect(calls).toBe(2);
  });

  it("does not hammer: a failure is tried again only after retryMs", async () => {
    let calls = 0;
    const gate = firstRun.setupGate(
      async () => (calls++, { ok: false, error: "x" }),
      { retryMs: 60_000 },
    );
    await gate.wait();
    await gate.wait();
    expect(calls).toBe(1);
    expect(gate.note()).toMatch(/after \d+ s/);
  });
});

describe("first run: only the ROM in use", () => {
  const romOf = (mc: string) => versions.versionInfo(mc)!.romDir;

  it("plans the ROM of CRAFTOS_VERSION, else the default, and every one with all", () => {
    expect([...firstRun.romPlan({}).keys()]).toEqual([
      romOf(versions.DEFAULT_MC),
    ]);
    expect([...firstRun.romPlan({ CRAFTOS_VERSION: "1.21.1" }).keys()]).toEqual(
      [romOf("1.21.1")],
    );
    expect(firstRun.versionInUse({ CRAFTOS_VERSION: "1.20.1" })).toBe("1.20.1");
    // an invalid CRAFTOS_VERSION: the default, as runs fall back to
    expect(firstRun.versionInUse({ CRAFTOS_VERSION: "9.9" })).toBe(
      versions.DEFAULT_MC,
    );
    const all = [
      ...firstRun.romPlan({ CRAFTOS_VERSION: "1.21.1" }, true).keys(),
    ];
    expect(all[0]).toBe(romOf("1.21.1"));
    expect(new Set(all)).toEqual(
      new Set(versions.VERSIONS.map((v) => v.romDir)),
    );
  });

  it("builds on demand only in the folders it manages, and not a ROM that is there", async () => {
    const home = mkdtempSync(join(scratch, "home-"));
    const env = { CRAFTOS_HOME: home };
    const wanted = versions.resolveVersion("1.21.1");
    // somebody else's ROM folder (CRAFTOS_ROM, a clone): left alone, nothing downloaded
    await firstRun.buildRomOnDemand(join(scratch, "elsewhere"), wanted, {
      env,
      version: "9.9.9",
    });
    // a ROM already built: nothing to do
    const rom = join(home, "9.9.9", "rom", wanted.romDir);
    const fonts = join(rom, "rom", "ccsim", "addons", "toms-peripherals");
    mkdirSync(fonts, { recursive: true });
    writeFileSync(join(rom, "bios.lua"), "");
    writeFileSync(join(fonts, "fonts.lua"), "");
    await firstRun.buildRomOnDemand(rom, wanted, { env, version: "9.9.9" });
    expect(existsSync(join(home, "9.9.9", "setup.lock"))).toBe(false);
    expect(existsSync(join(home, "jars"))).toBe(false);
    // not an installed package: nothing
    await firstRun.buildRomOnDemand(rom, wanted, { env, version: "" });
  });
});

describe("first run: the engine zip's SHA-256", () => {
  const exe = process.platform === "win32" ? "craftos.exe" : "craftos";
  const zip = makeZip([{ name: `engine/build/${exe}`, data: "engine" }]);
  const good = createHash("sha256").update(zip).digest("hex");

  /** A release server: the zip, and the .sha256 lines in turn (the last one repeats; null: 404). */
  async function release(sums: (string | null)[]) {
    let zips = 0;
    let n = 0;
    const server = createServer((req, res) => {
      if (req.url === "/e.zip") {
        zips++;
        res.end(zip);
      } else if (req.url === "/e.zip.sha256") {
        const sum = sums[Math.min(n++, sums.length - 1)];
        if (sum === null) res.writeHead(404).end();
        else res.end(`${sum}  e.zip\n`);
      } else res.writeHead(404).end();
    });
    const port = await new Promise<number>((done) =>
      server.listen(0, "127.0.0.1", () =>
        done((server.address() as { port: number }).port),
      ),
    );
    return {
      url: `http://127.0.0.1:${port}/e.zip`,
      zips: () => zips,
      close: () => server.close(),
    };
  }

  async function setUpFrom(url: string) {
    const home = mkdtempSync(join(scratch, "home-"));
    const result = await firstRun.setUp({
      version: "9.9.9",
      // CRAFTOS_ROM: no ROM to build, only the engine
      env: {
        CRAFTOS_HOME: home,
        CRAFTOS_ENGINE_URL: url,
        CRAFTOS_ROM: scratch,
      },
    });
    return { result, exe: join(home, "9.9.9", "engine", "build", exe) };
  }

  it("reads sha256sum's line", () => {
    expect(
      firstRun.readChecksum(`${good}  craftos-mcp-v1-linux-x64.zip\n`),
    ).toBe(good);
    expect(firstRun.readChecksum(`${good.toUpperCase()} *x.zip`)).toBe(good);
    expect(firstRun.readChecksum("<html>")).toBeUndefined();
  });

  it("unpacks a zip that matches", async () => {
    const r = await release([good]);
    try {
      const { result, exe: file } = await setUpFrom(r.url);
      expect(result).toEqual({ ok: true });
      expect(readFileSync(file, "utf8")).toBe("engine");
      expect(r.zips()).toBe(1);
    } finally {
      r.close();
    }
  });

  it("downloads again once after a mismatch", async () => {
    const r = await release(["0".repeat(64), good]);
    try {
      const { result, exe: file } = await setUpFrom(r.url);
      expect(result.ok).toBe(true);
      expect(existsSync(file)).toBe(true);
      expect(r.zips()).toBe(2);
    } finally {
      r.close();
    }
  });

  it("fails clearly when it does not match twice, and unpacks nothing", async () => {
    const r = await release(["0".repeat(64)]);
    try {
      const { result, exe: file } = await setUpFrom(r.url);
      expect(result.ok).toBe(false);
      expect(result.offline).toBeUndefined();
      expect(result.error).toMatch(
        /does not match its published SHA-256, twice \(expected 0{64}, got [0-9a-f]{64}\)/,
      );
      expect(existsSync(file)).toBe(false);
      expect(r.zips()).toBe(2);
    } finally {
      r.close();
    }
  });

  it("takes a release from before the checksums as it is", async () => {
    const r = await release([null]);
    try {
      const { result } = await setUpFrom(r.url);
      expect(result.ok).toBe(true);
    } finally {
      r.close();
    }
  });
});
