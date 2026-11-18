// craftos-mcp: Watch the Agent's Computers. The MCP server's own viewer (the browser app over the sessions an agent
// is driving, apps/mcp-server/src/viewer.ts) in an editor panel: the agent's computers as tabs, live, and a person
// can type and touch next to it. The address is the one this editor's server said (clients.ts viewerUrl); without
// one (the server is another client's, Claude Code's say) it tries the default port.
import * as vscode from "vscode";
import { restartCommand, viewerUrl } from "./clients";
import { viewerHtml } from "./viewerPage";

/** CRAFTOS_VIEWER_PORT's default: where another client's server shows its viewer. */
const DEFAULT_VIEWER = "http://127.0.0.1:7878/";

let panel: vscode.WebviewPanel | undefined;

/** Whether a viewer answers there (a quick look, so a missing one is a message, not a blank panel). */
async function answers(url: string): Promise<boolean> {
  try {
    const res = await fetch(new URL("api/sessions", url), {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** The viewer's address: this editor's server's, else the default port if something answers there. */
export async function findViewer(): Promise<string | undefined> {
  const own = viewerUrl();
  if (own && (await answers(own))) return own;
  if (await answers(DEFAULT_VIEWER)) return DEFAULT_VIEWER;
  return undefined;
}

export async function watchAgents(
  output: vscode.OutputChannel,
): Promise<vscode.WebviewPanel | undefined> {
  const url = await findViewer();
  if (!url) {
    const pick = await vscode.window.showInformationMessage(
      "The MCP server's viewer is not running yet. It starts with the server: ask the agent to use a craftos tool, or start the server. (CRAFTOS_VIEWER_PORT=off turns it off.)",
      "Start Server",
      "Show Log",
    );
    if (pick === "Start Server") await restartCommand();
    if (pick === "Show Log") output.show();
    return undefined;
  }
  // a remote window (SSH, Codespaces) reaches the port through VS Code's forwarding
  const external = (
    await vscode.env.asExternalUri(vscode.Uri.parse(url))
  ).toString(true);
  output.appendLine(
    `viewer: ${url}${external !== url ? ` (as ${external})` : ""}`,
  );
  if (panel) {
    panel.webview.html = viewerHtml(external, panel.webview.cspSource);
    panel.reveal();
    return panel;
  }
  panel = vscode.window.createWebviewPanel(
    "craftos-mcp.agentViewer",
    "Agent's Computers",
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.webview.html = viewerHtml(external, panel.webview.cspSource);
  panel.onDidDispose(() => (panel = undefined));
  return panel;
}

export function registerAgentView(
  output: vscode.OutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand("craftos-mcp.watchAgents", () =>
    watchAgents(output),
  );
}
