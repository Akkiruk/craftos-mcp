import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  ADDONS,
  DEFAULT_MC,
  PROJECT_FILE,
  type ProjectFile,
  VERSIONS,
  WorkspaceError,
  addonsFor,
  checkProject,
} from "@craftos-mcp/runner";
import type { Command } from "../command.js";
import { UsageError, guarded, parse } from "../shared.js";

const SCHEMA_URL =
  "https://raw.githubusercontent.com/Akkiruk/craftos-mcp/main/schemas/craftos.schema.json";

const USAGE = [
  "usage: craftos-mcp init [--yes] [--force] [--dir folder] [--workspace src] [--mc version] [--addons a,b]",
  "                        [--tests glob,glob] [--world file.json]",
  "",
  "Writes craftos.json in --dir (default: the current folder): the project's workspace folder, Minecraft version,",
  "mods, test globs and world file. Every craftos-mcp command, the MCP server and the VS Code extension read it; a",
  "flag or an environment variable still wins. It asks for what the flags leave out; --yes (or no terminal) takes",
  "the defaults: no mods and no world file. --force replaces a craftos.json that is there.",
].join("\n");

/** Up to `max` *.world.json files under a folder, for the world question's default. */
function worldFiles(dir: string, max = 5): string[] {
  const found: string[] = [];
  const walk = (d: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found.length >= max) return;
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const full = join(d, e.name);
      if (e.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (e.name.endsWith(".world.json"))
        found.push(relative(dir, full).split("\\").join("/"));
    }
  };
  walk(dir, 0);
  return found;
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** A mod by its id or its name, any case ("Advanced Peripherals" is advanced-peripherals); the word as given otherwise. */
function addonId(word: string): string {
  const w = word.trim().toLowerCase();
  const hit = ADDONS.find((a) => a.id === w || a.name.toLowerCase() === w);
  return hit ? hit.id : word.trim();
}

/** craftos.json from the answers: blank answers leave their key out (the default applies). */
export function projectFrom(answers: {
  workspace?: string;
  mc?: string;
  addons?: string;
  tests?: string;
  world?: string;
}): ProjectFile {
  const clean = (s: string | undefined) => s?.trim() || undefined;
  const tests = clean(answers.tests)
    ?.split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const addons = clean(answers.addons);
  const world = clean(answers.world);
  return {
    $schema: SCHEMA_URL,
    workspace: clean(answers.workspace) ?? ".",
    ...(clean(answers.mc) && { minecraft: clean(answers.mc)! }),
    ...(addons && {
      addons: /^(all|none)$/i.test(addons)
        ? addons.toLowerCase()
        : addons
            .split(",")
            .map((a) => a.trim())
            .filter(Boolean)
            .map(addonId),
    }),
    ...(tests?.length && { tests }),
    ...(world && world !== "none" && { world }),
  };
}

const init: Command = {
  name: "init",
  summary: "write a craftos.json project file (asks a few questions)",
  usage: USAGE,
  run: (args) =>
    guarded(USAGE, async () => {
      const { values } = parse(args, {
        yes: { type: "boolean", short: "y" },
        force: { type: "boolean" },
        workspace: { type: "string" },
        tests: { type: "string" },
      });
      if (values.help) {
        console.log(USAGE);
        return 0;
      }
      const v = values as typeof values & {
        yes?: boolean;
        force?: boolean;
        workspace?: string;
        tests?: string;
      };
      const root = resolve(values.dir ?? process.cwd());
      if (!isDir(root)) throw new UsageError(`no such folder: ${root}`);
      const file = join(root, PROJECT_FILE);
      if (existsSync(file) && !v.force)
        throw new WorkspaceError(
          `${file} is there already: --force replaces it`,
        );
      const worlds = worldFiles(root);
      const defaults = {
        workspace: v.workspace ?? (isDir(join(root, "src")) ? "src" : "."),
        mc: values.mc ?? DEFAULT_MC,
        // no mods unless named: a program then cannot lean on a mod the person's pack lacks
        addons: values.addons ?? "none",
        tests: v.tests ?? "**/*.test.lua",
        // never one picked for them: a world file found here is offered in the question, not taken
        world: values.world ?? "none",
      };
      const answers = { ...defaults };
      const ask = !v.yes && process.stdin.isTTY && process.stdout.isTTY;
      if (ask) {
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        const q = async (
          key: keyof typeof answers,
          question: string,
          given: string | undefined,
        ) => {
          if (given !== undefined) return;
          const a = (
            await rl.question(`${question} (${answers[key]}): `)
          ).trim();
          if (a) answers[key] = a;
        };
        try {
          await q("workspace", "Lua folder", v.workspace);
          await q(
            "mc",
            `Minecraft version, ${VERSIONS.map((x) => x.mc).join(" / ")}`,
            values.mc,
          );
          const mc = answers.mc;
          const known = VERSIONS.some((x) => x.mc === mc)
            ? addonsFor(mc)
            : ADDONS;
          console.log(
            `Mods for Minecraft ${mc}: ${known.map((a) => a.id).join(", ")}`,
          );
          await q(
            "addons",
            "Mods your pack has: none, all, or ids or names by commas",
            values.addons,
          );
          await q("tests", "Test files (globs by commas)", v.tests);
          await q(
            "world",
            `World file${worlds.length ? ` (found: ${worlds.join(", ")}; type one to use it)` : ""}, or none`,
            values.world,
          );
        } finally {
          rl.close();
        }
      }
      const data = projectFrom(answers);
      // the folder first, so the check finds it
      if (data.workspace)
        mkdirSync(resolve(root, data.workspace), { recursive: true });
      const errors = checkProject(data, root);
      if (errors.length)
        throw new UsageError(
          errors.length === 1 ? errors[0]! : `\n- ${errors.join("\n- ")}`,
        );
      writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
      console.log(`wrote ${file}`);
      console.log(
        "Next: craftos-mcp window (a computer in a window), craftos-mcp app (in your browser), craftos-mcp test.",
      );
      return 0;
    }),
};
export default init;
