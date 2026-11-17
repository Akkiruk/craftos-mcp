// craftos-mcp in VS Code for the Web (vscode.dev, github.dev): package.json's `browser` entry. No Node, no npx, no
// child processes, so no MCP server, Testing view or MCP client setup (those commands are hidden with !isWeb). What
// is here: Run in CraftOS on the WebAssembly engine (run.ts), New Test / New World, and the static parts of
// package.json (snippets, the *.world.json schema, the walkthrough).
import * as vscode from "vscode";
import { runInBrowser, webPanels } from "./run";
import { registerWebScaffold } from "./scaffold";

/** What activate returns: the web tests use it. */
export interface CraftosWebApi {
  runInCraftOS: (uri: vscode.Uri) => ReturnType<typeof runInBrowser>;
  webPanels: typeof webPanels;
}

export function activate(context: vscode.ExtensionContext): CraftosWebApi {
  const output = vscode.window.createOutputChannel("craftos-mcp");
  const run = (uri?: vscode.Uri) => runInBrowser(uri, context, output);
  const status = vscode.window.createStatusBarItem(
    "craftos-mcp.status",
    vscode.StatusBarAlignment.Right,
    100,
  );
  status.name = "craftos-mcp";
  status.text = "$(terminal) CraftOS";
  status.tooltip =
    "craftos-mcp in the browser: Run in CraftOS runs the open .lua file on the WebAssembly engine";
  status.command = "craftos-mcp.menu";
  status.show();
  context.subscriptions.push(
    output,
    status,
    ...registerWebScaffold(context),
    vscode.commands.registerCommand(
      "craftos-mcp.runInCraftOS",
      (uri?: vscode.Uri) => run(uri),
    ),
    vscode.commands.registerCommand("craftos-mcp.showLog", () => output.show()),
    // The World Editor is desktop-only (it reads the folder's other world files with Node), but package.json makes it
    // the default editor for *.world.json everywhere: here it hands the file straight to the text editor.
    vscode.window.registerCustomEditorProvider("craftos-mcp.worldEditor", {
      async resolveCustomTextEditor(document, panel) {
        panel.webview.html =
          "<p>The World Editor needs the desktop VS Code; opening the JSON instead.</p>";
        await vscode.commands.executeCommand(
          "vscode.openWith",
          document.uri,
          "default",
          panel.viewColumn,
        );
        panel.dispose();
      },
    }),
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
    vscode.commands.registerCommand("craftos-mcp.menu", async () => {
      const items: (vscode.QuickPickItem & { command: string })[] = [
        {
          label: "$(play) Run in CraftOS",
          description: "the open .lua file",
          command: "craftos-mcp.runInCraftOS",
        },
        {
          label: "$(beaker) New Test for This File",
          command: "craftos-mcp.newTest",
        },
        {
          label: "$(globe) New World for This File",
          command: "craftos-mcp.newWorld",
        },
        { label: "$(output) Show Log", command: "craftos-mcp.showLog" },
        { label: "$(gear) Open Settings", command: "craftos-mcp.openSettings" },
        { label: "$(book) Get Started", command: "craftos-mcp.walkthrough" },
      ];
      const pick = await vscode.window.showQuickPick(items, {
        title:
          "craftos-mcp (browser: the MCP server and the Testing view need the desktop VS Code)",
      });
      if (pick) await vscode.commands.executeCommand(pick.command);
    }),
  );
  return { runInCraftOS: (uri) => run(uri), webPanels };
}

export function deactivate(): void {
  for (const p of webPanels()) p.panel.dispose();
}
