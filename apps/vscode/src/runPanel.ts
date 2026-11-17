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
  /** The app; a settings change swaps it for a new one (restartPanel). */
  child: ChildProcess;
  /** The app's own address, on 127.0.0.1. */
  url: string;
  readonly program: string;
  /** The program's file, and the folder the app runs in (runFolder). */
  readonly file: string;
  readonly folder: string;
  readonly output: vscode.OutputChannel;
  /** Opened by a debug session: a save must not restart the computer the debugger is attached to. */
  readonly debugging: boolean;
  /** Runs the program as a test file (ccunit), and so does a rerun. */
  readonly test: boolean;
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
  extra: RunExtra = {},
): Promise<void> {
  const form: Record<string, unknown> = {
    name: basename(file, ".lua"),
    program,
    ...(extra.test && { test: true }),
    ...(extra.debug && { debug: extra.debug }),
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

/** What a debug session adds to a run (debug/adapter.ts). */
export interface RunExtra {
  /** The debug adapter's port and token: the computer's engine connects to it before it boots. */
  readonly debug?: { readonly port: number; readonly token: string };
  /** Run the file as a ccunit test, as the Testing view does. */
  readonly test?: boolean;
  /** The folder the computer gets as its files, instead of runFolder's choice (a test's project folder). */
  readonly folder?: string;
}

export async function runInCraftOS(
  uri: vscode.Uri | undefined,
  output: vscode.OutputChannel,
  extensionUri: vscode.Uri,
  extra: RunExtra = {},
): Promise<RunningPanel | undefined> {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!target || !target.fsPath.toLowerCase().endsWith(".lua")) {
    void vscode.window.showErrorMessage(
      "Run in CraftOS needs a .lua file: open one, or right-click it in the Explorer.",
    );
    return undefined;
  }
  const doc = vscode.workspace.textDocuments.find(
    (d) => d.uri.toString() === target.toString(),
  );
  if (doc?.isDirty) await doc.save();
  const file = target.fsPath;
  const folder = extra.folder ?? runFolder(target);
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
          await newComputer(app.url, file, program, extra);
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

  const panel = vscode.window.createWebviewPanel(
    "craftos-mcp.run",
    `CraftOS: ${basename(file)}`,
    // a debug session keeps the keyboard in the editor, where the breakpoints are
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: !!extra.debug },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      ...webviewOptions(started.url),
    },
  );
  panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.png");
  const running: RunningPanel = {
    panel,
    child: started.child,
    url: started.url,
    program,
    file,
    folder,
    output,
    debugging: !!extra.debug,
    test: !!extra.test,
  };
  await showApp(running);
  open.add(running);
  panel.webview.onDidReceiveMessage(async (msg: { type?: string }) => {
    const gone =
      running.child.exitCode !== null || running.child.signalCode !== null;
    if (msg.type === "browser")
      await vscode.env.openExternal(vscode.Uri.parse(running.url));
    else if (msg.type === "restart" || (msg.type === "again" && gone))
      // the app is gone (it crashed, or was killed): a new one, with the program running in it
      await enqueue(running, "start the emulator again", () =>
        restartPanel(running),
      );
    else if (msg.type === "again")
      // another computer, without the debugger: that one is attached to the first
      await newComputer(running.url, file, program, {
        ...(extra.test && { test: true }),
      }).catch((error: Error) =>
        vscode.window.showErrorMessage(`Run in CraftOS: ${error.message}`),
      );
  });
  panel.onDidDispose(() => {
    open.delete(running);
    void stopApp(running.url, running.child);
  });
  return running;
}

function webviewOptions(url: string): vscode.WebviewOptions {
  const port = Number(new URL(url).port);
  return {
    enableScripts: true,
    localResourceRoots: [],
    portMapping: [{ webviewPort: port, extensionHostPort: port }],
  };
}

/** Point the panel at its app (again, after a restart), and say so in it when the app stops. */
async function showApp(running: RunningPanel): Promise<void> {
  const { panel, child } = running;
  panel.webview.options = webviewOptions(running.url);
  const external = await vscode.env.asExternalUri(
    vscode.Uri.parse(running.url),
  );
  panel.webview.html = html(external, running.program);
  child.on("exit", (code) => {
    if (open.has(running) && running.child === child)
      void panel.webview.postMessage({ type: "stopped", code });
  });
}

const chains = new WeakMap<RunningPanel, Promise<void>>();

/** Run jobs on a panel one after another (a save during a restart waits for it); a failure goes to the log. */
export function enqueue(
  running: RunningPanel,
  what: string,
  job: () => Promise<void>,
): Promise<void> {
  const next = (chains.get(running) ?? Promise.resolve())
    .then(job)
    .catch((error: Error) => {
      running.output.appendLine(`Run in CraftOS: ${what}: ${error.message}`);
      void vscode.window.showErrorMessage(
        `Run in CraftOS: ${what}: ${error.message}`,
      );
    });
  chains.set(running, next);
  return next;
}

/**
 * Run the program over in the panel's app: its computers go and a new one starts, with the files as they are now
 * (the app copies the folder into each computer it makes). For a save (rerun.ts).
 */
export async function rerunProgram(running: RunningPanel): Promise<void> {
  if (running.child.exitCode !== null || running.child.signalCode !== null)
    return restartPanel(running);
  const res = await fetch(`${running.url}/api/sessions`, {
    signal: AbortSignal.timeout(3000),
  });
  const { sessions } = (await res.json()) as { sessions: { id: string }[] };
  await Promise.all(
    sessions.map((s) =>
      fetch(`${running.url}/api/sessions/${s.id}`, { method: "DELETE" }),
    ),
  );
  await newComputer(running.url, running.file, running.program, {
    ...(running.test && { test: true }),
  });
}

/**
 * Stop the panel's app and start a new one with the settings as they are now (the Minecraft version and addons are
 * the app's environment), then run the program in it. For a settings change (packPicker.ts).
 */
export async function restartPanel(running: RunningPanel): Promise<void> {
  const old = { url: running.url, child: running.child };
  const source = new vscode.CancellationTokenSource();
  const done = running.panel.onDidDispose(() => source.cancel());
  try {
    await stopApp(old.url, old.child);
    const app = await startApp(running.folder, running.output, source.token);
    if (!open.has(running)) {
      await stopApp(app.url, app.child);
      return;
    }
    running.child = app.child;
    running.url = app.url;
    await newComputer(app.url, running.file, running.program, {
      ...(running.test && { test: true }),
    });
    await showApp(running);
  } finally {
    done.dispose();
    source.dispose();
  }
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
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-button-border, var(--vscode-widget-border, transparent)); border-radius: 2px; padding: 2px 9px; font: inherit; cursor: pointer; white-space: nowrap; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .stopped { display: none; gap: 8px; align-items: center; padding: 6px 8px; background: var(--vscode-inputValidation-errorBackground); border-bottom: 1px solid var(--vscode-inputValidation-errorBorder, transparent); }
  .stopped.on { display: flex; }
  .stopped span { flex: 1; }
  iframe { flex: 1; width: 100%; border: 0; background: #fff; }
</style>
</head>
<body>
<div class="bar">
  <span class="name">${esc(program)}</span>
  <button id="again" title="Start another computer running this program, next to the ones already here">Run Again</button>
  <button id="reload" title="Reload this view (the computers keep running)">Reload</button>
  <button id="browser" title="Open the same emulator page in your browser, with more room">Open in Browser</button>
</div>
<div class="stopped" id="stopped"><span>The emulator stopped.</span><button id="restart" title="Start the emulator and the program again">Start Again</button></div>
<iframe id="app" src="${esc(src)}" allow="clipboard-read; clipboard-write"></iframe>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const frame = document.getElementById("app");
  document.getElementById("again").onclick = () => vscode.postMessage({ type: "again" });
  document.getElementById("browser").onclick = () => vscode.postMessage({ type: "browser" });
  document.getElementById("reload").onclick = () => { frame.src = frame.src; };
  document.getElementById("restart").onclick = () => vscode.postMessage({ type: "restart" });
  window.addEventListener("message", (e) => {
    if (!e.data) return;
    if (e.data.type === "stopped") document.getElementById("stopped").classList.add("on");
    // An editor shortcut pressed while the emulator page has the keyboard (F1, Ctrl+P, Ctrl+B...): the page hands
    // it over, and a keydown on this window is what VS Code listens for in a webview.
    if (e.data.type === "craftos-key" && e.source === frame.contentWindow) {
      const k = e.data;
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: String(k.key), code: String(k.code), keyCode: Number(k.keyCode) || 0, which: Number(k.keyCode) || 0,
        ctrlKey: !!k.ctrlKey, shiftKey: !!k.shiftKey, altKey: !!k.altKey, metaKey: !!k.metaKey, repeat: !!k.repeat,
        bubbles: true, cancelable: true,
      }));
    }
  });
</script>
</body>
</html>`;
}
