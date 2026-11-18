// craftos.json, a project's settings in one file: where its Lua is, the Minecraft version and mods, which test files
// to run and the world its computers start in. `craftos-mcp init` writes one; every entry point (the CLI, the MCP
// server, the VS Code extension) reads it. What a person says explicitly wins: a flag or an environment variable
// beats craftos.json, and craftos.json beats the defaults.
//
// It is found from a starting folder upwards (the folder a command runs in, --dir, CRAFTOS_WORKSPACE), stopping at
// the first folder that has a .git, so a project inside a repo never picks up a file from outside it.
// CRAFTOS_PROJECT_FILE names the file directly, or "off" for none. schemas/craftos.schema.json is generated from
// projectSchema() (project.test.ts).
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ADDONS, ADDONS_FROM_ENV, resolveAddons } from "./addons.js";
import { didYouMean } from "./did-you-mean.js";
import { VERSIONS } from "./versions.js";

export const PROJECT_FILE = "craftos.json";

export interface ProjectFile {
  /** The JSON Schema of this file, for editors. */
  $schema?: string;
  /** The folder with the Lua programs, relative to craftos.json: what every computer gets a copy of. */
  workspace?: string;
  /** The Minecraft version computers run as. */
  minecraft?: string;
  /** The mods besides CC:Tweaked: "all", "none", ids by commas, or a list of ids. */
  addons?: string | string[];
  /** Which test files `craftos-mcp test` and craftos_test run with no paths given: globs, relative to the workspace. */
  tests?: string[];
  /** The world computers start in: a .json file relative to craftos.json, or a saved world's name. */
  world?: string;
  /** The program the desktop app's Run button starts, relative to the workspace. None: the computer opens at its shell. */
  run?: string;
}

/** A craftos.json that was found: where it is and what it says. */
export interface Project {
  readonly file: string;
  /** The folder craftos.json is in: its paths are relative to it. */
  readonly dir: string;
  readonly data: ProjectFile;
}

const KEYS = [
  "$schema",
  "workspace",
  "minecraft",
  "addons",
  "tests",
  "world",
  "run",
];

/** Read a craftos.json. Throws with the file's name when it is not JSON or not an object. */
export function readProject(file: string): Project {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}: ${(error as Error).message}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error(`${file}: must be a JSON object`);
  return { file, dir: dirname(file), data: data as ProjectFile };
}

/** The craftos.json for a folder: CRAFTOS_PROJECT_FILE, else the nearest one upwards, up to the folder with a .git. */
export function findProject(
  start: string,
  env: NodeJS.ProcessEnv = process.env,
): Project | undefined {
  const named = env["CRAFTOS_PROJECT_FILE"]?.trim();
  if (named === "off") return undefined;
  if (named) return readProject(resolve(named));
  for (let dir = resolve(start); ; ) {
    const file = join(dir, PROJECT_FILE);
    if (existsSync(file)) return readProject(file);
    if (existsSync(join(dir, ".git"))) return undefined;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** What is wrong with a craftos.json, one line each; empty when nothing is. With `dir`, paths must exist too. */
export function checkProject(data: unknown, dir?: string): string[] {
  if (!data || typeof data !== "object" || Array.isArray(data))
    return ["craftos.json must be a JSON object"];
  const p = data as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(p))
    if (!KEYS.includes(key)) {
      const hint = didYouMean(key, KEYS.slice(1));
      errors.push(
        `unknown key "${key}"${hint ? ` (did you mean "${hint}"?)` : ""}; craftos.json takes ${KEYS.slice(1).join(", ")}`,
      );
    }
  const str = (key: string): string | undefined => {
    const v = p[key];
    if (v === undefined) return undefined;
    if (typeof v !== "string" || !v.trim()) {
      errors.push(`${key} must be a non-empty string`);
      return undefined;
    }
    return v;
  };
  const workspace = str("workspace");
  if (workspace && dir && !isDir(resolve(dir, workspace)))
    errors.push(`workspace: ${resolve(dir, workspace)} is not a folder`);
  const mc = str("minecraft");
  if (mc && !VERSIONS.some((v) => v.mc === mc))
    errors.push(
      `minecraft: unknown version ${JSON.stringify(mc)}; known: ${VERSIONS.map((v) => v.mc).join(", ")}`,
    );
  const addons = p["addons"];
  if (addons !== undefined) {
    if (
      typeof addons !== "string" &&
      !(Array.isArray(addons) && addons.every((a) => typeof a === "string"))
    )
      errors.push('addons must be "all", "none", ids by commas or a list');
    else
      try {
        resolveAddons(
          addons as string | string[],
          {},
          mc && VERSIONS.some((v) => v.mc === mc) ? mc : undefined,
          "craftos.json",
        );
      } catch (error) {
        errors.push(`addons: ${(error as Error).message}`);
      }
  }
  const tests = p["tests"];
  if (
    tests !== undefined &&
    !(
      Array.isArray(tests) &&
      tests.every((t) => typeof t === "string" && t.trim())
    )
  )
    errors.push('tests must be a list of globs, like ["tests/**/*.test.lua"]');
  const world = str("world");
  if (
    world &&
    dir &&
    /\.json$/i.test(world) &&
    !existsSync(resolve(dir, world))
  )
    errors.push(`world: no file ${resolve(dir, world)}`);
  str("run");
  return errors;
}

/** The project's workspace folder, absolute; undefined when craftos.json names none. */
export function projectWorkspace(project: Project): string | undefined {
  const w = project.data.workspace;
  return typeof w === "string" && w.trim()
    ? resolve(project.dir, w)
    : undefined;
}

/**
 * The project's world: an absolute path for a .json file, else the saved world's name as it is. Undefined when
 * craftos.json names none.
 */
export function projectWorld(project: Project): string | undefined {
  const w = project.data.world;
  if (typeof w !== "string" || !w.trim()) return undefined;
  return /\.json$/i.test(w) && !isAbsolute(w) ? resolve(project.dir, w) : w;
}

/**
 * The environment variables craftos.json stands in for, where the environment does not set them already:
 * CRAFTOS_WORKSPACE, CRAFTOS_VERSION and CRAFTOS_ADDONS.
 */
export function projectEnv(
  project: Project | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (!project) return {};
  const out: Record<string, string> = {};
  const unset = (key: string) => env[key] === undefined || env[key] === "";
  const workspace = projectWorkspace(project);
  if (workspace && unset("CRAFTOS_WORKSPACE"))
    out["CRAFTOS_WORKSPACE"] = workspace;
  const { minecraft, addons } = project.data;
  if (typeof minecraft === "string" && minecraft && unset("CRAFTOS_VERSION"))
    out["CRAFTOS_VERSION"] = minecraft;
  if (addons !== undefined && unset("CRAFTOS_ADDONS")) {
    out["CRAFTOS_ADDONS"] = Array.isArray(addons)
      ? addons.length
        ? addons.join(",")
        : "none"
      : String(addons);
    // so a message about the mods names craftos.json, not a variable the person never set (addons.ts addonSource)
    out[ADDONS_FROM_ENV] = project.file;
  }
  return out;
}

/** A glob as a RegExp over /-separated paths: `**` any folders, `*` and `?` within one name, `{a,b}` either. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  const g = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        i++;
        if (g[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = g.indexOf("}", i);
      if (end < 0) re += "\\{";
      else {
        re += `(?:${g
          .slice(i + 1, end)
          .split(",")
          .map((part) => part.replace(/[.+^$()|[\]\\]/g, "\\$&"))
          .join("|")})`;
        i = end;
      }
    } else re += c.replace(/[.+^$()|[\]\\}]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** The test files of `all` (workspace paths) that a project's globs pick. */
export function filterByGlobs(
  all: readonly string[],
  globs: readonly string[],
): string[] {
  const res = globs.map(globToRegExp);
  return all.filter((file) => res.some((re) => re.test(file)));
}

/** JSON Schema (draft-07) of craftos.json: schemas/craftos.schema.json. */
export function projectSchema(): Record<string, unknown> {
  const ids = ADDONS.map((a) => a.id);
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://raw.githubusercontent.com/Akkiruk/craftos-mcp/main/schemas/craftos.schema.json",
    title: "craftos-mcp project",
    description:
      "craftos.json: a project's settings for craftos-mcp (the CLI, the MCP server and the VS Code extension). A flag or an environment variable still wins over it. craftos-mcp init writes one; schemas/craftos.schema.json is generated from packages/runner/src/project.ts.",
    type: "object",
    additionalProperties: false,
    properties: {
      $schema: {
        description: "The JSON Schema of this file, for editors.",
        type: "string",
      },
      workspace: {
        description:
          "The folder with the Lua programs, relative to craftos.json: every computer gets a copy of it. Default: the folder craftos.json is in. --dir and CRAFTOS_WORKSPACE win over it.",
        type: "string",
        minLength: 1,
        examples: ["src", "."],
      },
      minecraft: {
        description:
          "The Minecraft version computers run as; it picks the CC:Tweaked version and the mods' versions. --mc, CRAFTOS_VERSION and a world's version win over it.",
        enum: VERSIONS.map((v) => v.mc),
      },
      addons: {
        description:
          'The mods besides CC:Tweaked: "all", "none", ids by commas, or a list of ids. --addons, CRAFTOS_ADDONS and a world\'s addons win over it.',
        oneOf: [
          { type: "string", minLength: 1, examples: ["all", "none"] },
          { type: "array", items: { enum: ids }, uniqueItems: true },
        ],
      },
      tests: {
        description:
          "The test files to run when none are named: globs relative to the workspace (** any folders, * any name, {a,b} either).",
        type: "array",
        items: { type: "string", minLength: 1 },
        examples: [["tests/**/*.test.lua"]],
      },
      world: {
        description:
          "The world computers start in: a .json file relative to craftos.json, or the name of a saved world in worlds/. --world, worldFile and world win over it.",
        type: "string",
        minLength: 1,
        examples: ["default.world.json"],
      },
      run: {
        description:
          "The program the desktop app's Run button starts, relative to the workspace. Leave it out and the computer opens at its shell.",
        type: "string",
        minLength: 1,
        examples: ["startup.lua"],
      },
    },
  };
}
