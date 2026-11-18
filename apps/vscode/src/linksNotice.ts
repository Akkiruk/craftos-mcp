// A one-time note for people who switch on the vhcctweaks addon: its linked computers (ender modem links, remote
// peripherals) run in real time, so they are the part of the emulator a slow or busy machine upsets first. Shown once
// a session while vhcctweaks is in the addons setting or a world file in the workspace names it, until "Don't Show
// Again".
import * as vscode from "vscode";

const KEY = "craftos-mcp.linksNotice.dismissed";
const TEXT =
  "vhcctweaks linked computers (ender modem links, remote peripherals) run in real time: on a slow or busy machine " +
  "(many emulated computers at once) a linked-peripheral call can time out, stall or behave inconsistently.";

/** Whether the addons setting or a world file asks for vhcctweaks. */
async function vhcctweaksInUse(): Promise<boolean> {
  const addons = vscode.workspace
    .getConfiguration("craftos-mcp")
    .get<string>("addons", "");
  if (/\bvhcctweaks\b/i.test(addons)) return true;
  const files = await vscode.workspace.findFiles(
    "**/*.world.json",
    "**/node_modules/**",
    50,
  );
  for (const file of files) {
    try {
      const text = new TextDecoder().decode(
        await vscode.workspace.fs.readFile(file),
      );
      if (/"vhcctweaks"\s*:\s*"2\.2\.3[67]"|"vhcctweaks"\s*[,\]]/.test(text))
        return true;
    } catch {
      // unreadable: not ours to judge
    }
  }
  return false;
}

export function registerLinksNotice(context: vscode.ExtensionContext): void {
  let shown = false;
  const check = async () => {
    if (shown || context.globalState.get<boolean>(KEY)) return;
    if (!(await vhcctweaksInUse())) return;
    shown = true;
    const pick = await vscode.window.showInformationMessage(
      TEXT,
      "Don't Show Again",
    );
    if (pick === "Don't Show Again")
      await context.globalState.update(KEY, true);
  };
  void check();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("craftos-mcp.addons")) void check();
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.fileName.endsWith(".world.json")) void check();
    }),
  );
}
