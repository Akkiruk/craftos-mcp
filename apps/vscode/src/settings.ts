// The extension's settings, and the environment, command and folders they make.
import { statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import * as vscode from "vscode";
import { baseCommand, fallbackFor, missingVersion } from "./launcher";
import { packEnv } from "./pack";

export type RegisterServer = "auto" | "always" | "never";

export function settings(scope?: vscode.Uri) {
  const c = vscode.workspace.getConfiguration("craftos-mcp", scope);
  return {
    command: c.get<string[]>("command", []),
    addons: c.get<string>("addons", "").trim(),
    mc: c.get<string>("minecraftVersion", "").trim(),
    testTimeout: c.get<number>("testTimeout", 60),
    workspace: c.get<string>("workspace", "").trim(),
    registerServer: c.get<RegisterServer>("registerServer", "auto"),
  };
}

/** Set once npm has said the pinned version does not exist: every later start uses the release before it. */
let pinMissing = false;

/** craftos-mcp, as a command and its arguments (without the subcommand). */
export function base(): string[] {
  const pinned = baseCommand(settings().command);
  return (pinMissing && fallbackFor(pinned)) || pinned;
}

/**
 * After a failed start: if npm said the pinned version is missing and the default command is in use, switch to the
 * fallback and return true (start again). Also called when the MCP server's supervisor fell back on its own.
 */
export function noteMissingVersion(output: string): boolean {
  if (pinMissing || !missingVersion(output)) return false;
  if (!fallbackFor(baseCommand(settings().command))) return false;
  pinMissing = true;
  return true;
}

/** The MCP server's supervisor fell back to the release before the pin: the tests and the app follow it. */
export function usePinFallback(): void {
  if (fallbackFor(baseCommand(settings().command))) pinMissing = true;
}

/** The variables the settings add to craftos-mcp's environment. */
export function settingsEnv(): Record<string, string> {
  return packEnv(settings());
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function inside(folder: string, path: string): boolean {
  const rel = relative(folder, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The folder craftos-mcp.workspace names for a workspace folder, if it is set and exists. `problem` says why a set
 * value was not used.
 */
export function configuredWorkspace(folder: vscode.WorkspaceFolder): {
  dir?: string;
  problem?: string;
} {
  const value = settings(folder.uri).workspace;
  if (!value) return {};
  const dir = resolve(folder.uri.fsPath, value);
  if (!isDir(dir))
    return {
      problem: `craftos-mcp.workspace is "${value}", but ${dir} is not a folder: using ${folder.uri.fsPath}`,
    };
  return { dir };
}

/** The MCP server's workspace: craftos-mcp.workspace in the first folder, else the folder itself. */
export function serverWorkspace(folder: vscode.WorkspaceFolder): string {
  return configuredWorkspace(folder).dir ?? folder.uri.fsPath;
}

/** craftos-mcp.workspace's folder if the file is inside it. */
function settingFolderFor(uri: vscode.Uri): string | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  const dir = folder && configuredWorkspace(folder).dir;
  return dir && inside(dir, uri.fsPath) ? dir : undefined;
}

/** Tests: craftos-mcp.workspace if the file is in it, else its workspace folder, else its own folder. */
export function projectFolder(uri: vscode.Uri): string {
  return (
    settingFolderFor(uri) ??
    vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ??
    dirname(uri.fsPath)
  );
}

/**
 * Run in CraftOS: craftos-mcp.workspace if the file is in it, else the program's own folder. Never the whole repo,
 * which the emulator would copy into the computer.
 */
export function runFolder(uri: vscode.Uri): string {
  return settingFolderFor(uri) ?? dirname(uri.fsPath);
}
