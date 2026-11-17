// "Run test" and "Debug test" above each test in a *.test.lua. Run goes through the Testing view's own run; and the
// line a test failed on is marked in the editor until the file runs again or is edited.
//
// Debug test is there when the debugger has registered `craftos-mcp.debugTest` (uri, name, line): debug/adapter.ts
// does on the desktop.
import * as vscode from "vscode";
import { findTests } from "./luaScan";
import type { CraftosTests } from "./tests";

export const DEBUG_TEST_COMMAND = "craftos-mcp.debugTest";

class TestLenses implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private debugCheckedAt = 0;
  private debug = false;

  /** Whether a debugger has registered Debug test (checked at most every few seconds). */
  private async canDebug(): Promise<boolean> {
    if (Date.now() - this.debugCheckedAt > 5000) {
      this.debugCheckedAt = Date.now();
      this.debug = (await vscode.commands.getCommands(true)).includes(
        DEBUG_TEST_COMMAND,
      );
    }
    return this.debug;
  }

  async provideCodeLenses(
    doc: vscode.TextDocument,
  ): Promise<vscode.CodeLens[]> {
    if (
      !vscode.workspace
        .getConfiguration("craftos-mcp")
        .get<boolean>("testCodeLens", true)
    )
      return [];
    const debug = await this.canDebug();
    const lenses: vscode.CodeLens[] = [];
    for (const t of findTests(doc.getText())) {
      const range = new vscode.Range(t.line, t.col, t.line, t.col);
      lenses.push(
        new vscode.CodeLens(range, {
          title: "$(play) Run test",
          tooltip: `Run "${t.name}" (its file runs; the Testing view shows the results)`,
          command: "craftos-mcp.runTest",
          arguments: [doc.uri, t.name, t.line],
        }),
      );
      if (debug)
        lenses.push(
          new vscode.CodeLens(range, {
            title: "$(debug-alt) Debug test",
            tooltip: `Debug "${t.name}": its file runs in the Run in CraftOS panel and stops on your breakpoints and on a failing assertion`,
            command: DEBUG_TEST_COMMAND,
            arguments: [doc.uri, t.name, t.line],
          }),
        );
    }
    return lenses;
  }

  refresh(): void {
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }
}

/** Run one test from its lens: the test's item in the Testing view (the whole file when it has none yet). */
async function runTest(
  tests: CraftosTests,
  uri: vscode.Uri,
  name: string,
  line: number,
): Promise<void> {
  const doc = vscode.workspace.textDocuments.find(
    (d) => d.uri.toString() === uri.toString(),
  );
  if (doc?.isDirty) await doc.save();
  let file = tests.controller.items.get(uri.toString());
  if (!file) {
    await tests.discover();
    file = tests.controller.items.get(uri.toString());
  }
  if (!file) {
    void vscode.window.showErrorMessage(
      `${vscode.workspace.asRelativePath(uri)} is not in the Testing view (excluded, or outside craftos-mcp.workspace).`,
    );
    return;
  }
  let item: vscode.TestItem | undefined;
  file.children.forEach((c) => {
    if (!item && c.label === name && c.range?.start.line === line) item = c;
  });
  file.children.forEach((c) => {
    if (!item && c.label === name) item = c;
  });
  const source = new vscode.CancellationTokenSource();
  try {
    await tests.run(new vscode.TestRunRequest([item ?? file]), source.token);
  } finally {
    source.dispose();
  }
}

interface FailureMark {
  fileId: string;
  uri: string;
  line: number;
  text: string;
}

/** The failing lines of the last runs, as decorations. */
class FailureMarks implements vscode.Disposable {
  private readonly type = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor(
      "testing.message.error.lineBackground",
    ),
    overviewRulerColor: new vscode.ThemeColor("testing.iconFailed"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private marks: FailureMark[] = [];
  private readonly disposables: vscode.Disposable[];

  constructor(tests: CraftosTests) {
    this.disposables = [
      this.type,
      tests.onDidReport((e) => {
        if (e.kind === "started")
          this.marks = this.marks.filter((m) => m.fileId !== e.file.id);
        else {
          const at = e.message.location;
          if (!at) return;
          const text =
            typeof e.message.message === "string"
              ? e.message.message
              : e.message.message.value;
          this.marks.push({
            fileId: e.file.id,
            uri: at.uri.toString(),
            line: at.range.start.line,
            text: `${e.test.label}: ${text}`,
          });
        }
        this.paint();
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.paint()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (!e.contentChanges.length) return;
        const uri = e.document.uri.toString();
        if (!this.marks.some((m) => m.uri === uri)) return;
        this.marks = this.marks.filter((m) => m.uri !== uri);
        this.paint();
      }),
    ];
  }

  /** What is marked now (the integration tests read it). */
  current(): readonly FailureMark[] {
    return this.marks;
  }

  private paint(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const uri = editor.document.uri.toString();
      editor.setDecorations(
        this.type,
        this.marks
          .filter((m) => m.uri === uri && m.line < editor.document.lineCount)
          .map((m) => ({
            range: new vscode.Range(m.line, 0, m.line, 0),
            hoverMessage: new vscode.MarkdownString()
              .appendText("Test failed here: ")
              .appendCodeblock(m.text),
          })),
      );
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

export interface TestLensApi {
  failureMarks: () => readonly FailureMark[];
  refreshLenses: () => void;
}

export function registerTestLens(tests: CraftosTests): {
  disposables: vscode.Disposable[];
  api: TestLensApi;
} {
  const lenses = new TestLenses();
  const marks = new FailureMarks(tests);
  return {
    disposables: [
      lenses,
      marks,
      // any language id: without a Lua extension the file may not be "lua"
      vscode.languages.registerCodeLensProvider(
        { pattern: "**/*.test.lua" },
        lenses,
      ),
      vscode.commands.registerCommand(
        "craftos-mcp.runTest",
        (uri: vscode.Uri, name: string, line: number) =>
          runTest(tests, uri, name, line),
      ),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("craftos-mcp.testCodeLens"))
          lenses.refresh();
      }),
    ],
    api: {
      failureMarks: () => marks.current(),
      refreshLenses: () => lenses.refresh(),
    },
  };
}
