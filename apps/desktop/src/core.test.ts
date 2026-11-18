// The desktop app's logic (core.mjs) under plain Node: the catalog, craftos.json, recents, and the real thing at the
// end: a project is started as the app's Run button starts it, its program's output is read off the screen, and its
// tests run as Run tests runs them.
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
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error plain JavaScript, shared with the Electron main process
import * as core from "./core.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "craftos-desktop-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const loc = core.locate({ packaged: false, resourcesPath: "", here, env: {} });
const runner = await core.loadRunner(loc);

function folder(name: string, files: Record<string, string> = {}): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}
const json = (dir: string) =>
  JSON.parse(readFileSync(join(dir, "craftos.json"), "utf8"));

describe("the catalog", () => {
  const cat = core.catalog(runner);

  it("lists the Minecraft versions newest first, with their CC:Tweaked versions", () => {
    expect(cat.versions.map((v: { mc: string }) => v.mc)).toEqual([
      "1.21.1",
      "1.20.1",
      "1.18.2",
    ]);
    expect(cat.versions[0].cc).toMatch(/^1\.\d+\.\d+$/);
    expect(cat.versions.map((v: { mc: string }) => v.mc)).toContain(
      cat.defaultMc,
    );
  });

  it("gives every mod a name and a plain description", () => {
    expect(cat.addons.length).toBeGreaterThan(30);
    for (const a of cat.addons) {
      expect(a.name, a.id).toBeTruthy();
      expect(a.summary.length, a.id).toBeGreaterThan(10);
    }
  });
});

describe("a project folder", () => {
  it("without craftos.json shows the defaults and writes nothing", () => {
    const dir = folder("plain", {
      "startup.lua": "print('hi')",
      "lib/util.lua": "return {}",
      "tests/a.test.lua": "",
      "node_modules/x/y.lua": "",
      ".git/hooks/z.lua": "",
    });
    const p = core.readProject(runner, dir);
    expect(p.hasFile).toBe(false);
    expect(p.minecraft).toBe(runner.DEFAULT_MC);
    expect(p.programs).toEqual(["startup.lua", "lib/util.lua"]);
    expect(p.tests).toEqual(["tests/a.test.lua"]);
    expect(p.run).toBe("");
    expect(p.addons).toEqual(
      runner.addonsFor(runner.DEFAULT_MC).map((a: { id: string }) => a.id),
    );
    expect(existsSync(join(dir, "craftos.json"))).toBe(false);
  });

  it("saves the version, the mods and the program to craftos.json, as the command line reads it", () => {
    const dir = folder("save", { "main.lua": "" });
    let p = core.saveProject(runner, dir, { minecraft: "1.20.1" });
    expect(json(dir)).toMatchObject({
      workspace: ".",
      minecraft: "1.20.1",
      addons: "all",
    });
    p = core.saveProject(runner, dir, {
      addons: ["mekanism-generators", "create"],
    });
    // a mod that needs another brings it along
    expect(p.addons).toEqual(["mekanism", "mekanism-generators", "create"]);
    p = core.saveProject(runner, dir, { run: "main.lua" });
    expect(json(dir).run).toBe("main.lua");
    expect(p.run).toBe("main.lua");
    expect(runner.checkProject(json(dir), dir)).toEqual([]);
    // the command line finds the same choices
    const found = runner.findProject(dir, {});
    expect(runner.projectEnv(found, {})).toMatchObject({
      CRAFTOS_VERSION: "1.20.1",
      CRAFTOS_ADDONS: "mekanism,mekanism-generators,create",
    });
    core.saveProject(runner, dir, { addons: [] });
    expect(json(dir).addons).toBe("none");
    core.saveProject(runner, dir, { run: "" });
    expect(json(dir).run).toBeUndefined();
  });

  it("a version change keeps the picked mods the new version has, and keeps the rest of the file", () => {
    const dir = folder("switch", {
      "craftos.json": JSON.stringify({
        workspace: ".",
        minecraft: "1.20.1",
        addons: ["bigger-reactors", "create", "cc-liftlink"],
        tests: ["tests/**/*.test.lua"],
      }),
    });
    const p = core.saveProject(runner, dir, { minecraft: "1.21.1" });
    // Bigger Reactors has no 1.21.1 release
    expect(p.addons).toEqual(["create", "cc-liftlink"]);
    expect(json(dir).tests).toEqual(["tests/**/*.test.lua"]);
    expect(runner.checkProject(json(dir), dir)).toEqual([]);
    // 1.18.2 has no CC: LiftLink
    expect(
      core.saveProject(runner, dir, { minecraft: "1.18.2" }).addons,
    ).toEqual(["create"]);
  });

  it("never writes over a craftos.json that is not valid JSON", () => {
    const dir = folder("broken", { "craftos.json": "{ not json" });
    const p = core.readProject(runner, dir);
    expect(p.broken).toBe(true);
    expect(p.errors[0]).toContain("craftos.json");
    expect(() =>
      core.saveProject(runner, dir, { minecraft: "1.20.1" }),
    ).toThrow(/not valid JSON/);
    expect(readFileSync(join(dir, "craftos.json"), "utf8")).toBe("{ not json");
  });

  it("New project makes a folder that runs and tests at once", () => {
    const parent = folder("new");
    const dir = core.createProject(runner, { parent, name: "first" });
    expect(dir).toBe(join(parent, "first"));
    const p = core.readProject(runner, dir);
    expect(p.errors).toEqual([]);
    expect(p.run).toBe("hello.lua");
    expect(p.tests).toEqual(["hello.test.lua"]);
    expect(p.addons).toEqual([]); // no mods ticked until the person picks theirs
    expect(() => core.createProject(runner, { parent, name: "first" })).toThrow(
      /not empty/,
    );
    for (const bad of ["", "a/b", "con:", "dot.", ".."])
      expect(
        () => core.createProject(runner, { parent, name: bad }),
        bad,
      ).toThrow(/name/);
  });

  it("Run gets the world craftos.json names: its blocks, and its monitors apart", () => {
    const dir = folder("world", {
      "lamp.lua": "",
      "craftos.json": JSON.stringify({ world: "lamp.world.json" }),
      "lamp.world.json": JSON.stringify({
        $schema: "x",
        monitors: [{ name: "top", blocksWide: 2, blocksHigh: 1 }],
        players: [{ name: "Alice" }],
      }),
    });
    expect(core.projectWorld(runner, dir)).toEqual({
      world: { players: [{ name: "Alice" }] },
      monitors: [{ name: "top", blocksWide: 2, blocksHigh: 1 }],
    });
    // a saved world by name goes to the app as that name; no world at all is nothing
    expect(
      core.projectWorld(
        runner,
        folder("named", {
          "craftos.json": JSON.stringify({ world: "create-demo" }),
        }),
      ),
    ).toEqual({ worldFile: "create-demo" });
    expect(core.projectWorld(runner, folder("none", { "a.lua": "" }))).toEqual(
      {},
    );
    expect(() =>
      core.projectWorld(
        runner,
        folder("world-missing", {
          "craftos.json": JSON.stringify({ world: "missing.world.json" }),
        }),
      ),
    ).toThrow(/missing\.world\.json .* could not be read/);
  });
});

describe("recent projects and settings", () => {
  it("newest first, no doubles, a folder that is gone is marked", () => {
    const recents = new core.Recents(join(scratch, "state", "recent.json"), 3);
    expect(recents.list()).toEqual([]);
    const a = folder("ra");
    const b = folder("rb");
    recents.add(a, 1);
    recents.add(b, 2);
    recents.add(a, 3);
    recents.add(join(scratch, "gone"), 4);
    expect(recents.list().map((r: { name: string }) => r.name)).toEqual([
      "gone",
      "ra",
      "rb",
    ]);
    expect(recents.list()[0].missing).toBe(true);
    recents.add(folder("rc"), 5);
    expect(recents.list()).toHaveLength(3);
    recents.remove(a);
    expect(recents.list().map((r: { name: string }) => r.name)).toEqual([
      "rc",
      "gone",
    ]);
  });

  it("a broken settings file reads as the defaults", () => {
    const file = join(scratch, "state", "settings.json");
    writeFileSync(file, "nonsense");
    const store = new core.JsonStore(file, {});
    expect(core.readSettings(store)).toEqual(core.DEFAULT_SETTINGS);
    store.write({ theme: "dark", autoUpdate: false });
    expect(core.readSettings(store)).toEqual({
      theme: "dark",
      autoUpdate: false,
    });
  });
});

describe("updates", () => {
  it("compares versions", () => {
    expect(core.compareVersions("0.4.1", "0.4.0")).toBe(1);
    expect(core.compareVersions("v0.4.1", "0.4.1")).toBe(0);
    expect(core.compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(core.compareVersions("1.0.0-beta.1", "1.0.0")).toBe(-1);
  });

  it("names a newer release, and stays quiet about an older one or no network", async () => {
    const answer = (tag: string) => async () => ({
      ok: true,
      json: async () => ({ tag_name: tag, html_url: "https://example.test/r" }),
    });
    expect(await core.newerRelease("0.4.1", answer("v0.5.0"))).toEqual({
      version: "0.5.0",
      url: "https://example.test/r",
    });
    expect(await core.newerRelease("0.4.1", answer("v0.4.1"))).toBeUndefined();
    expect(
      await core.newerRelease("0.4.1", async () => {
        throw new Error("offline");
      }),
    ).toBeUndefined();
  });
});

describe("the emulator's child process", () => {
  it("gets the project's version and the bundled engine, not a terminal's leftovers", () => {
    const env = core.childEnv(
      { engine: "/app/engine/craftos" },
      { minecraft: "1.20.1" },
      { CRAFTOS_ADDONS: "none", CRAFTOS_WORKSPACE: "/elsewhere", PATH: "/bin" },
    );
    expect(env).toEqual({
      PATH: "/bin",
      ELECTRON_RUN_AS_NODE: "1",
      CRAFTOS_VERSION: "1.20.1",
      CRAFTOS_ENGINE: "/app/engine/craftos",
    });
  });

  it("says setup lines in plain words", () => {
    expect(
      core.plainProgress(
        "craftos-mcp: setting up 0.4.1 in C:\\x (once; about a minute)",
      ),
    ).toMatch(/^First run: getting CC:Tweaked's files/);
    expect(core.plainProgress("craftos-mcp: ready (41 s)")).toBe("Ready");
    expect(
      core.plainProgress(
        "craftos-mcp:   Downloading https://cdn.modrinth.com/data/x/versions/y/cc-tweaked-1.20.1-forge-1.121.0.jar",
      ),
    ).toBe(
      "Downloading cc-tweaked-1.20.1-forge-1.121.0.jar from cdn.modrinth.com",
    );
    expect(
      core.plainProgress(
        "craftos-mcp:   ROM written to C:\\x\\rom\\cc-1.121.0.part (222 files)",
      ),
    ).toBe("Putting CC:Tweaked's files in place");
    expect(core.plainProgress("")).toBe("");
    expect(
      core.plainProgress(
        "craftos-mcp: setup failed: could not reach cdn.modrinth.com: ENOTFOUND cdn.modrinth.com",
      ),
    ).toBe("The download did not work: could not reach cdn.modrinth.com.");
    expect(
      core.plainProgress(
        "craftos-mcp: No network, or a proxy? Set HTTPS_PROXY (and so on)",
      ),
    ).toMatch(/needs the internet once/);
  });

  it("Run starts the project's program in a computer, and Home shuts it down", async () => {
    const parent = folder("run");
    const dir = core.createProject(runner, { parent, name: "demo" });
    core.saveProject(runner, dir, { addons: ["create"] });
    const project = core.readProject(runner, dir);
    const started = await core.startApp(loc, project);
    try {
      expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      const id = await core.openComputer(started.url, {
        name: project.name,
        program: project.run,
      });
      let text = "";
      for (let i = 0; i < 240 && !text.includes("Hello from"); i++) {
        await new Promise((r) => setTimeout(r, 250));
        text = await core.screenText(started.url, id);
      }
      expect(text).toContain("Hello from");
      // the browser app the window shows is served, and knows the project's choices
      const meta = await (await fetch(new URL("api/meta", started.url))).json();
      expect(meta.version).toBe(project.minecraft);
      expect(
        meta.addons
          .filter((a: { on: boolean }) => a.on)
          .map((a: { id: string }) => a.id),
      ).toEqual(["create"]);
      expect(meta.programs).toContain("hello.lua");
    } finally {
      await started.stop();
    }
    await started.exit;
    await expect(fetch(started.url)).rejects.toThrow();
  }, 120_000);

  it("Run tests gives the results, and plain words when there are no tests", async () => {
    const parent = folder("tests");
    const dir = core.createProject(runner, { parent, name: "demo" });
    writeFileSync(
      join(dir, "bad.test.lua"),
      'ccunit.test("two is three", function() ccunit.eq(2, 3) end)\n',
    );
    const answer = await core.runTests(loc, core.readProject(runner, dir));
    expect(answer.ok).toBe(true);
    expect(answer.result.passed).toBe(1);
    expect(answer.result.failed).toBe(1);
    expect(
      answer.result.files.map((f: { file: string; status: string }) => [
        f.file,
        f.status,
      ]),
    ).toEqual([
      ["bad.test.lua", "failed"],
      ["hello.test.lua", "passed"],
    ]);

    const empty = folder("no-tests", { "main.lua": "" });
    core.saveProject(runner, empty, {});
    const none = await core.runTests(loc, core.readProject(runner, empty));
    expect(none.ok).toBe(false);
    expect(none.message).toMatch(/no test files yet/);
  }, 120_000);
});
