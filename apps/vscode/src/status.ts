// The status bar item: the pack computers run in (Minecraft version, addons), what the MCP server and the first-run
// setup are doing, and a menu of the extension's commands on click.
import * as vscode from "vscode";
import { addonCount, ccFor, packLabel } from "./pack";
import { PACK } from "./packData";
import { settings } from "./settings";

export type ServerState =
  | { kind: "idle" }
  | { kind: "skipped"; why: string }
  | { kind: "setting-up"; detail: string }
  | { kind: "running"; command: string }
  | { kind: "restarting"; restarts: number }
  | { kind: "gave-up" }
  | { kind: "setup-failed"; why: string };

/** "Minecraft 1.21.1 (CC:Tweaked 1.121.0), the default" for the settings as they are. */
function versionLine(): string {
  const s = settings();
  const mc = s.mc || PACK.newest;
  return `${mc} (CC:Tweaked ${ccFor(PACK, mc) ?? "?"})${s.mc ? "" : ", the default"}`;
}

function addonsLine(): string {
  const { on, available } = addonCount(PACK, settings());
  return `${on} of ${available} on`;
}

export class Status implements vscode.Disposable {
  readonly item: vscode.StatusBarItem;
  state: ServerState = { kind: "idle" };
  private readonly watch: vscode.Disposable;

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
    this.watch = vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("craftos-mcp.minecraftVersion") ||
        e.affectsConfiguration("craftos-mcp.addons")
      )
        this.show();
    });
  }

  set(state: ServerState): void {
    this.state = state;
    this.show();
  }

  private show(): void {
    const s = this.state;
    const item = this.item;
    item.backgroundColor = undefined;
    // without the pack data (a build from a bare checkout) the item is only the server's state
    const pack = PACK.versions.length ? ` ${packLabel(PACK, settings())}` : "";
    const packTip = PACK.versions.length
      ? `Computers start on Minecraft ${versionLine()}, addons: ${addonsLine()}.\n\n`
      : "";
    const tip = (text: string) =>
      new vscode.MarkdownString(
        `**craftos-mcp**\n\n${packTip}${text}\n\nClick for the menu: run, pick the version or the addons, restart the server.`,
      );
    switch (s.kind) {
      case "idle":
        item.text = `$(circuit-board) CraftOS${pack}`;
        item.tooltip = tip(
          "MCP server not started yet: VS Code starts it when an agent needs its tools.",
        );
        break;
      case "skipped":
        item.text = `$(circuit-board) CraftOS${pack}`;
        item.tooltip = tip(`MCP server not registered: ${s.why}.`);
        break;
      case "setting-up":
        item.text = `$(sync~spin) CraftOS: setting up (${s.detail})`;
        item.tooltip = tip(
          "First run: downloading the engine and building the CC:Tweaked ROM. Once per version, about a minute.",
        );
        break;
      case "running":
        item.text = `$(circuit-board) CraftOS${pack}`;
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
        item.tooltip = tip(
          `First-run setup failed: ${s.why}. It tries again on the next start; Show Log in the menu has the details.`,
        );
        item.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.warningBackground",
        );
        break;
    }
  }

  dispose(): void {
    this.watch.dispose();
    this.item.dispose();
  }
}

interface MenuItem extends vscode.QuickPickItem {
  command?: string;
}

const separator = (label: string): MenuItem => ({
  label,
  kind: vscode.QuickPickItemKind.Separator,
});

/** The status bar's menu: the extension's commands, the ones that fit the open file first. */
export function menuItems(fork: boolean, lua: boolean): MenuItem[] {
  return [
    ...(lua
      ? [
          {
            label: "$(play) Run in CraftOS",
            description: "the open file",
            command: "craftos-mcp.runInCraftOS",
          },
          {
            label: "$(debug-alt) Debug in CraftOS",
            description: "the open file",
            command: "craftos-mcp.debugInCraftOS",
          },
          {
            label: "$(beaker) New Test for This File",
            command: "craftos-mcp.newTest",
          },
          {
            label: "$(globe) New World for This File",
            command: "craftos-mcp.newWorld",
          },
        ]
      : []),
    ...(PACK.versions.length
      ? [
          separator("What computers run in"),
          {
            label: "$(versions) Minecraft Version",
            description: versionLine(),
            command: "craftos-mcp.pickMinecraftVersion",
          },
          {
            label: "$(extensions) Addons",
            description: addonsLine(),
            command: "craftos-mcp.pickAddons",
          },
        ]
      : []),
    separator("MCP server"),
    {
      label: "$(debug-restart) Restart MCP Server",
      command: "craftos-mcp.restartServer",
    },
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
    separator(""),
    { label: "$(output) Show Log", command: "craftos-mcp.showLog" },
    {
      label: "$(settings-gear) Open Settings",
      command: "craftos-mcp.openSettings",
    },
    { label: "$(book) Get Started", command: "craftos-mcp.walkthrough" },
  ];
}

export async function showMenu(fork: boolean): Promise<void> {
  const lua = !!vscode.window.activeTextEditor?.document.uri.fsPath
    .toLowerCase()
    .endsWith(".lua");
  const pick = await vscode.window.showQuickPick(menuItems(fork, lua), {
    title: "craftos-mcp",
    placeHolder: "Pick a command",
  });
  if (pick?.command) await vscode.commands.executeCommand(pick.command);
}
