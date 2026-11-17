// Run in CraftOS in the browser: the program's folder becomes a one-computer cart and runs in a webview on the
// WebAssembly engine (web/src/player.js and worker.js), with its terminal, monitors, keyboard, mouse and touch.
// There is no server to fetch the engine from, so the webview gets every file by message and makes blob URLs: the
// player as a module, the engine glue and worker.js joined into one worker script (the engine's own threads load
// the same blob, as they load worker.js on the site).
import * as vscode from "vscode";
import { type Engine, loadEngine, loadRom } from "./assets";
import { buildCart } from "./cart";
import { readFolder, readWorld, relativePath, runFolder } from "./files";

export interface WebPanel {
  readonly panel: vscode.WebviewPanel;
  readonly program: string;
  /** Messages the webview sent (ready, started, error...), for the tests. */
  readonly events: { type: string; [k: string]: unknown }[];
}

const open = new Set<WebPanel>();

export function webPanels(): readonly WebPanel[] {
  return [...open];
}

let engineCache: Promise<Engine | undefined> | undefined;

async function makeCart(target: vscode.Uri, addons: string) {
  const folder = runFolder(target);
  const program = relativePath(folder, target);
  const [{ files, truncated }, world] = await Promise.all([
    readFolder(folder),
    readWorld(target),
  ]);
  const { cart, notes } = buildCart({
    program,
    files,
    ...(world && { world }),
    ...(addons && { addons }),
  });
  if (truncated) notes.push(truncated);
  return { cart, notes, program };
}

export async function runInBrowser(
  uri: vscode.Uri | undefined,
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): Promise<WebPanel | undefined> {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!target || !/\.lua$/i.test(target.path)) {
    void vscode.window.showErrorMessage("Run in CraftOS needs a .lua file.");
    return undefined;
  }
  const doc = vscode.workspace.textDocuments.find(
    (d) => d.uri.toString() === target.toString(),
  );
  if (doc?.isDirty) await doc.save();
  const addons = () =>
    vscode.workspace
      .getConfiguration("craftos-mcp")
      .get<string>("addons", "")
      .trim();

  let made: Awaited<ReturnType<typeof makeCart>>;
  let engine: Engine | undefined;
  let rom: Awaited<ReturnType<typeof loadRom>>;
  try {
    engineCache ??= loadEngine(context.extensionUri);
    [made, engine, rom] = await Promise.all([
      makeCart(target, addons()),
      engineCache,
      loadRom(context, output),
    ]);
  } catch (error) {
    const message = (error as Error).message;
    output.appendLine(`Run in CraftOS: ${message}`);
    void vscode.window
      .showErrorMessage(`Run in CraftOS: ${message}`, "Show Log")
      .then((pick) => pick && output.show());
    return undefined;
  }
  if (!engine) {
    engineCache = undefined;
    void vscode.window.showErrorMessage(
      "Run in CraftOS: this build of the extension has no browser engine. Use the desktop VS Code, or a release build of the extension.",
    );
    return undefined;
  }
  for (const note of made.notes)
    output.appendLine(`Run in CraftOS (${made.program}): ${note}`);

  const panel = vscode.window.createWebviewPanel(
    "craftos-mcp.webRun",
    `CraftOS: ${made.program.replace(/^.*\//, "")}`,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [],
    },
  );
  panel.iconPath = vscode.Uri.joinPath(
    context.extensionUri,
    "media",
    "icon.png",
  );
  panel.webview.html = html(made.program, made.notes);
  const running: WebPanel = { panel, program: made.program, events: [] };
  open.add(running);
  const eng = engine;
  const files = rom;
  panel.webview.onDidReceiveMessage(
    async (msg: { type?: string; [k: string]: unknown }) => {
      if (!msg?.type) return;
      running.events.push(msg as WebPanel["events"][number]);
      if (msg.type === "loaded")
        await panel.webview.postMessage({
          type: "runtime",
          playerJs: eng.playerJs,
          workerJs: eng.workerJs,
          craftosJs: eng.craftosJs,
          wasm: eng.wasm,
          rom: files.rom,
          font: files.font,
          cart: made.cart,
        });
      else if (msg.type === "reload") {
        try {
          made = await makeCart(target, addons());
          await panel.webview.postMessage({ type: "cart", cart: made.cart });
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Run in CraftOS: ${(error as Error).message}`,
          );
        }
      } else if (msg.type === "error" || msg.type === "log")
        output.appendLine(
          `Run in CraftOS (${made.program}): ${String(msg["message"] ?? msg["text"] ?? "")}`,
        );
    },
  );
  panel.onDidDispose(() => open.delete(running));
  return running;
}

function html(program: string, notes: string[]): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const nonce = btoa(String.fromCharCode(...bytes));
  const esc = (s: string) =>
    s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  // blob: for the player module and the worker, 'wasm-unsafe-eval' to compile the engine; the player adds a <style>
  // and inline styles, and draws on canvases
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' blob: 'wasm-unsafe-eval'`,
    "worker-src blob:",
    "style-src 'unsafe-inline'",
    "img-src blob: data:",
    "connect-src blob:",
  ].join("; ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: var(--vscode-editor-background); }
  body { display: flex; flex-direction: column; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); }
  .bar { display: flex; gap: 6px; align-items: center; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  .bar .name { flex: 1; opacity: .8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 0; padding: 3px 9px; cursor: pointer; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .notes { padding: 4px 8px; background: var(--vscode-inputValidation-warningBackground); }
  .notes:empty { display: none; }
  .problem { padding: 12px; white-space: pre-wrap; }
  #player { flex: 1; min-height: 0; }
</style>
</head>
<body>
<div class="bar">
  <span class="name">${esc(program)}</span>
  <button id="reload" title="Read the folder again and start the computer over">Restart with saved files</button>
</div>
<div class="notes" id="notes">${notes.map(esc).join("<br>")}</div>
<div id="player"></div>
<script nonce="${nonce}" type="module">
  const vscode = acquireVsCodeApi();
  const el = document.getElementById("player");
  const say = (type, extra) => vscode.postMessage({ type, ...extra });
  const problem = (text) => {
    el.innerHTML = "";
    const p = document.createElement("div");
    p.className = "problem";
    p.textContent = text;
    el.append(p);
    say("error", { message: text });
  };
  let mod = null;
  let runtime = null;
  let player = null;
  const mount = (cart) => {
    if (player) player.destroy();
    el.innerHTML = "";
    player = mod.mountPlayer(el, {
      cart,
      runtime,
      runtimeBase: "./", // unused with a runtime; its default, the module's folder, is no URL for a blob
      fit: "fill",
      onEvent: (e) => {
        console.debug("craftos-mcp player:", e.type, e.message ?? e.text ?? "");
        if (e.type === "ready" || e.type === "started" || e.type === "off" || e.type === "error")
          say(e.type, e.message ? { message: String(e.message) } : {});
        // the engine's own messages (its stderr) go to the craftos-mcp log
        else if (e.type === "log") say("log", { text: String(e.text ?? "") });
      },
    });
    player.ready.catch((e) => say("error", { message: String(e && e.message || e) }));
    window.craftosPlayer = player;
  };
  const blob = (parts, type) => URL.createObjectURL(new Blob(parts, { type }));
  window.addEventListener("message", async (e) => {
    const m = e.data;
    if (!m || typeof m !== "object") return;
    if (m.type === "runtime") {
      try {
        if (!self.crossOriginIsolated)
          return problem(
            "This page is not cross-origin isolated, so the engine's threads (SharedArrayBuffer) cannot start.\\n" +
              "vscode.dev is cross-origin isolated; a self-hosted VS Code for the Web needs the Cross-Origin-Opener-Policy " +
              "and Cross-Origin-Embedder-Policy headers (or the ?vscode-coi URL flag).",
          );
        // worker.js loads craftos.js next to it with importScripts; here they are one script
        // (worker.js may have Windows line ends, from a Windows checkout)
        const workerJs = m.workerJs.replace(/importScripts\\([\\s\\S]*?\\);\\r?\\n/, "");
        if (workerJs === m.workerJs) return problem("worker.js changed: its importScripts call was not found");
        const workerUrl = blob([m.craftosJs, "\\n;\\n", workerJs], "text/javascript");
        const [wasmModule, playerModule] = await Promise.all([
          WebAssembly.compile(m.wasm),
          import(blob([m.playerJs], "text/javascript")),
        ]);
        mod = playerModule;
        const rom = m.rom.buffer.slice(m.rom.byteOffset, m.rom.byteOffset + m.rom.byteLength);
        // the engine is handed over compiled, but its glue still names craftos.wasm's URL, which it would make from
        // the worker's own (a blob: URL, no base for it): a URL the glue never fetches
        const wasmUrl = blob([m.wasm], "application/wasm");
        runtime = { wasmModule, rom, glyphs: new Uint8Array(m.font), workerUrl, runtimeUrls: { "craftos.wasm": wasmUrl } };
        mount(m.cart);
      } catch (err) {
        problem("The engine did not start: " + (err && err.message || err));
      }
    } else if (m.type === "cart" && mod) mount(m.cart);
  });
  document.getElementById("reload").onclick = () => say("reload");
  say("loaded"); // the page is up: send the engine (not "ready", the player's own event)
</script>
</body>
</html>`;
}
