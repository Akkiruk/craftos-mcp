// The first-run setup (engine download, ROM build) on activation, with its progress in a notification and the status
// bar, so nobody waits on a silent first tool call. `craftos-mcp setup` is quick and quiet once it is done; the
// extension runs it once per pinned version.
import { tmpdir } from "node:os";
import * as vscode from "vscode";
import {
  NPM_PACKAGE,
  getPinnedStore,
  killTree,
  readSetupLine,
  setupFailure,
  spawnCommand,
} from "./launcher";
import { installPinned, pinnedBin } from "./pinned";
import { PINNED_LOCK } from "./pinnedLock";
import { base, noteMissingVersion, settings, settingsEnv } from "./settings";
import type { Status } from "./status";

const DONE = "craftos-mcp.setupDone";

function runSetup(
  output: vscode.OutputChannel,
  onLine: (line: string) => void,
  token: vscode.CancellationToken,
): Promise<{ code: number | null; text: string }> {
  return new Promise((done) => {
    let text = "";
    let child;
    try {
      // not the extension host's folder (VS Code's own): npx reads a package.json it finds above where it runs
      child = spawnCommand(base(), ["setup"], {
        cwd: tmpdir(),
        env: { ...process.env, ...settingsEnv() },
      });
    } catch (error) {
      done({ code: null, text: (error as Error).message });
      return;
    }
    child.stdin?.end();
    let buffer = "";
    const take = (chunk: Buffer) => {
      const s = chunk.toString();
      output.append(s);
      text += s;
      buffer += s;
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        onLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const cancel = token.onCancellationRequested(() => killTree(child));
    child.on("error", (error) => {
      cancel.dispose();
      done({ code: null, text: `${text}${error.message}` });
    });
    child.on("close", (code) => {
      cancel.dispose();
      done({ code, text });
    });
  });
}

/**
 * The pinned craftos-mcp into the extension's storage, once per version, so it starts with node and never needs npx
 * (src/pinned.ts). Quiet: on any failure (offline, a proxy) everything keeps going through npx as before.
 */
async function installPackage(output: vscode.OutputChannel): Promise<void> {
  const store = getPinnedStore();
  if (!store || pinnedBin(store, PINNED_LOCK.spec)) return;
  if (PINNED_LOCK.spec !== NPM_PACKAGE) {
    output.appendLine(
      `pinned package: the lock is for ${PINNED_LOCK.spec}, not ${NPM_PACKAGE}; using npx`,
    );
    return;
  }
  output.appendLine(
    `downloading ${NPM_PACKAGE} into ${store} (once, checked against npm's integrity hashes)`,
  );
  try {
    const bin = await installPinned(store, PINNED_LOCK, {
      log: (line) => output.appendLine(line),
    });
    output.appendLine(`craftos-mcp now starts with node ${bin}, without npx`);
  } catch (error) {
    output.appendLine(
      `could not download ${NPM_PACKAGE} (${(error as Error).message}); using npx instead`,
    );
  }
}

/** Set up once per pinned version, in the background; a notification only if there is real work (a download). */
export async function firstRun(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  status: Status,
): Promise<void> {
  // a custom command is someone's own build: leave its setup to them
  if (settings().command.length) return;
  await installPackage(output);
  if (context.globalState.get(DONE) === NPM_PACKAGE) return;
  const source = new vscode.CancellationTokenSource();
  let progress: vscode.Progress<{ message?: string }> | undefined;
  let shown: Promise<void> | undefined;
  let finish: () => void = () => undefined;
  const onLine = (line: string) => {
    const setup = readSetupLine(line);
    if (setup?.kind !== "setting-up") return;
    status.set({ kind: "setting-up", detail: setup.detail });
    if (!shown)
      shown = Promise.resolve(
        vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title:
              "craftos-mcp: first-run setup (once per version, about a minute)",
            cancellable: true,
          },
          (p, token) => {
            progress = p;
            token.onCancellationRequested(() => source.cancel());
            return new Promise<void>((resolve) => (finish = resolve));
          },
        ),
      );
    progress?.report({ message: setup.detail });
  };
  output.appendLine(`first-run setup: ${base().join(" ")} setup`);
  let result = await runSetup(output, onLine, source.token);
  if (result.code !== 0 && noteMissingVersion(result.text))
    result = await runSetup(output, onLine, source.token);
  finish();
  await shown;
  const cancelled = source.token.isCancellationRequested;
  source.dispose();
  if (cancelled) {
    output.appendLine(
      "first-run setup cancelled; the MCP server or the next run does it instead",
    );
    if (status.state.kind === "setting-up") status.set({ kind: "idle" });
    return;
  }
  if (result.code === 0) {
    await context.globalState.update(DONE, NPM_PACKAGE);
    if (status.state.kind === "setting-up") status.set({ kind: "idle" });
    return;
  }
  const why = setupFailure(result.text, result.code);
  status.set({ kind: "setup-failed", why });
  const retry = "Try Again";
  const pick = await vscode.window.showWarningMessage(
    `craftos-mcp could not set up the emulator (${why}). Check your connection and try again; Run in CraftOS and the MCP server also retry when they start.`,
    retry,
    "Show Log",
  );
  if (pick === retry) {
    status.set({ kind: "idle" });
    return firstRun(context, output, status);
  }
  if (pick) output.show();
}
