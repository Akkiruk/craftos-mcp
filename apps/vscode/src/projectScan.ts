// Looks at a project folder without vscode (the unit tests load it in plain Node): is it a big repo whose Lua lives
// in one subfolder (suggest that as craftos-mcp.workspace), and does its .vscode/mcp.json already run a craftos server.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** More files than this and the folder counts as big: the emulator copies its workspace into every computer. */
export const BIG_PROJECT_FILES = 3000;

/** Folder names that usually hold a project's ComputerCraft code, best first. */
const CANDIDATES = [
  "workspace",
  "computercraft",
  "computer",
  "cc",
  "lua",
  "programs",
  "src",
  "scripts",
];

const SKIP = new Set([".git", "node_modules"]);

/** Count files under root, stopping at `limit`. */
export function countFiles(root: string, limit: number): number {
  let count = 0;
  const stack = [root];
  while (stack.length && count < limit) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) stack.push(join(dir, e.name));
      } else if (++count >= limit) break;
    }
  }
  return count;
}

/** Whether a folder has a .lua file somewhere inside (looked for breadth first, up to `limit` folders). */
export function hasLua(root: string, limit = 2000): boolean {
  const queue = [root];
  for (let seen = 0; queue.length && seen < limit; seen++) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !e.name.startsWith("."))
          queue.push(join(dir, e.name));
      } else if (e.name.toLowerCase().endsWith(".lua")) return true;
    }
  }
  return false;
}

/**
 * The subfolder to suggest as craftos-mcp.workspace, or undefined: only when root looks like a big project (it has
 * node_modules, or BIG_PROJECT_FILES files or more) and a folder such as workspace/ in it holds Lua.
 */
export function suggestWorkspace(root: string): string | undefined {
  const big =
    existsSync(join(root, "node_modules")) ||
    countFiles(root, BIG_PROJECT_FILES) >= BIG_PROJECT_FILES;
  if (!big) return undefined;
  return CANDIDATES.find((name) => hasLua(join(root, name)));
}

/** Folders the Testing view never looks in: copies of the project (scratch runs, agent worktrees) and dependencies. */
export const ALWAYS_SKIP = [
  ".git",
  "node_modules",
  ".runtime",
  ".claude/worktrees",
];

/** A VS Code exclude glob (`**`, `*`, `?`, `{a,b}`, `[abc]`) as a regular expression on a `/`-separated path. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      // **/ is any number of folders, a trailing ** anything at all
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i++;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") {
      re += "(?:";
      depth++;
    } else if (c === "}" && depth) {
      re += ")";
      depth--;
    } else if (c === "," && depth) re += "|";
    else if (c === "[") {
      const end = glob.indexOf("]", i);
      if (end < 0) re += "\\[";
      else {
        re += `[${glob
          .slice(i + 1, end)
          .replace(/^!/, "^")
          .replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else re += c.replace(/[.+^$()|\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

/**
 * Whether a workspace-relative path is excluded: by ALWAYS_SKIP, or by one of the globs (files.exclude and
 * search.exclude keys set to true), matched against the path and each folder above it.
 */
export function isExcluded(rel: string, globs: readonly RegExp[]): boolean {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  const path = parts.join("/");
  if (
    ALWAYS_SKIP.some(
      (s) => path === s || path.startsWith(`${s}/`) || path.includes(`/${s}/`),
    )
  )
    return true;
  for (let n = 1; n <= parts.length; n++) {
    const prefix = parts.slice(0, n).join("/");
    if (globs.some((g) => g.test(prefix))) return true;
  }
  return false;
}

/** JSON with comments and trailing commas (VS Code's .vscode/mcp.json) as plain JSON. */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      out += text.slice(start, ++i);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * The servers in a .vscode/mcp.json that run craftos: "craftos" in the name, command or args (not counting
 * ${workspaceFolder} or the folder's own path). Unreadable JSON names none.
 */
export function craftosServers(
  text: string,
  workspaceFolder: string,
): string[] {
  let json: unknown;
  try {
    json = JSON.parse(stripJsonc(text));
  } catch {
    return [];
  }
  const servers = (json as { servers?: unknown } | null)?.servers;
  if (!servers || typeof servers !== "object") return [];
  // the folder's own path does not count: a project kept in ~/craftos-stuff would match every server
  const fill = (s: unknown) =>
    typeof s === "string"
      ? s
          .replace(/\$\{workspaceFolder\}/g, "")
          .split(workspaceFolder)
          .join("")
      : "";
  return Object.entries(servers as Record<string, unknown>)
    .filter(([name, server]) => {
      const s = (server ?? {}) as { command?: unknown; args?: unknown };
      const args = Array.isArray(s.args) ? s.args : [];
      return [name, s.command, ...args].some((part) =>
        /craftos/i.test(fill(part)),
      );
    })
    .map(([name]) => name);
}

/** craftosServers for <folder>/.vscode/mcp.json, if it exists. */
export function craftosServersInFolder(folder: string): string[] {
  const file = join(folder, ".vscode", "mcp.json");
  try {
    return craftosServers(readFileSync(file, "utf8"), folder);
  } catch {
    return [];
  }
}

/**
 * Why a folder looks like a ComputerCraft project, or undefined when it does not: the MCP server registers only in
 * those unless craftos-mcp.registerServer says everywhere. Cheap on purpose (it runs whenever the definitions are
 * asked for): a craftos.json or a .craftos folder at the top, the CC:Tweaked types in the Lua settings, then a breadth
 * first look through at most `limit` folders for a .lua or .world.json file.
 */
export function ccProjectSign(root: string, limit = 2000): string | undefined {
  if (existsSync(join(root, "craftos.json"))) return "craftos.json";
  if (existsSync(join(root, ".craftos"))) return ".craftos";
  for (const file of [".vscode/settings.json", ".luarc.json"]) {
    try {
      if (
        /cc-tweaked|cc-types|craftos/i.test(
          readFileSync(join(root, file), "utf8"),
        )
      )
        return `the CC:Tweaked types in ${file}`;
    } catch {
      // no such file
    }
  }
  const queue = [root];
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
        if (!SKIP.has(e.name) && !name.startsWith("."))
          queue.push(join(dir, e.name));
      } else if (name.endsWith(".world.json")) return "a world file";
      else if (name.endsWith(".lua")) return "Lua files";
    }
  }
  return undefined;
}
