// The MCP server for VS Code itself, and the commands that hand it to other clients (Claude Code, a JSON snippet).
import * as vscode from "vscode";
import {
  EXTERNAL_BASE,
  NPM_PACKAGE,
  commandMissing,
  launchFor,
  spawnCommand,
} from "./launcher";
import { base, settings, settingsEnv } from "./settings";

export const PROVIDER_ID = "craftos-mcp.server";

/** The stdio server VS Code starts: craftos-mcp serve, in the first workspace folder. */
export function serverDefinition(): vscode.McpStdioServerDefinition {
  const launch = launchFor(base(), ["serve"]);
  const folder = vscode.workspace.workspaceFolders?.[0];
  const env: Record<string, string> = { ...settingsEnv() };
  if (folder) env["CRAFTOS_WORKSPACE"] = folder.uri.fsPath;
  const def = new vscode.McpStdioServerDefinition(
    "craftos-mcp",
    launch.command,
    launch.args,
    env,
    // a different command or setting is a different server: VS Code offers to refresh its tools
    `${NPM_PACKAGE} ${JSON.stringify([launch, env])}`,
  );
  if (folder) def.cwd = folder.uri;
  return def;
}

export function registerServer(
  context: vscode.ExtensionContext,
): vscode.EventEmitter<void> {
  const changed = new vscode.EventEmitter<void>();
  context.subscriptions.push(
    changed,
    vscode.workspace.onDidChangeWorkspaceFolders(() => changed.fire()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("craftos-mcp")) changed.fire();
    }),
  );
  // VS Code forks without the MCP API still get the rest of the extension
  if (typeof vscode.lm?.registerMcpServerDefinitionProvider === "function")
    context.subscriptions.push(
      vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, {
        onDidChangeMcpServerDefinitions: changed.event,
        provideMcpServerDefinitions: () => [serverDefinition()],
      }),
    );
  return changed;
}

/** The command other clients keep: the configured one, else unpinned npx (it outlives this extension's updates). */
function externalCommand(): string[] {
  const own = settings().command;
  return [...(own.length ? own : EXTERNAL_BASE), "serve"];
}

function pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length <= 1) return Promise.resolve(folders[0]);
  return Promise.resolve(
    vscode.window.showWorkspaceFolderPick({
      placeHolder: "Which project should Claude Code use craftos-mcp in?",
    }),
  );
}

const CLAUDE_INSTALL = "https://docs.claude.com/en/docs/claude-code/setup";

export async function addToClaudeCode(
  output: vscode.OutputChannel,
): Promise<void> {
  const scope = await vscode.window.showQuickPick(
    [
      {
        label: "local",
        description: "this project, just for you (Claude Code's default)",
      },
      {
        label: "project",
        description: "this project, in .mcp.json, for everyone on the repo",
      },
      { label: "user", description: "every project you open" },
    ],
    { placeHolder: "Where should Claude Code keep the craftos server?" },
  );
  if (!scope) return;
  const folder = await pickFolder();
  const env = settingsEnv();
  const args = [
    "mcp",
    "add",
    "--scope",
    scope.label,
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    "craftos",
    "--",
    ...externalCommand(),
  ];
  const line = `claude ${args.join(" ")}`;
  output.appendLine(`> ${line}`);
  const result = await new Promise<{
    code: number | null;
    text: string;
    error?: NodeJS.ErrnoException;
  }>((done) => {
    let text = "";
    let child;
    try {
      child = spawnCommand(["claude"], args, {
        ...(folder ? { cwd: folder.uri.fsPath } : {}),
      });
    } catch (error) {
      done({ code: null, text, error: error as NodeJS.ErrnoException });
      return;
    }
    child.stdin?.end();
    child.stdout?.on("data", (c: Buffer) => (text += c.toString()));
    child.stderr?.on("data", (c: Buffer) => (text += c.toString()));
    child.on("error", (error) => done({ code: null, text, error }));
    child.on("close", (code) => done({ code, text }));
  });
  output.appendLine(result.text.trim());
  if (result.code === 0) {
    void vscode.window.showInformationMessage(
      `craftos-mcp added to Claude Code (${scope.label} scope). Start Claude Code in this folder, or run /mcp in a running one, to use it.`,
    );
    return;
  }
  if (commandMissing(result.code, result.text, result.error)) {
    const pick = await vscode.window.showErrorMessage(
      "Claude Code's `claude` command was not found. Install Claude Code (or put `claude` on your PATH), then run this again.",
      "How to Install",
      "Copy Command",
    );
    if (pick === "How to Install")
      await vscode.env.openExternal(vscode.Uri.parse(CLAUDE_INSTALL));
    if (pick === "Copy Command") await vscode.env.clipboard.writeText(line);
    return;
  }
  const pick = await vscode.window.showErrorMessage(
    `claude mcp add failed: ${result.text.trim().split("\n").pop() || `exit code ${result.code}`}`,
    "Show Log",
  );
  if (pick) output.show();
}

/** The JSON other MCP clients take, in the shapes they use. */
export function mcpJson(kind: "mcpServers" | "vscode"): string {
  const [command, ...args] = externalCommand();
  const env = settingsEnv();
  const server: Record<string, unknown> = { command, args };
  if (Object.keys(env).length) server["env"] = env;
  if (kind === "vscode")
    return JSON.stringify(
      { servers: { craftos: { type: "stdio", ...server } } },
      null,
      2,
    );
  return JSON.stringify({ mcpServers: { craftos: server } }, null, 2);
}

export async function copyMcpJson(): Promise<void> {
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: "mcpServers",
        description: "Claude Desktop, Cursor, Windsurf and most other clients",
        format: "mcpServers" as const,
      },
      {
        label: "servers",
        description: "VS Code's own .vscode/mcp.json",
        format: "vscode" as const,
      },
    ],
    { placeHolder: "Which client's config format?" },
  );
  if (!pick) return;
  await vscode.env.clipboard.writeText(mcpJson(pick.format));
  void vscode.window.showInformationMessage(
    "craftos-mcp server JSON copied. Paste it into your client's MCP config.",
  );
}
