// Bringing computers over from CraftOS-PC (craftospc-import.ts, craftospc-webapp.ts), from a made-up CraftOS-PC folder
// shaped as CraftOS-PC 2.8 leaves one.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  checkProject,
  checkWorld,
  craftosPcApi,
  craftosPcFolders,
  findAttaches,
  findCraftosPc,
  importCraftosPc,
  importedComputers,
  readCraftosPc,
} from "./index.js";

const root = mkdtempSync(join(tmpdir(), "craftospc-import-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const write = (file: string, text: string): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

/** A CraftOS-PC data folder: two computers, a floppy, the global config and per-computer ones. */
function fakeCraftosPc(dir: string): string {
  write(
    join(dir, "config", "global.json"),
    JSON.stringify({
      initialComputer: 3,
      http_enable: false,
      defaultWidth: 51,
      defaultHeight: 19,
      mount_mode: 3,
      lastVersion: "v2.8.3",
    }),
  );
  write(
    join(dir, "config", "0.json"),
    JSON.stringify({
      base64: true,
      computerHeight: 0,
      computerWidth: 0,
      isColor: true,
      startFullscreen: false,
    }),
  );
  write(
    join(dir, "config", "3.json"),
    JSON.stringify({
      base64: true,
      label: Buffer.from("Miner Bob").toString("base64"),
      isColor: false,
      computerWidth: 39,
      computerHeight: 13,
    }),
  );
  write(
    join(dir, "computer", "0", "startup.lua"),
    [
      'periphemu.create("top", "monitor")',
      "periphemu.create('left', 'drive', 1)",
      'periphemu.create("back", "modem")',
      'periphemu.create("right", "computer")',
      'periphemu.create("bottom", "debugger")',
      'periphemu.create("front", "printer")',
      'periphemu.create("top", "speaker") -- the side is taken: CraftOS-PC returns false',
      "local mon = peripheral.wrap('top')",
      "mon.write('hello')",
    ].join("\n"),
  );
  write(join(dir, "computer", "0", "lib", "util.lua"), "return {}\n");
  write(join(dir, "computer", "0", ".settings"), "{}\n");
  write(join(dir, "computer", "3", "mine.lua"), 'print("digging")\n');
  write(
    join(dir, "computer", "3", "startup", "10-chest.lua"),
    'periphemu.create("front", "chest")\n',
  );
  write(join(dir, "computer", "disk", "1", "hello.txt"), "on the floppy\n");
  mkdirSync(join(dir, "computer", "notes"), { recursive: true }); // not a computer
  return dir;
}

const source = fakeCraftosPc(join(root, "CraftOS-PC"));

describe("reading a CraftOS-PC folder", () => {
  it("finds the computers, labels, colour, sizes and what their startup attaches", () => {
    const data = readCraftosPc(source);
    expect(data.computers.map((c) => c.id)).toEqual([0, 3]);
    expect(data.initial).toBe(3);
    expect(data.disks).toEqual([1]);
    const [zero, three] = data.computers;
    expect(zero!.label).toBeUndefined();
    expect(zero!.isColor).toBe(true);
    expect([zero!.width, zero!.height]).toEqual([51, 19]);
    expect(zero!.files).toBe(3);
    expect(zero!.usesCraftosPcApis).toBe(true);
    expect(zero!.attaches.map((a) => `${a.type}@${a.side}`)).toEqual([
      "monitor@top",
      "drive@left",
      "modem@back",
      "computer@right",
      "debugger@bottom",
      "printer@front",
      "speaker@top",
    ]);
    expect(zero!.attaches[1]!.args).toEqual(["1"]);
    expect(three!.label).toBe("Miner Bob");
    expect(three!.isColor).toBe(false);
    expect([three!.width, three!.height]).toEqual([39, 13]);
    expect(three!.attaches).toEqual([
      { side: "front", type: "chest", args: [], file: "startup/10-chest.lua" },
    ]);
    expect(data.notes.join(" ")).toContain("HTTP turned off");
    expect(data.notes.join(" ")).toContain("Folders mounted from your PC");
  });

  it("reads only literal periphemu.create calls", () => {
    expect(
      findAttaches(
        'periphemu.create(side, "monitor")\nperiphemu.create( "top" , "printer" , "out.pdf" )',
        "startup.lua",
      ),
    ).toEqual([
      { side: "top", type: "printer", args: ["out.pdf"], file: "startup.lua" },
    ]);
  });

  it("refuses a folder that is not CraftOS-PC's", () => {
    expect(() => readCraftosPc(join(root, "nothing"))).toThrow(
      /is not a CraftOS-PC data folder/,
    );
  });

  it("knows where CraftOS-PC keeps its data on each system", () => {
    expect(
      craftosPcFolders(
        { APPDATA: "C:\\Users\\a\\AppData\\Roaming" },
        "win32",
        "C:\\Users\\a",
      ),
    ).toEqual([join("C:\\Users\\a\\AppData\\Roaming", "CraftOS-PC")]);
    expect(craftosPcFolders({}, "darwin", "/Users/a")).toEqual([
      join("/Users/a", "Library", "Application Support", "CraftOS-PC"),
    ]);
    expect(craftosPcFolders({}, "linux", "/home/a")[0]).toBe(
      join("/home/a", ".local", "share", "craftos-pc"),
    );
    expect(
      craftosPcFolders({ XDG_DATA_HOME: "/data" }, "linux", "/home/a")[0],
    ).toBe(join("/data", "craftos-pc"));
    expect(findCraftosPc({ APPDATA: root }, "win32", root)).toBe(source);
    expect(
      findCraftosPc({ APPDATA: join(root, "none") }, "win32", root),
    ).toBeUndefined();
  });
});

describe("importing", () => {
  const out = join(root, "project");
  const result = importCraftosPc(source, out);

  it("writes craftos.json for the computer CraftOS-PC opens first, and a world for each", () => {
    const project = JSON.parse(readFileSync(join(out, "craftos.json"), "utf8"));
    expect(project).toMatchObject({
      workspace: "computer/3",
      world: "computer-3.world.json",
      addons: "none",
    });
    expect(checkProject(project, out)).toEqual([]);
    expect(result.computers.map((c) => c.id)).toEqual([0, 3]);
    for (const c of result.computers) {
      const world = JSON.parse(readFileSync(c.worldFile, "utf8"));
      expect(world.$schema).toMatch(/schemas\/world\.schema\.json$/);
      expect(checkWorld(world).errors).toEqual([]);
    }
  });

  it("copies every file, dotfiles and folders too, and leaves the CraftOS-PC folder as it was", () => {
    expect(
      readFileSync(join(out, "computer", "0", "startup.lua"), "utf8"),
    ).toContain("periphemu");
    expect(existsSync(join(out, "computer", "0", "lib", "util.lua"))).toBe(
      true,
    );
    expect(existsSync(join(out, "computer", "0", ".settings"))).toBe(true);
    expect(
      existsSync(join(out, "computer", "3", "startup", "10-chest.lua")),
    ).toBe(true);
    expect(existsSync(join(out, "computer", "notes"))).toBe(false);
    expect(
      readFileSync(join(source, "computer", "0", "startup.lua"), "utf8"),
    ).toContain("periphemu");
  });

  it("turns the startup's peripherals into the world, and says what does not come across", () => {
    const zero = result.computers.find((c) => c.id === 0)!.world;
    expect(zero).toMatchObject({
      computerId: 0,
      monitors: [{ name: "top", blocksWide: 5, blocksHigh: 3 }],
      peripherals: [
        { name: "left", type: "drive", disk: 1 },
        { name: "back", type: "modem" },
        { name: "front", type: "printer", ink: 64, paper: 64 },
      ],
      disks: { "1": { "hello.txt": "on the floppy\n" } },
      craftosPcApis: true,
    });
    const three = result.computers.find((c) => c.id === 3)!.world;
    expect(three).toEqual({
      computerId: 3,
      label: "Miner Bob",
      advanced: false,
      terminal: { width: 39, height: 13 },
      peripherals: [{ name: "front", type: "minecraft:chest", size: 27 }],
      craftosPcApis: true,
    });
    const notes = result.notes.join("\n");
    expect(notes).toContain(
      "the computer attached on right (startup.lua) is not brought over",
    );
    expect(notes).toContain(
      "the debugger on bottom (startup.lua) has no counterpart here",
    );
    expect(notes).toContain("the printer on front (startup.lua) prints pages");
    expect(notes).toContain("walls of 5x3 blocks");
    expect(notes).toContain("craftosPcApis is on");
  });

  it("does not write over an earlier import unless asked", () => {
    expect(() => importCraftosPc(source, out)).toThrow(/is there already/);
    expect(
      importCraftosPc(source, out, { force: true }).computers,
    ).toHaveLength(2);
    expect(
      importCraftosPc(source, join(root, "only0"), { ids: [0] }).computers.map(
        (c) => c.id,
      ),
    ).toEqual([0]);
    expect(() =>
      importCraftosPc(source, join(root, "x"), { ids: [9] }),
    ).toThrow(/no computer 9/);
  });

  it("never writes into the CraftOS-PC folder", () => {
    expect(() =>
      importCraftosPc(source, join(source, "computer", "x")),
    ).toThrow(/cannot go inside the CraftOS-PC folder/);
    expect(() => importCraftosPc(source, source)).toThrow(/cannot go inside/);
  });

  it("lists an imported project's computers again", () => {
    const again = importedComputers(out);
    expect(again.map((c) => [c.id, c.label ?? null])).toEqual([
      [0, null],
      [3, "Miner Bob"],
    ]);
    expect(again[1]!.world).not.toHaveProperty("$schema");
    expect(importedComputers(join(root, "nothing"))).toEqual([]);
  });
});

describe("the app's /api/craftos-pc", () => {
  const call = (
    method: string,
    path: string,
    body: Record<string, unknown> = {},
  ) =>
    craftosPcApi(method, new URL(path, "http://localhost"), async () => body);

  it("shows what is in a folder, and what is not there", async () => {
    const found = await call(
      "GET",
      `/api/craftos-pc?folder=${encodeURIComponent(source)}`,
    );
    expect(found!.status).toBe(200);
    expect(found!.body).toMatchObject({
      found: true,
      folder: source,
      initial: 3,
      computers: [{ id: 0 }, { id: 3, label: "Miner Bob", isColor: false }],
    });
    const missing = await call(
      "GET",
      `/api/craftos-pc?folder=${encodeURIComponent(join(root, "none"))}`,
    );
    expect(missing!.body).toMatchObject({ found: false, computers: [] });
  });

  it("imports, then lists the computers with what starts each", async () => {
    const out = join(root, "from-app");
    const made = await call("POST", "/api/craftos-pc/import", {
      folder: source,
      out,
    });
    expect(made!.status).toBe(200);
    const body = made!.body as {
      computers: { id: number; start: Record<string, unknown> }[];
    };
    expect(body.computers[1]!.start).toMatchObject({
      name: "Miner Bob",
      advanced: false,
      dir: join(out, "computer", "3"),
      addons: [],
      world: { computerId: 3, label: "Miner Bob" },
      monitors: [],
    });
    expect(body.computers[0]!.start["monitors"]).toEqual([
      { name: "top", blocksWide: 5, blocksHigh: 3 },
    ]);
    expect(body.computers[0]!.start["world"]).not.toHaveProperty("monitors");

    const again = await call("POST", "/api/craftos-pc/import", {
      folder: source,
      out,
    });
    expect(again!.status).toBe(409);
    expect(again!.body).toMatchObject({ exists: true });
    const replaced = await call("POST", "/api/craftos-pc/import", {
      folder: source,
      out,
      force: true,
    });
    expect(replaced!.status).toBe(200);

    const listed = await call(
      "GET",
      `/api/craftos-pc/project?dir=${encodeURIComponent(out)}`,
    );
    expect((listed!.body as { computers: unknown[] }).computers).toHaveLength(
      2,
    );
  });

  it("leaves other paths alone", async () => {
    expect(await call("GET", "/api/craftos-pcx")).toBeUndefined();
  });
});
