// The web extension's pure parts: the ROM and font made from CC:Tweaked's jar (src/web/rom.ts) and the cart a program
// becomes (src/web/cart.ts). They are bundled with esbuild first, as esbuild.mjs bundles them (rom.ts imports a .lua
// patch as text; cart.ts pulls in packages/runner's world code).
// The jar is not downloaded here: CRAFTOS_JAR, else the repo's .cache/ (scripts/build-rom.mjs --download puts it
// there). Without one the ROM tests are skipped.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const ext = join(here, "..", "..");
const repo = join(ext, "..", "..");

async function load(entry) {
  const out = await build({
    entryPoints: [join(ext, entry)],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    alias: {
      "node:fs": join(ext, "src/web/shims/node-fs.ts"),
      "node:path": join(ext, "src/web/shims/node-path.ts"),
    },
    loader: { ".lua": "text" },
    logLevel: "silent",
  });
  const code = out.outputFiles[0].text;
  return import(
    `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
  );
}

const rom = await load("src/web/rom.ts");
const { buildCart } = await load("src/web/cart.ts");

const jarPath = [
  process.env.CRAFTOS_JAR,
  join(repo, ".cache", rom.JAR.file),
].find((p) => p && existsSync(p));

test("packs round-trip", () => {
  const files = new Map([
    ["/craftos/b.lua", new TextEncoder().encode("print('b')")],
    ["/craftos/a/x.bin", new Uint8Array([0, 1, 2, 255])],
  ]);
  const back = rom.readPack(rom.writePack(files));
  assert.deepEqual([...back.keys()], ["/craftos/a/x.bin", "/craftos/b.lua"]);
  assert.deepEqual([...back.get("/craftos/a/x.bin")], [0, 1, 2, 255]);
});

test("a wrong jar is refused", async () => {
  await assert.rejects(
    rom.buildRom(new Uint8Array([1, 2, 3]), new Uint8Array()),
    /sha512 mismatch/,
  );
});

test(
  "the ROM and font from the real jar",
  { skip: !jarPath && "no CC:Tweaked jar (CRAFTOS_JAR or .cache/)" },
  async () => {
    const overlay = rom.writePack(
      new Map([["rom/ccsim/init.lua", new TextEncoder().encode("-- overlay")]]),
    );
    const built = await rom.buildRom(
      new Uint8Array(readFileSync(jarPath)),
      gzipSync(overlay),
    );
    // the font is cut from term_font.png exactly as packages/rawterm's cc-font.bin was
    assert.deepEqual(
      Buffer.from(built.font),
      readFileSync(join(repo, "packages", "rawterm", "assets", "cc-font.bin")),
    );
    const files = rom.readPack(built.rom);
    const text = (p) => new TextDecoder().decode(files.get(p));
    assert.ok(files.has("/craftos/rom/programs/shell.lua"));
    assert.equal(text("/craftos/rom/ccsim/init.lua"), "-- overlay");
    assert.match(
      text("/craftos/bios.lua"),
      /function os\.shutdown\(\.\.\.\)\n    nativeShutdown\(\.\.\.\)/,
    );
    assert.match(
      text("/craftos/rom/startup.lua"),
      /pcall\(dofile, "\/rom\/ccsim\/init\.lua"\)/,
    );
    assert.match(text("/craftos/rom/startup.lua"), /emulator/);
    assert.ok(![...files.keys()].some((p) => p.includes("term_font")));
  },
);

test("a program and its world become a one-computer cart", () => {
  const { cart, notes } = buildCart({
    program: "app/main.lua",
    files: { "app/main.lua": "print('hi')" },
    world: {
      $schema: "x",
      monitors: [{ name: "top", blocksWide: 2, blocksHigh: 1 }],
      version: "1.21.1",
      advanced: false,
    },
  });
  const [c] = cart.computers;
  assert.equal(cart.computers.length, 1);
  assert.equal(c.name, "main");
  assert.equal(c.advanced, false);
  assert.deepEqual(c.monitors, [{ name: "top", blocksWide: 2, blocksHigh: 1 }]);
  assert.deepEqual(c.screens, ["monitor:top", "terminal"]);
  assert.match(c.boot, /periphemu\.create\("top", "monitor"\)/);
  assert.match(c.boot, /shell\.run\("app\/main\.lua"\)\n$/);
  const world = JSON.parse(c.world);
  assert.equal(world.version.mc, "1.18.2");
  assert.equal(world.version.cc, "1.101.3");
  assert.equal(world.monitors, undefined);
  assert.equal(world.$schema, undefined);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /1\.21\.1/);
});

test("no world: a plain advanced computer", () => {
  const { cart, notes } = buildCart({
    program: "hello.lua",
    files: { "hello.lua": "print(1)" },
  });
  const [c] = cart.computers;
  assert.equal(c.advanced, true);
  assert.deepEqual(c.screens, ["terminal"]);
  assert.deepEqual(notes, []);
  assert.equal(JSON.parse(c.world).version.mc, "1.18.2");
});
