import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";

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
  }): Promise<{ ok: boolean; error?: string; offline?: boolean }>;
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
