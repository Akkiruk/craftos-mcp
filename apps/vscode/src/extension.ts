// craftos-mcp for VS Code: the emulator's MCP server for VS Code's agents, Run in CraftOS, *.test.lua in the
// Testing view, and commands that set up other MCP clients.
import * as vscode from "vscode";
import { addAgentInstructions } from "./agentDocsCommand";
import { registerLinksNotice } from "./linksNotice";
import { registerAgentView, watchAgents } from "./agentView";
import { registerDebugger } from "./debug/adapter";
import { addDebugProfile } from "./debug/testProfile";
import { firstRun } from "./firstRun";
import { registerLuaTypes } from "./luaTypes";
import { editorKind } from "./mcpConfig";
import { registerScaffold } from "./scaffold";
import { Status, menuItems, showMenu } from "./status";
import {
  addToClaudeCode,
  offerClaudeCode,
  addToEditor,
  copyMcpJson,
  hasMcpApi,
  mcpJson,
  providedDefinitions,
  registerServer,
  restartCommand,
  restartServer,
  serverDefinition,
  serverEvents,
  skipReason,
  viewerUrl,
} from "./clients";
import { suggestWorkspace } from "./projectScan";
import { oneAtATime } from "./prompts";
import { runInCraftOS, runningPanels, stopAll } from "./runPanel";
import { projectFolder, runFolder, settings } from "./settings";
import { CraftosTests } from "./tests";
import { registerDiagnostics } from "./diagnostics";
import { registerPackPicker } from "./packPicker";
import { registerRerunOnSave } from "./rerun";
import { type TestLensApi, registerTestLens } from "./testLens";
import {
  VIEW_TYPE,
  WorldEditorProvider,
  editDocument,
  lastRender,
} from "./worldEditor/provider";

/** What activate returns: only the integration tests use it. */
export interface CraftosApi {
  tests: CraftosTests;
  serverDefinition: typeof serverDefinition;
  providedDefinitions: typeof providedDefinitions;
  skipReason: typeof skipReason;
  serverEvents: typeof serverEvents;
  restartServer: typeof restartServer;
  mcpJson: typeof mcpJson;
  runFolder: typeof runFolder;
  projectFolder: typeof projectFolder;
  runInCraftOS: (uri: vscode.Uri) => ReturnType<typeof runInCraftOS>;
  runningPanels: typeof runningPanels;
  status: Status;
  /** The status bar menu's entries, for (another editor's fork, a Lua file open). */
  menuItems: typeof menuItems;
  testLens: TestLensApi;
  /** Watch the Agent's Computers, and the viewer address the server said. */
  watchAgents: () => ReturnType<typeof watchAgents>;
  viewerUrl: typeof viewerUrl;
  settings: typeof settings;
  /** The World Editor's view type, and the edit path its webview's changes take. */
  worldEditor: {
    viewType: string;
    edit: typeof editDocument;
    lastRender: typeof lastRender;
  };
}

const SUGGESTED = "craftos-mcp.workspaceSuggested";

/**
 * A big repo (node_modules, thousands of files) as the workspace makes every computer a copy of all of it. If its
 * Lua sits in workspace/ or the like, offer that folder once. Never set it without asking.
 */
async function offerWorkspace(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme !== "file") return;
  if (context.workspaceState.get(SUGGESTED)) return;
  const set = vscode.workspace
    .getConfiguration("craftos-mcp", folder.uri)
    .inspect<string>("workspace");
  if (
    set?.globalValue !== undefined ||
    set?.workspaceValue !== undefined ||
    set?.workspaceFolderValue !== undefined
  )
    return;
  // suggestWorkspace reads folders on the extension host's thread (160 ms in a big repo): only where there is Lua.
  // The MCP server's provider activates the extension in folders without any.
  const lua = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, "**/*.lua"),
    "**/node_modules/**",
    1,
  );
  if (!lua.length) return;
  const sub = suggestWorkspace(folder.uri.fsPath);
  if (!sub) return;
  await context.workspaceState.update(SUGGESTED, true);
  const use = `Use ${sub}/`;
  const pick = await oneAtATime(() =>
    vscode.window.showInformationMessage(
      `This folder is big, and the emulator copies its workspace into every computer it starts. Your Lua looks like it lives in ${sub}/. Use that as craftos-mcp's workspace? You can change it later in the craftos-mcp.workspace setting.`,
      use,
      "Keep the Whole Folder",
    ),
  );
  if (pick === use)
    await vscode.workspace
      .getConfiguration("craftos-mcp", folder.uri)
      .update("workspace", sub, vscode.ConfigurationTarget.WorkspaceFolder);
}

export function activate(context: vscode.ExtensionContext): CraftosApi {
  const output = vscode.window.createOutputChannel("craftos-mcp");
  const status = new Status();
  const tests = new CraftosTests();
  registerServer(context, output, status);
  registerLinksNotice(context);
  const fork = !hasMcpApi() || !!editorKind(vscode.env.appName);
  context.subscriptions.push(
    status,
    ...registerLuaTypes(context, output),
    ...registerScaffold(context),
    ...WorldEditorProvider.register(context),
    vscode.commands.registerCommand("craftos-mcp.menu", () => showMenu(fork)),
    vscode.commands.registerCommand("craftos-mcp.showLog", () => output.show()),
    vscode.commands.registerCommand("craftos-mcp.openSettings", () =>
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "@ext:Rogiedoji.craftos-mcp",
      ),
    ),
    vscode.commands.registerCommand("craftos-mcp.walkthrough", () =>
      vscode.commands.executeCommand(
        "workbench.action.openWalkthrough",
        "Rogiedoji.craftos-mcp#craftos-mcp.start",
        false,
      ),
    ),
    vscode.commands.registerCommand("craftos-mcp.addToEditor", () =>
      addToEditor(context, output, "command"),
    ),
    vscode.commands.registerCommand("craftos-mcp.addAgentInstructions", () =>
      addAgentInstructions(output),
    ),
    registerAgentView(output),
  );
  if (editorKind(vscode.env.appName))
    void addToEditor(context, output, "offer").catch((error: Error) =>
      output.appendLine(`editor MCP config: ${error.message}`),
    );
  if (!editorKind(vscode.env.appName))
    context.subscriptions.push(offerClaudeCode(context, output));
  void firstRun(context, output, status).catch((error: Error) =>
    output.appendLine(`first-run setup: ${error.message}`),
  );
  const run = (uri: vscode.Uri | undefined) =>
    runInCraftOS(uri, output, context.extensionUri);
  context.subscriptions.push(
    output,
    tests,
    // the debugger: the `craftos` debug type, Debug in CraftOS, and Debug in the Testing view
    ...registerDebugger(output, context.extensionUri),
    addDebugProfile(tests.controller),
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
    vscode.commands.registerCommand(
      "craftos-mcp.restartServer",
      restartCommand,
    ),
  );
  // the pack pickers, rerun on save, test CodeLens and failure marks, version-aware diagnostics
  const lens = registerTestLens(tests);
  context.subscriptions.push(
    ...registerPackPicker(),
    registerRerunOnSave(),
    ...lens.disposables,
    ...registerDiagnostics(),
  );
  void tests.discover();
  void offerWorkspace(context).catch((error: Error) =>
    output.appendLine(`workspace suggestion: ${error.message}`),
  );
  return {
    tests,
    serverDefinition,
    providedDefinitions,
    skipReason,
    serverEvents,
    restartServer,
    mcpJson,
    runFolder,
    projectFolder,
    runInCraftOS: run,
    runningPanels,
    status,
    menuItems,
    testLens: lens.api,
    watchAgents: () => watchAgents(output),
    viewerUrl,
    settings,
    worldEditor: { viewType: VIEW_TYPE, edit: editDocument, lastRender },
  };
}

export function deactivate(): Promise<void> {
  return stopAll();
}
