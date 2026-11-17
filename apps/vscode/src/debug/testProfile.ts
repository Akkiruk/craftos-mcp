// "Debug" in the Testing view: each chosen *.test.lua runs under ccunit in the Run in CraftOS panel with the
// debugger attached, one file after the other. Breakpoints in the test and in what it loads stop it, and a failing
// assertion stops where it is raised (Uncaught Errors). The results are on the panel's terminal; Run is what marks
// tests passed or failed in the view.
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { debugFile } from "./adapter";

/** Debug one test file and wait for the session to end. */
async function debugTestFile(
  uri: vscode.Uri,
  token: vscode.CancellationToken,
): Promise<void> {
  const marker = randomUUID();
  let session: vscode.DebugSession | undefined;
  const ended = new Promise<void>((resolve) => {
    const started = vscode.debug.onDidStartDebugSession((s) => {
      if (s.configuration["craftosRun"] === marker) session = s;
    });
    const terminated = vscode.debug.onDidTerminateDebugSession((s) => {
      if (s.configuration["craftosRun"] !== marker) return;
      started.dispose();
      terminated.dispose();
      resolve();
    });
  });
  const cancel = token.onCancellationRequested(
    () => void vscode.debug.stopDebugging(session),
  );
  try {
    const ok = await debugFile(uri, { test: true, craftosRun: marker });
    if (ok) await ended;
  } finally {
    cancel.dispose();
  }
}

export function addDebugProfile(
  controller: vscode.TestController,
): vscode.TestRunProfile {
  return controller.createRunProfile(
    "Debug in craftos-mcp",
    vscode.TestRunProfileKind.Debug,
    async (request, token) => {
      const run = controller.createTestRun(request);
      try {
        const excluded = new Set((request.exclude ?? []).map((i) => i.id));
        const files = new Map<string, vscode.TestItem>();
        const add = (item: vscode.TestItem): void => {
          const file = item.parent ?? item;
          if (!excluded.has(file.id) && file.uri) files.set(file.id, file);
        };
        if (request.include) request.include.forEach(add);
        else controller.items.forEach(add);
        for (const file of files.values()) {
          if (token.isCancellationRequested) break;
          run.started(file);
          run.appendOutput(
            `debugging ${file.label} in CraftOS: its results are on the panel's terminal\r\n`,
          );
          await debugTestFile(file.uri!, token);
        }
      } finally {
        run.end();
      }
    },
    // the default among Debug profiles: what the Testing view's Debug buttons use
    true,
  );
}
