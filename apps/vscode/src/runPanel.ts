// "Run in CraftOS": start `craftos-mcp app` for the file's project, make a computer that runs the file, and show the
// app (terminal, monitors, world buttons) in a webview. Closing the panel deletes the computers and stops the app.
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, relative } from "node:path";
import * as vscode from "vscode";
import { killTree, spawnCommand } from "./launcher";
import { base, noteMissingVersion, runFolder, settingsEnv } from "./settings";
import { worldFor } from "./tests";

/** First runs download the engine and build the ROMs before the app listens. */
const START_TIMEOUT_MS = 5 * 60 * 1000;

export interface RunningPanel {
  readonly panel: vscode.WebviewPanel;
  readonly child: ChildProcess;
  /** The app's own address, on 127.0.0.1. */
  readonly url: string;
  readonly program: string;
}

const open = new Set<RunningPanel>();

export function runningPanels(): readonly RunningPanel[] {
  return [...open];
}

/** Start the app in `folder` and resolve with its address once it prints it. */
function startApp(
  folder: string,
  output: vscode.OutputChannel,
  token: vscode.CancellationToken,
): Promise<{ child: ChildProcess; url: string }> {
  const child = spawnCommand(
    base(),
    ["app", "--port", "0", "--no-open", "--dir", folder],
    { cwd: folder, env: { ...process.env, ...settingsEnv() } },
  );
  child.stdin?.end();
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    const fail = (why: string): void => {
      clearTimeout(timer);
      cancel.dispose();
      killTree(child);
      reject(new Error(why));
    };
    const timer = setTimeout(
      () => fail("craftos-mcp app did not start in 5 minutes"),
      START_TIMEOUT_MS,
    );
    const cancel = token.onCancellationRequested(() => fail("cancelled"));
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      output.append(text);
      out += text;
      const m = /craftos-mcp app: (http:\/\/127\.0\.0\.1:\d+)\//.exec(out);
      if (m) {
        clearTimeout(timer);
        cancel.dispose();
        resolve({ child, url: m[1]! });
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      output.append(text);
      err += text;
    });
    child.on("error", (error) => fail(error.message));
    child.on("exit", (code) => {
      if (/craftos-mcp app: http/.test(out)) return;
      // the pinned craftos-mcp is not on npm yet: start the release before it instead
      if (noteMissingVersion(err)) {
        clearTimeout(timer);
        cancel.dispose();
        startApp(folder, output, token).then(resolve, reject);
        return;
      }
      fail(
        `craftos-mcp app stopped (code ${code}): ${err.trim().split("\n").slice(-3).join(" ") || "no output"}`,
      );
    });
  });
}

/** Make a computer that runs the program, with the world file next to it (and its monitors), if there is one. */
async function newComputer(
  url: string,
  file: string,
  program: string,
): Promise<void> {
  const form: Record<string, unknown> = {
    name: basename(file, ".lua"),
    program,
  };
  const worldFile = worldFor(file);
  if (worldFile) {
    const world = JSON.parse(readFileSync(worldFile, "utf8")) as Record<
      string,
      unknown
    >;
    if (Array.isArray(world["monitors"])) form["monitors"] = world["monitors"];
    delete world["monitors"];
    form["world"] = world;
  }
  const res = await fetch(`${url}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(form),
  });
  if (!res.ok)
    throw new Error(`the app refused the computer: ${await res.text()}`);
}

/** Delete the app's computers (their engines and scratch folders), then stop the app and what it started. */
async function stopApp(url: string, child: ChildProcess): Promise<void> {
  try {
    const signal = AbortSignal.timeout(3000);
    const res = await fetch(`${url}/api/sessions`, { signal });
    const { sessions } = (await res.json()) as { sessions: { id: string }[] };
    await Promise.all(
      sessions.map((s) =>
        fetch(`${url}/api/sessions/${s.id}`, { method: "DELETE", signal }),
      ),
    );
  } catch {
    // the app is already gone, or stuck: the kill below ends it
  }
  killTree(child);
}

export async function stopAll(): Promise<void> {
  await Promise.all([...open].map((p) => stopApp(p.url, p.child)));
  open.clear();
}

export async function runInCraftOS(
  uri: vscode.Uri | undefined,
  output: vscode.OutputChannel,
  extensionUri: vscode.Uri,
): Promise<RunningPanel | undefined> {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!target || !target.fsPath.toLowerCase().endsWith(".lua")) {
    void vscode.window.showErrorMessage("Run in CraftOS needs a .lua file.");
    return undefined;
  }
  const doc = vscode.workspace.textDocuments.find(
    (d) => d.uri.toString() === target.toString(),
  );
  if (doc?.isDirty) await doc.save();
  const file = target.fsPath;
  const folder = runFolder(target);
  const program = relative(folder, file).split("\\").join("/");

  const started = await vscode.window
    .withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `craftos-mcp: starting ${program}`,
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({
          message: "the first start downloads the engine (about a minute)",
        });
        const app = await startApp(folder, output, token);
        try {
          await newComputer(app.url, file, program);
        } catch (error) {
          await stopApp(app.url, app.child);
          throw error;
        }
        return app;
      },
    )
    .then(
      (app) => app,
      (error: Error) => {
        if (error.message !== "cancelled") {
          output.appendLine(`Run in CraftOS: ${error.message}`);
          void vscode.window
            .showErrorMessage(`Run in CraftOS: ${error.message}`, "Show Log")
            .then((pick) => pick && output.show());
        }
        return undefined;
      },
    );
  if (!started) return undefined;

  const port = Number(new URL(started.url).port);
  const panel = vscode.window.createWebviewPanel(
    "craftos-mcp.run",
    `CraftOS: ${basename(file)}`,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [],
      portMapping: [{ webviewPort: port, extensionHostPort: port }],
    },
  );
  panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.png");
  const external = await vscode.env.asExternalUri(
    vscode.Uri.parse(started.url),
  );
  panel.webview.html = html(external, program);

  const running: RunningPanel = {
    panel,
    child: started.child,
    url: started.url,
    program,
  };
  open.add(running);
  started.child.on("exit", (code) => {
    if (open.has(running))
      void panel.webview.postMessage({ type: "stopped", code });
  });
  panel.webview.onDidReceiveMessage(async (msg: { type?: string }) => {
    if (msg.type === "browser")
      await vscode.env.openExternal(vscode.Uri.parse(started.url));
    else if (msg.type === "again")
      await newComputer(started.url, file, program).catch((error: Error) =>
        vscode.window.showErrorMessage(`Run in CraftOS: ${error.message}`),
      );
  });
  panel.onDidDispose(() => {
    open.delete(running);
    void stopApp(started.url, started.child);
  });
  return running;
}

function html(app: vscode.Uri, program: string): string {
  const nonce = randomBytes(16).toString("base64");
  const origin = `${app.scheme}://${app.authority}`;
  const src = app.toString(true);
  const esc = (s: string) =>
    s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: var(--vscode-editor-background); }
  body { display: flex; flex-direction: column; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); }
  .bar { display: flex; gap: 6px; align-items: center; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  .bar .name { flex: 1; opacity: .8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 0; padding: 3px 9px; cursor: pointer; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .stopped { display: none; padding: 6px 8px; background: var(--vscode-inputValidation-errorBackground); }
  iframe { flex: 1; width: 100%; border: 0; background: #fff; }
</style>
</head>
<body>
<div class="bar">
  <span class="name">${esc(program)}</span>
  <button id="again" title="Make another computer running this program">Run again</button>
  <button id="reload" title="Reload the page (the computers keep running)">Reload</button>
  <button id="browser" title="Open the same app in your browser">Open in browser</button>
</div>
<div class="stopped" id="stopped">The emulator stopped. Close this panel and run the file again.</div>
<iframe id="app" src="${esc(src)}" allow="clipboard-read; clipboard-write"></iframe>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const frame = document.getElementById("app");
  document.getElementById("again").onclick = () => vscode.postMessage({ type: "again" });
  document.getElementById("browser").onclick = () => vscode.postMessage({ type: "browser" });
  document.getElementById("reload").onclick = () => { frame.src = frame.src; };
  window.addEventListener("message", (e) => {
    if (e.data && e.data.type === "stopped") document.getElementById("stopped").style.display = "block";
  });
</script>
</body>
</html>`;
}
