// The pinned craftos-mcp in the extension's storage: npm tarballs unpacked, checked against their integrity hashes,
// laid out as npm would, and started with node instead of npx.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { NPM_PACKAGE, directBase } from "../../src/launcher.ts";
import {
  extractTgz,
  installPinned,
  matchesIntegrity,
  pinnedBin,
  readTar,
} from "../../src/pinned.ts";
import { PINNED_LOCK } from "../../src/pinnedLock.ts";

/** A ustar header and its data, padded to 512 bytes. */
function entry(name, data, { type = "0", prefix = "" } = {}) {
  const body = Buffer.from(data);
  const h = Buffer.alloc(512);
  h.write(name, 0, 100);
  h.write("0000644\0", 100);
  h.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
  h.write(type, 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  if (prefix) h.write(prefix, 345, 155);
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([h, body, pad]);
}

const tgz = (...entries) =>
  gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));

const sri = (buf) =>
  `sha512-${createHash("sha512").update(buf).digest("base64")}`;

test("reads ustar names, a ustar prefix, pax paths and GNU long names", () => {
  const long = `package/${"d/".repeat(60)}deep.txt`;
  const pax = `${long.length + 6 + String(long.length).length} path=${long}\n`;
  const tar = Buffer.concat([
    entry("package/a.txt", "a"),
    entry("b.txt", "b", { prefix: "package/sub" }),
    entry("PaxHeader", pax, { type: "x" }),
    entry("package/truncated", "c"),
    entry("././@LongLink", "package/gnu-long.txt\0", { type: "L" }),
    entry("package/short", "d"),
    Buffer.alloc(1024),
  ]);
  const got = [...readTar(tar)].map((e) => [e.name, e.data.toString()]);
  assert.deepEqual(got, [
    ["package/a.txt", "a"],
    ["package/sub/b.txt", "b"],
    [long, "c"],
    ["package/gnu-long.txt", "d"],
  ]);
});

test("unpacks an npm tarball without its top folder, and refuses a path out of it", () => {
  const dest = mkdtempSync(join(tmpdir(), "pinned-x-"));
  assert.equal(
    extractTgz(
      tgz(entry("package/package.json", "{}"), entry("package/lib/x.js", "x")),
      dest,
    ),
    2,
  );
  assert.equal(readFileSync(join(dest, "lib", "x.js"), "utf8"), "x");
  assert.throws(
    () =>
      extractTgz(
        tgz(entry("package/../../evil.txt", "no")),
        join(dest, "inner"),
      ),
    /unsafe path/,
  );
  assert.equal(existsSync(join(dest, "evil.txt")), false);
});

test("checks Subresource Integrity hashes", () => {
  const data = Buffer.from("hello");
  assert.equal(matchesIntegrity(data, sri(data)), true);
  assert.equal(matchesIntegrity(Buffer.from("hellO"), sri(data)), false);
  assert.equal(
    matchesIntegrity(
      data,
      `sha1-${createHash("sha1").update(data).digest("base64")}`,
    ),
    false,
  );
  assert.equal(matchesIntegrity(data, `sha512-AAAA ${sri(data)}`), true);
});

/** A registry with craftos-mcp@9.9.9 (bin + a dependency) and a dependency nested under another. */
function registry() {
  const files = {
    "https://r/craftos-mcp.tgz": tgz(
      entry("package/package.json", '{"name":"craftos-mcp","version":"9.9.9"}'),
      entry("package/scripts/npm/craftos-mcp.mjs", "console.log('hi')"),
    ),
    "https://r/zod.tgz": tgz(entry("package/index.js", "zod")),
    "https://r/old.tgz": tgz(entry("package/index.js", "old")),
  };
  const lock = {
    spec: "craftos-mcp@9.9.9",
    bin: "scripts/npm/craftos-mcp.mjs",
    packages: [
      {
        path: "node_modules/craftos-mcp",
        version: "9.9.9",
        resolved: "https://r/craftos-mcp.tgz",
        integrity: sri(files["https://r/craftos-mcp.tgz"]),
      },
      {
        path: "node_modules/zod",
        version: "4.0.0",
        resolved: "https://r/zod.tgz",
        integrity: sri(files["https://r/zod.tgz"]),
      },
      {
        path: "node_modules/zod/node_modules/old",
        version: "1.0.0",
        resolved: "https://r/old.tgz",
        integrity: sri(files["https://r/old.tgz"]),
      },
    ],
  };
  const asked = [];
  const fetch = async (url) => {
    asked.push(url);
    const body = files[url];
    return body
      ? { ok: true, status: 200, arrayBuffer: async () => body }
      : { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  return { files, lock, fetch, asked };
}

test("installs every package of the lock where npm would, once, and drops older versions", async () => {
  const store = mkdtempSync(join(tmpdir(), "pinned-store-"));
  mkdirSync(join(store, "9.9.8", "node_modules"), { recursive: true });
  const r = registry();
  assert.equal(pinnedBin(store, r.lock.spec), undefined);
  const bin = await installPinned(store, r.lock, { fetch: r.fetch });
  assert.equal(
    bin,
    join(
      store,
      "9.9.9",
      "node_modules",
      "craftos-mcp",
      "scripts",
      "npm",
      "craftos-mcp.mjs",
    ),
  );
  assert.equal(pinnedBin(store, r.lock.spec), bin);
  assert.equal(
    readFileSync(
      join(
        store,
        "9.9.9",
        "node_modules",
        "zod",
        "node_modules",
        "old",
        "index.js",
      ),
      "utf8",
    ),
    "old",
  );
  assert.equal(existsSync(join(store, "9.9.8")), false);
  // again: nothing downloaded
  const before = r.asked.length;
  await installPinned(store, r.lock, { fetch: r.fetch });
  assert.equal(r.asked.length, before);
  // directBase starts it with node, from the store the supervisor is told about
  assert.deepEqual(
    directBase(["npx", "-y", r.lock.spec], { CRAFTOS_VSCODE_STORE: store }),
    ["node", bin],
  );
  assert.deepEqual(
    directBase(["npx", "-y", "craftos-mcp@9.9.7"], {
      CRAFTOS_VSCODE_STORE: store,
    }),
    ["npx", "-y", "craftos-mcp@9.9.7"],
  );
});

test("a tarball that does not match its hash installs nothing", async () => {
  const store = mkdtempSync(join(tmpdir(), "pinned-store-"));
  const r = registry();
  r.files["https://r/zod.tgz"] = tgz(entry("package/index.js", "tampered"));
  await assert.rejects(
    installPinned(store, r.lock, { fetch: r.fetch }),
    /does not match its integrity hash/,
  );
  assert.equal(pinnedBin(store, r.lock.spec), undefined);
  assert.equal(existsSync(join(store, "9.9.9")), false);
  // and an unreachable registry says which package
  await assert.rejects(
    installPinned(store, r.lock, {
      fetch: async () => {
        throw new Error("ENOTFOUND");
      },
    }),
    /could not download .*ENOTFOUND/,
  );
});

test("a marker for another version, or a missing bin, does not count", () => {
  const store = mkdtempSync(join(tmpdir(), "pinned-store-"));
  mkdirSync(join(store, "9.9.9"), { recursive: true });
  writeFileSync(
    join(store, "9.9.9", "pinned.json"),
    JSON.stringify({ spec: "craftos-mcp@9.9.9", bin: "x.mjs" }),
  );
  assert.equal(pinnedBin(store, "craftos-mcp@9.9.9"), undefined);
  assert.equal(pinnedBin(store, "craftos-mcp"), undefined);
  assert.equal(pinnedBin(undefined, "craftos-mcp@9.9.9"), undefined);
});

test("the shipped lock is for NPM_PACKAGE (run pin-lock.mjs after bumping it), all from the registry, hashed", () => {
  assert.equal(PINNED_LOCK.spec, NPM_PACKAGE);
  assert.ok(
    PINNED_LOCK.packages.some((p) => p.path === "node_modules/craftos-mcp"),
  );
  for (const p of PINNED_LOCK.packages) {
    assert.match(p.resolved, /^https:\/\/registry\.npmjs\.org\//);
    assert.match(p.integrity, /^sha512-/);
  }
});
