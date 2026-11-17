// The files a browser computer gets, read through vscode.workspace.fs (so a GitHub repository on vscode.dev works as
// well as a local folder): the program's folder, or craftos-mcp.workspace when the program is inside it, as Run in
// CraftOS does on the desktop (settings.ts runFolder).
import * as vscode from "vscode";
import type { CartFile } from "./cart";

/** Limits that keep a big folder from freezing the page: the desktop copies everything, the browser keeps it in memory. */
const MAX_FILES = 2000;
const MAX_BYTES = 32 * 1024 * 1024;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".vscode",
  ".vscode-test",
  ".vscode-test-web",
  "dist",
  "out",
]);

/** The folder (as a URI) whose files the computer gets for this program. */
export function runFolder(program: vscode.Uri): vscode.Uri {
  const folder = vscode.workspace.getWorkspaceFolder(program);
  const dir = program.with({
    path: program.path.replace(/\/[^/]*$/, "") || "/",
  });
  if (!folder) return dir;
  const value = vscode.workspace
    .getConfiguration("craftos-mcp", folder.uri)
    .get<string>("workspace", "")
    .trim();
  if (!value) return dir;
  // a workspace folder can be a bare authority (vscode-test-web://mount), which joinPath refuses
  const root = folder.uri.path ? folder.uri : folder.uri.with({ path: "/" });
  const setting = vscode.Uri.joinPath(root, value);
  const base = setting.path.replace(/\/$/, "");
  return program.path.startsWith(`${base}/`)
    ? setting.with({ path: base })
    : dir;
}

/** `file`'s path below `folder`, with forward slashes. */
export function relativePath(folder: vscode.Uri, file: vscode.Uri): string {
  const base = folder.path.replace(/\/$/, "");
  return file.path.startsWith(`${base}/`)
    ? file.path.slice(base.length + 1)
    : file.path.replace(/^.*\//, "");
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Text as text, anything with a NUL or not UTF-8 as base64 (web/build-carts.mjs exampleFiles's rule). */
export function cartFile(bytes: Uint8Array): CartFile {
  if (!bytes.includes(0))
    try {
      return utf8.decode(bytes);
    } catch {
      // not UTF-8
    }
  return { base64: toBase64(bytes) };
}

export interface ReadFolder {
  files: Record<string, CartFile>;
  /** Set when a limit stopped the walk. */
  truncated?: string;
}

export async function readFolder(folder: vscode.Uri): Promise<ReadFolder> {
  const files: Record<string, CartFile> = {};
  let count = 0;
  let bytes = 0;
  let truncated: string | undefined;
  const walk = async (dir: vscode.Uri, prefix: string): Promise<void> => {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return;
    }
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [name, type] of entries) {
      if (truncated) return;
      const uri = vscode.Uri.joinPath(dir, name);
      if (type & vscode.FileType.Directory) {
        if (!SKIP_DIRS.has(name)) await walk(uri, `${prefix}${name}/`);
        continue;
      }
      if (!(type & vscode.FileType.File)) continue;
      const data = await vscode.workspace.fs.readFile(uri);
      if (++count > MAX_FILES || bytes + data.length > MAX_BYTES) {
        truncated = `the folder has more than ${MAX_FILES} files or ${MAX_BYTES / 1024 / 1024} MB; set craftos-mcp.workspace to a smaller folder`;
        return;
      }
      bytes += data.length;
      files[`${prefix}${name}`] = cartFile(data);
    }
  };
  await walk(folder, "");
  return truncated ? { files, truncated } : { files };
}

/** `name.world.json` next to `name.lua` or `name.test.lua`, parsed, if there is one. */
export async function readWorld(
  program: vscode.Uri,
): Promise<Record<string, unknown> | undefined> {
  if (!/\.lua$/i.test(program.path)) return undefined;
  const uri = program.with({
    path: program.path.replace(/(\.test)?\.lua$/i, ".world.json"),
  });
  let data: Uint8Array;
  try {
    data = await vscode.workspace.fs.readFile(uri);
  } catch {
    return undefined;
  }
  const value = JSON.parse(new TextDecoder().decode(data)) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${uri.path.replace(/^.*\//, "")} is not a JSON object`);
  return value as Record<string, unknown>;
}
