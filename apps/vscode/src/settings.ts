// The extension's settings, and the environment and command they make.
import * as vscode from "vscode";
import { baseCommand } from "./launcher";

export function settings() {
  const c = vscode.workspace.getConfiguration("craftos-mcp");
  return {
    command: c.get<string[]>("command", []),
    addons: c.get<string>("addons", "").trim(),
    mc: c.get<string>("minecraftVersion", "").trim(),
    testTimeout: c.get<number>("testTimeout", 60),
  };
}

/** craftos-mcp, as a command and its arguments (without the subcommand). */
export function base(): string[] {
  return baseCommand(settings().command);
}

/** The variables the settings add to craftos-mcp's environment. */
export function settingsEnv(): Record<string, string> {
  const s = settings();
  const env: Record<string, string> = {};
  if (s.addons) env["CRAFTOS_ADDONS"] = s.addons;
  if (s.mc) env["CRAFTOS_VERSION"] = s.mc;
  return env;
}

/** The folder a file belongs to: its workspace folder, else its own folder. */
export function projectFolder(uri: vscode.Uri): string {
  return (
    vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ??
    vscode.Uri.joinPath(uri, "..").fsPath
  );
}
