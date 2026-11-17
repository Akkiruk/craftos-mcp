// craftos-mcp for VS Code: the emulator's MCP server for VS Code's agents, Run in CraftOS, *.test.lua in the
// Testing view, and commands that set up other MCP clients.
import * as vscode from "vscode";
import {
  addToClaudeCode,
  copyMcpJson,
  mcpJson,
  registerServer,
  serverDefinition,
} from "./clients";
import { runInCraftOS, runningPanels, stopAll } from "./runPanel";
import { CraftosTests } from "./tests";

/** What activate returns: only the integration tests use it. */
export interface CraftosApi {
  tests: CraftosTests;
  serverDefinition: typeof serverDefinition;
  mcpJson: typeof mcpJson;
  runInCraftOS: (uri: vscode.Uri) => ReturnType<typeof runInCraftOS>;
  runningPanels: typeof runningPanels;
}

export function activate(context: vscode.ExtensionContext): CraftosApi {
  const output = vscode.window.createOutputChannel("craftos-mcp");
  const tests = new CraftosTests();
  registerServer(context);
  const run = (uri: vscode.Uri | undefined) =>
    runInCraftOS(uri, output, context.extensionUri);
  context.subscriptions.push(
    output,
    tests,
    vscode.commands.registerCommand(
      "craftos-mcp.runInCraftOS",
      (uri?: vscode.Uri) => run(uri),
    ),
    vscode.commands.registerCommand("craftos-mcp.addToClaudeCode", () =>
      addToClaudeCode(output),
    ),
    vscode.commands.registerCommand("craftos-mcp.copyMcpJson", copyMcpJson),
    vscode.commands.registerCommand("craftos-mcp.refreshTests", () =>
      tests.discover(),
    ),
  );
  void tests.discover();
  return {
    tests,
    serverDefinition,
    mcpJson,
    runInCraftOS: run,
    runningPanels,
  };
}

export function deactivate(): Promise<void> {
  return stopAll();
}
