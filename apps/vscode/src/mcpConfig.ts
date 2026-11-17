// MCP config for other clients, without vscode (the unit tests load it in plain Node): the command Claude Code gets on
// Windows, and merging a server into a Cursor or Windsurf mcp.json without touching what is already there.
import { homedir } from "node:os";
import { join } from "node:path";
import { needsCmd } from "./launcher.ts";
import { stripJsonc } from "./projectScan.ts";

/**
 * The command line Claude Code should keep. On native Windows it starts servers without a shell, so a .cmd such as
 * npx needs `cmd /c` in front (as Claude Code's own docs say); elsewhere it is unchanged.
 */
export function claudeCodeCommand(
  command: readonly string[],
  platform = process.platform,
): string[] {
  const [first] = command;
  if (first && needsCmd(first, platform)) return ["cmd", "/c", ...command];
  return [...command];
}

export interface EditorTarget {
  /** Shown in messages: "Cursor", "Windsurf". */
  readonly editor: string;
  /** Where the config goes: a project file, or the user's own. */
  readonly scope: "project" | "user";
  readonly file: string;
}

/** Which MCP-less fork this is, from vscode.env.appName; undefined for VS Code itself and anything else. */
export function editorKind(appName: string): "cursor" | "windsurf" | undefined {
  if (/cursor/i.test(appName)) return "cursor";
  if (/windsurf/i.test(appName)) return "windsurf";
  return undefined;
}

/** Where Cursor and Windsurf read MCP servers from. Windsurf has no per-project file. */
export function editorTargets(
  kind: "cursor" | "windsurf",
  folder: string | undefined,
  home = homedir(),
): EditorTarget[] {
  if (kind === "cursor")
    return [
      ...(folder
        ? [
            {
              editor: "Cursor",
              scope: "project" as const,
              file: join(folder, ".cursor", "mcp.json"),
            },
          ]
        : []),
      {
        editor: "Cursor",
        scope: "user",
        file: join(home, ".cursor", "mcp.json"),
      },
    ];
  return [
    {
      editor: "Windsurf",
      scope: "user",
      file: join(home, ".codeium", "windsurf", "mcp_config.json"),
    },
  ];
}

export type MergeResult =
  | { status: "added"; text: string }
  | { status: "exists" }
  | { status: "unreadable"; why: string };

/**
 * Add `name` to the `mcpServers` of a config (undefined: no file yet). Never overwrites: an entry by that name stays as
 * it is, and a file that does not parse is left alone.
 */
export function mergeMcpServer(
  text: string | undefined,
  name: string,
  server: Record<string, unknown>,
): MergeResult {
  let json: Record<string, unknown> = {};
  if (text !== undefined && text.trim()) {
    try {
      const parsed: unknown = JSON.parse(stripJsonc(text));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return { status: "unreadable", why: "it is not a JSON object" };
      json = parsed as Record<string, unknown>;
    } catch (error) {
      return { status: "unreadable", why: (error as Error).message };
    }
  }
  const servers = json["mcpServers"];
  if (
    servers !== undefined &&
    (typeof servers !== "object" || servers === null || Array.isArray(servers))
  )
    return { status: "unreadable", why: "its mcpServers is not an object" };
  const own = (servers ?? {}) as Record<string, unknown>;
  if (name in own) return { status: "exists" };
  json["mcpServers"] = { ...own, [name]: server };
  return { status: "added", text: `${JSON.stringify(json, null, 2)}\n` };
}
