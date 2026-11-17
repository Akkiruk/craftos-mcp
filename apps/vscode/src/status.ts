// The status bar item: what the MCP server and the first-run setup are doing, and a menu of the extension's commands
// on click.
import * as vscode from "vscode";

export type ServerState =
  | { kind: "idle" }
  | { kind: "skipped"; why: string }
  | { kind: "setting-up"; detail: string }
  | { kind: "running"; command: string }
  | { kind: "restarting"; restarts: number }
  | { kind: "gave-up" }
  | { kind: "setup-failed"; why: string };

export class Status implements vscode.Disposable {
  readonly item: vscode.StatusBarItem;
  state: ServerState = { kind: "idle" };

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      "craftos-mcp.status",
      vscode.StatusBarAlignment.Left,
      0,
    );
    this.item.name = "craftos-mcp";
    this.item.command = "craftos-mcp.menu";
    this.show();
    this.item.show();
  }

  set(state: ServerState): void {
    this.state = state;
    this.show();
  }

  private show(): void {
    const s = this.state;
    const item = this.item;
    item.backgroundColor = undefined;
    const tip = (text: string) =>
      new vscode.MarkdownString(
        `**craftos-mcp**\n\n${text}\n\nClick for the craftos-mcp menu.`,
      );
    switch (s.kind) {
      case "idle":
        item.text = "$(circuit-board) CraftOS";
        item.tooltip = tip(
          "MCP server not started yet: VS Code starts it when an agent needs its tools.",
        );
        break;
      case "skipped":
        item.text = "$(circuit-board) CraftOS";
        item.tooltip = tip(`MCP server not registered: ${s.why}.`);
        break;
      case "setting-up":
        item.text = `$(sync~spin) CraftOS: setting up (${s.detail})`;
        item.tooltip = tip(
          "First run: downloading the engine and building the CC:Tweaked ROM. Once per version, about a minute.",
        );
        break;
      case "running":
        item.text = "$(circuit-board) CraftOS";
        item.tooltip = tip(`MCP server running: \`${s.command}\``);
        break;
      case "restarting":
        item.text = "$(sync~spin) CraftOS: restarting";
        item.tooltip = tip(
          `The MCP server stopped and is starting again (${s.restarts} of 3 in 2 minutes).`,
        );
        break;
      case "gave-up":
        item.text = "$(error) CraftOS: stopped";
        item.tooltip = tip(
          "The MCP server kept crashing and was not started again. Restart it from the menu.",
        );
        item.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.errorBackground",
        );
        break;
      case "setup-failed":
        item.text = "$(warning) CraftOS: setup failed";
        item.tooltip = tip(`First-run setup failed: ${s.why}`);
        item.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.warningBackground",
        );
        break;
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}

interface MenuItem extends vscode.QuickPickItem {
  command?: string;
}

/** The status bar's menu: the extension's commands, the ones that fit right now first. */
export async function showMenu(fork: boolean): Promise<void> {
  const lua = vscode.window.activeTextEditor?.document.uri.fsPath
    .toLowerCase()
    .endsWith(".lua");
  const items: MenuItem[] = [
    ...(lua
      ? [
          {
            label: "$(play) Run in CraftOS",
            description: "the open file",
            command: "craftos-mcp.runInCraftOS",
          },
        ]
      : []),
    ...(lua
      ? [
          {
            label: "$(beaker) New Test for This File",
            command: "craftos-mcp.newTest",
          },
        ]
      : []),
    {
      label: "$(debug-restart) Restart MCP Server",
      command: "craftos-mcp.restartServer",
    },
    { label: "$(output) Show Log", command: "craftos-mcp.showLog" },
    { label: "", kind: vscode.QuickPickItemKind.Separator },
    ...(fork
      ? [
          {
            label: "$(plug) Add to This Editor's MCP Config",
            description: "Cursor, Windsurf",
            command: "craftos-mcp.addToEditor",
          },
        ]
      : []),
    {
      label: "$(plug) Add to Claude Code",
      command: "craftos-mcp.addToClaudeCode",
    },
    {
      label: "$(copy) Copy MCP Server JSON",
      command: "craftos-mcp.copyMcpJson",
    },
    { label: "$(settings-gear) Settings", command: "craftos-mcp.openSettings" },
    { label: "$(book) Get Started", command: "craftos-mcp.walkthrough" },
  ];
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: "craftos-mcp",
  });
  if (pick?.command) await vscode.commands.executeCommand(pick.command);
}
