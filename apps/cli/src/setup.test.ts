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
    expect(setup.platformKey("darwin", "arm64")).toBeUndefined();
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
