// craftos.json, the project file `craftos-mcp init` writes (packages/runner/src/project.ts reads it for the CLI and
// the MCP server). Here it is the fallback under the extension's own settings: a setting someone set wins, then
// craftos.json, then the default. Found like the runner finds it: from a folder upwards, stopping at the folder with
// a .git.
//
// No vscode import: the unit tests load this file in plain Node.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const PROJECT_FILE = "craftos.json";

export interface ProjectSettings {
  /** The craftos.json this came from. */
  file: string;
  /** Its workspace folder, absolute. */
  workspace?: string;
  minecraft?: string;
  /** As craftos-mcp.addons takes it: "all", "none" or ids by commas. */
  addons?: string;
}

/** The nearest craftos.json from `start` upwards, or undefined (none, or one that is not a JSON object). */
export function findProjectFile(start: string): string | undefined {
  for (let dir = resolve(start); ; ) {
    const file = join(dir, PROJECT_FILE);
    if (existsSync(file)) return file;
    if (existsSync(join(dir, ".git"))) return undefined;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** What craftos.json says that the settings take. Anything unreadable or of the wrong type is left out. */
export function projectSettings(start: string): ProjectSettings | undefined {
  const file = findProjectFile(start);
  if (!file) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    return undefined;
  const p = data as Record<string, unknown>;
  const out: ProjectSettings = { file };
  if (typeof p["workspace"] === "string" && p["workspace"].trim())
    out.workspace = resolve(dirname(file), p["workspace"].trim());
  if (typeof p["minecraft"] === "string" && p["minecraft"].trim())
    out.minecraft = p["minecraft"].trim();
  const addons = p["addons"];
  if (typeof addons === "string" && addons.trim()) out.addons = addons.trim();
  else if (Array.isArray(addons) && addons.every((a) => typeof a === "string"))
    out.addons = addons.length ? addons.join(",") : "none";
  return out;
}

/** A setting as someone set it (in any scope), or undefined when it is at its default. Blank counts as unset. */
export function explicitValue<T>(
  inspected:
    | { globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T }
    | undefined,
): T | undefined {
  for (const v of [
    inspected?.workspaceFolderValue,
    inspected?.workspaceValue,
    inspected?.globalValue,
  ])
    if (v !== undefined && !(typeof v === "string" && v.trim() === ""))
      return v;
  return undefined;
}
