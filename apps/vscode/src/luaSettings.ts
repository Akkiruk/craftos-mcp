// The Lua language server settings for the CC:Tweaked types, worked out without vscode (the unit tests load this in
// plain Node): what to write into a workspace, what to take out again, and whether a folder looks like CC code.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Our library folder, wherever it was copied: `.../lua-addons/cc-tweaked/library`. */
export function isOurLibrary(path: string): boolean {
  return /[\\/]lua-addons[\\/]cc-tweaked[\\/]library[\\/]?$/.test(path);
}

/** What a workspace has now. `version` is set when a workspace or folder value exists, whatever it is. */
export interface LuaSettingsNow {
  library?: readonly string[];
  version?: string;
  builtin?: Readonly<Record<string, string>>;
}

/** What the addon wants (config.json `settings`). */
export interface LuaSettingsWanted {
  library: string;
  version?: string;
  builtin?: Readonly<Record<string, string>>;
}

/** The writes to make: a key is there only when it has to change. */
export interface LuaSettingsWrites {
  library?: string[];
  version?: string;
  builtin?: Record<string, string>;
}

/**
 * Add ours, never replace: our library goes at the end of the list once (an older copy of ours elsewhere is dropped),
 * the runtime version only where the user has none, and each builtin key only where the user has not set it.
 */
export function planLuaSettings(
  now: LuaSettingsNow,
  wanted: LuaSettingsWanted,
): LuaSettingsWrites {
  const writes: LuaSettingsWrites = {};
  const current = [...(now.library ?? [])];
  const library = [
    ...current.filter((p) => !isOurLibrary(p) || p === wanted.library),
    ...(current.includes(wanted.library) ? [] : [wanted.library]),
  ];
  if (library.join("\n") !== current.join("\n")) writes.library = library;
  if (now.version === undefined && wanted.version)
    writes.version = wanted.version;
  if (wanted.builtin) {
    const theirs = now.builtin ?? {};
    if (Object.keys(wanted.builtin).some((key) => !(key in theirs)))
      writes.builtin = { ...theirs, ...wanted.builtin, ...theirs };
  }
  return writes;
}

/** The library list with every copy of ours taken out, or undefined when there was none. */
export function withoutOurLibrary(
  library: readonly string[] | undefined,
): string[] | undefined {
  if (!library?.some(isOurLibrary)) return undefined;
  return library.filter((p) => !isOurLibrary(p));
}

/** The values to write, from the addon's config.json. */
export function addonSettings(
  configJson: string,
): Omit<LuaSettingsWanted, "library"> {
  const settings =
    (JSON.parse(configJson) as { settings?: Record<string, unknown> })
      .settings ?? {};
  const version = settings["Lua.runtime.version"];
  const builtin = settings["Lua.runtime.builtin"];
  return {
    version: typeof version === "string" ? version : undefined,
    builtin:
      builtin && typeof builtin === "object"
        ? (builtin as Record<string, string>)
        : undefined,
  };
}

/** Lines that only a ComputerCraft program has. */
const CC_WORDS =
  /\b(?:os\.pullEvent\w*|os\.queueEvent|peripheral\.(?:wrap|find)|term\.set(?:CursorPos|TextColou?r|BackgroundColou?r)|textutils\.\w+|rednet\.\w+|turtle\.\w+|colou?rs\.[a-z]+|ccunit\.\w+)|require\s*\(?\s*["']cc\./;

const SKIP = new Set(["node_modules", ".git", ".runtime"]);

/**
 * Whether a folder holds ComputerCraft code: a `.craftos` folder, a `startup.lua`, a `*.test.lua` or `*.world.json`,
 * or a `.lua` file with a CC call in it. Looks breadth first through at most `limit` folders and reads at most 40
 * Lua files, so a big repo costs little.
 */
export function isCcProject(root: string, limit = 400): boolean {
  const queue = [root];
  let read = 0;
  for (let seen = 0; queue.length && seen < limit; seen++) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const name = e.name.toLowerCase();
      if (e.isDirectory()) {
        if (name === ".craftos") return true;
        if (!SKIP.has(name) && !name.startsWith("."))
          queue.push(join(dir, e.name));
        continue;
      }
      if (
        name === "startup.lua" ||
        name.endsWith(".test.lua") ||
        name.endsWith(".world.json")
      )
        return true;
      if (name.endsWith(".lua") && read < 40) {
        read++;
        try {
          if (
            CC_WORDS.test(
              readFileSync(join(dir, e.name), "utf8").slice(0, 65536),
            )
          )
            return true;
        } catch {
          // unreadable: not ours to judge
        }
      }
    }
  }
  return false;
}
