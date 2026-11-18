// craftos.json (project.ts) and the per-user cache's pruning (cache.ts). schemas/craftos.schema.json is a file
// snapshot of projectSchema(): after changing it, regenerate with
//
//   npx vitest run packages/runner/src/project.test.ts -u
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  compareVersions,
  listCachedVersions,
  pruneCache,
  versionsToKeep,
} from "./cache.js";
import {
  checkProject,
  filterByGlobs,
  findProject,
  globToRegExp,
  projectEnv,
  projectSchema,
  projectWorkspace,
  projectWorld,
} from "./project.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const scratch = mkdtempSync(join(tmpdir(), "project-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function put(path: string, content = ""): string {
  const file = join(scratch, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

describe("craftos.json", () => {
  it("schemas/craftos.schema.json is up to date (regenerate with vitest -u)", async () => {
    await expect(
      `${JSON.stringify(projectSchema(), null, 2)}\n`,
    ).toMatchFileSnapshot(join(REPO, "schemas", "craftos.schema.json"));
  });

  it("is found upwards, but not past the folder with .git", () => {
    put("a/.git/HEAD");
    put("a/craftos.json", JSON.stringify({ workspace: "src" }));
    mkdirSync(join(scratch, "a", "src", "deep"), { recursive: true });
    const found = findProject(join(scratch, "a", "src", "deep"), {});
    expect(found?.file).toBe(join(scratch, "a", "craftos.json"));
    expect(projectWorkspace(found!)).toBe(join(scratch, "a", "src"));
    // a repo inside: its own .git stops the search before the outer craftos.json
    put("a/inner/.git/HEAD");
    expect(findProject(join(scratch, "a", "inner"), {})).toBeUndefined();
    // CRAFTOS_PROJECT_FILE names one, or "off" for none
    expect(
      findProject(join(scratch, "a", "src"), { CRAFTOS_PROJECT_FILE: "off" }),
    ).toBeUndefined();
    expect(
      findProject(scratch, {
        CRAFTOS_PROJECT_FILE: join(scratch, "a", "craftos.json"),
      })?.dir,
    ).toBe(join(scratch, "a"));
  });

  it("says what is wrong, key by key", () => {
    put("b/craftos.json", "{ not json");
    expect(() => findProject(join(scratch, "b"), {})).toThrow(/craftos\.json/);
    expect(checkProject([])).toEqual(["craftos.json must be a JSON object"]);
    const errors = checkProject(
      {
        workspce: "src",
        minecraft: "1.12.2",
        addons: ["mekansim"],
        tests: "x",
        world: "missing.json",
      },
      scratch,
    );
    expect(errors.join("\n")).toMatch(/unknown key "workspce"/);
    expect(errors.join("\n")).toMatch(/minecraft: unknown version "1\.12\.2"/);
    expect(errors.join("\n")).toMatch(/addons: unknown addon "mekansim"/);
    expect(errors.join("\n")).toMatch(/tests must be a list/);
    expect(errors.join("\n")).toMatch(/world: no file/);
    expect(
      checkProject(
        {
          workspace: ".",
          minecraft: "1.20.1",
          addons: "all",
          tests: ["*.test.lua"],
        },
        scratch,
      ),
    ).toEqual([]);
  });

  it("stands in for the environment only where it is unset", () => {
    const project = {
      file: join(scratch, "craftos.json"),
      dir: scratch,
      data: { workspace: "src", minecraft: "1.20.1", addons: ["create"] },
    };
    expect(projectEnv(project, {})).toEqual({
      CRAFTOS_WORKSPACE: join(scratch, "src"),
      CRAFTOS_VERSION: "1.20.1",
      CRAFTOS_ADDONS: "create",
      CRAFTOS_ADDONS_FROM: join(scratch, "craftos.json"),
    });
    expect(
      projectEnv(project, {
        CRAFTOS_VERSION: "1.18.2",
        CRAFTOS_ADDONS: "none",
      }),
    ).toEqual({ CRAFTOS_WORKSPACE: join(scratch, "src") });
    expect(projectEnv(undefined, {})).toEqual({});
    expect(
      projectEnv({ ...project, data: { addons: [] } }, {})["CRAFTOS_ADDONS"],
    ).toBe("none");
  });

  it("names a world by file (relative to it) or by saved name", () => {
    const at = (world: string) =>
      projectWorld({ file: "", dir: scratch, data: { world } });
    expect(at("door.world.json")).toBe(join(scratch, "door.world.json"));
    expect(at("advanced-peripherals-demo")).toBe("advanced-peripherals-demo");
  });

  it("matches test globs", () => {
    expect(globToRegExp("tests/**/*.test.lua").test("tests/a.test.lua")).toBe(
      true,
    );
    expect(
      globToRegExp("tests/**/*.test.lua").test("tests/x/y/a.test.lua"),
    ).toBe(true);
    expect(globToRegExp("tests/*.test.lua").test("tests/x/a.test.lua")).toBe(
      false,
    );
    expect(globToRegExp("**/*.test.lua").test("a.test.lua")).toBe(true);
    expect(globToRegExp("./{a,b}.test.lua").test("b.test.lua")).toBe(true);
    expect(
      filterByGlobs(
        ["a.test.lua", "slow/b.test.lua", "unit/c.test.lua"],
        ["unit/**", "a.test.lua"],
      ),
    ).toEqual(["a.test.lua", "unit/c.test.lua"]);
  });
});

describe("cache pruning", () => {
  it("compares versions as semver does", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("keeps the current version and the newest one before it", () => {
    const all = ["0.1.0", "0.2.0", "0.10.0", "0.3.0", "0.11.0"];
    expect([...versionsToKeep(all, "0.10.0")].sort()).toEqual([
      "0.10.0",
      "0.3.0",
    ]);
    expect([...versionsToKeep(all, undefined)].sort()).toEqual([
      "0.10.0",
      "0.11.0",
    ]);
    expect([...versionsToKeep(["0.1.0"], "0.1.0")]).toEqual(["0.1.0"]);
  });

  it("removes the rest, never a folder in the middle of a setup or jars/runtime", () => {
    const home = join(scratch, "home");
    for (const v of ["0.1.0", "0.2.0", "0.3.0", "0.4.0"])
      put(`home/${v}/engine/build/craftos`, "x".repeat(100));
    put("home/0.1.0/setup.lock", "1 1");
    put("home/jars/cc.jar", "j");
    put("home/runtime/x", "r");
    expect(listCachedVersions(home).map((v) => v.version)).toEqual([
      "0.1.0",
      "0.2.0",
      "0.3.0",
      "0.4.0",
    ]);
    const dry = pruneCache(home, "0.4.0", { dryRun: true });
    expect(dry.removed.map((v) => v.version)).toEqual(["0.2.0"]);
    expect(existsSync(join(home, "0.2.0"))).toBe(true);
    const done = pruneCache(home, "0.4.0");
    expect(done.removed.map((v) => v.version)).toEqual(["0.2.0"]);
    expect(done.removed[0]!.bytes).toBeGreaterThanOrEqual(100);
    expect(existsSync(join(home, "0.2.0"))).toBe(false);
    for (const kept of ["0.1.0", "0.3.0", "0.4.0", "jars", "runtime"])
      expect(existsSync(join(home, kept)), kept).toBe(true);
  });
});
