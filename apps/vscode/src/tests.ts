// The Testing view: every *.test.lua is a file item, each ccunit.test in it a child. A run calls
// `craftos-mcp test <files> --dir <folder>`, reads its report (testOutput.ts) and marks each test, with failures at
// the line Lua named.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import * as vscode from "vscode";
import { killTree, spawnCommand } from "./launcher";
import { globToRegExp, isExcluded } from "./projectScan";
import {
  base,
  configuredWorkspace,
  noteMissingVersion,
  projectFolder,
  settings,
  settingsEnv,
} from "./settings";
import {
  type ReportFile,
  declaredTests,
  errorLocations,
  monitorOptions,
  parseTestReport,
  syntaxError,
} from "./testOutput";

const PATTERN = "**/*.test.lua";

/** files.exclude and search.exclude globs set to true, for a folder. */
function excludeGlobs(folder: vscode.WorkspaceFolder): RegExp[] {
  const globs: RegExp[] = [];
  for (const section of ["files", "search"]) {
    const map = vscode.workspace
      .getConfiguration(section, folder.uri)
      .get<Record<string, unknown>>("exclude", {});
    for (const [glob, on] of Object.entries(map))
      if (on === true) globs.push(globToRegExp(glob));
  }
  return globs;
}

/**
 * Whether a found test file belongs in the Testing view: not excluded (ALWAYS_SKIP, files.exclude, search.exclude),
 * and inside craftos-mcp.workspace when that is set.
 */
function wanted(uri: vscode.Uri): boolean {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return true;
  const rel = relative(folder.uri.fsPath, uri.fsPath);
  if (isExcluded(rel, excludeGlobs(folder))) return false;
  const { dir } = configuredWorkspace(folder);
  if (!dir) return true;
  const inside = relative(dir, uri.fsPath);
  return !inside.startsWith("..") && !isAbsolute(inside);
}

/** `foo.test.lua` runs in `foo.world.json` next to it, when there is one (its `monitors` become --monitor). */
export function worldFor(file: string): string | undefined {
  const world = file.replace(/(\.test)?\.lua$/i, ".world.json");
  return world !== file && existsSync(world) ? world : undefined;
}

export type TestReportEvent =
  | { kind: "started"; file: vscode.TestItem }
  | {
      kind: "failed";
      file: vscode.TestItem;
      test: vscode.TestItem;
      message: vscode.TestMessage;
    };

export class CraftosTests implements vscode.Disposable {
  readonly controller: vscode.TestController;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly reported = new vscode.EventEmitter<TestReportEvent>();
  /** A file started running, or one of its tests failed (testLens.ts marks the failing lines). */
  readonly onDidReport = this.reported.event;

  constructor() {
    this.controller = vscode.tests.createTestController(
      "craftos-mcp",
      "CraftOS (ccunit)",
    );
    this.controller.resolveHandler = async (item) => {
      if (!item) await this.discover();
      else this.parseFile(item);
    };
    this.controller.refreshHandler = () => this.discover();
    this.controller.createRunProfile(
      "Run in craftos-mcp",
      vscode.TestRunProfileKind.Run,
      (request, token) => this.run(request, token),
      true,
    );
    const watcher = vscode.workspace.createFileSystemWatcher(PATTERN);
    watcher.onDidCreate((uri) => {
      if (wanted(uri)) this.parseFile(this.fileItem(uri));
    });
    watcher.onDidChange((uri) => {
      if (wanted(uri)) this.parseFile(this.fileItem(uri));
    });
    watcher.onDidDelete((uri) => this.controller.items.delete(uri.toString()));
    this.disposables.push(
      watcher,
      this.controller,
      this.reported,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration("craftos-mcp.workspace") ||
          e.affectsConfiguration("files.exclude") ||
          e.affectsConfiguration("search.exclude")
        )
          void this.discover();
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        const item = this.controller.items.get(e.document.uri.toString());
        if (item) this.parseFile(item, e.document.getText());
      }),
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  async discover(): Promise<void> {
    // no exclude argument, so files.exclude applies; search.exclude, ALWAYS_SKIP and craftos-mcp.workspace on top
    const found = (await vscode.workspace.findFiles(PATTERN)).filter((u) =>
      wanted(u),
    );
    const keep = new Set(found.map((u) => u.toString()));
    this.controller.items.forEach((item) => {
      if (!keep.has(item.id)) this.controller.items.delete(item.id);
    });
    for (const uri of found) this.parseFile(this.fileItem(uri));
  }

  private fileItem(uri: vscode.Uri): vscode.TestItem {
    const existing = this.controller.items.get(uri.toString());
    if (existing) return existing;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const label = folder
      ? relative(folder.uri.fsPath, uri.fsPath).split("\\").join("/")
      : uri.path.split("/").pop()!;
    const item = this.controller.createTestItem(uri.toString(), label, uri);
    item.canResolveChildren = true;
    this.controller.items.add(item);
    return item;
  }

  /** The file's children from its literal ccunit.test names (others appear after a run). */
  private parseFile(item: vscode.TestItem, text?: string): void {
    if (!item.uri) return;
    let source = text;
    if (source === undefined) {
      try {
        source = readFileSync(item.uri.fsPath, "utf8");
      } catch {
        return;
      }
    }
    const children: vscode.TestItem[] = [];
    const seen = new Map<string, number>();
    for (const t of declaredTests(source)) {
      const child = this.childItem(item, t.name, seen);
      child.range = new vscode.Range(t.line, 0, t.line, 0);
      children.push(child);
    }
    item.children.replace(children);
  }

  private childItem(
    file: vscode.TestItem,
    name: string,
    seen: Map<string, number>,
  ): vscode.TestItem {
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    const id = `${file.id}::${name}${n > 1 ? `#${n}` : ""}`;
    return (
      file.children.get(id) ??
      this.controller.createTestItem(id, name, file.uri)
    );
  }

  async run(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const run = this.controller.createTestRun(request);
    try {
      if (!request.include) await this.discover();
      const excluded = new Set((request.exclude ?? []).map((i) => i.id));
      const files = new Map<string, vscode.TestItem>();
      const add = (item: vscode.TestItem): void => {
        const file = item.parent ?? item;
        if (!excluded.has(file.id) && file.uri) files.set(file.id, file);
      };
      if (request.include) request.include.forEach(add);
      else this.controller.items.forEach(add);

      // one craftos-mcp per project folder and world file
      const groups = new Map<
        string,
        { folder: string; world?: string; items: vscode.TestItem[] }
      >();
      for (const item of files.values()) {
        const folder = projectFolder(item.uri!);
        const world = worldFor(item.uri!.fsPath);
        const key = `${folder}\0${world ?? ""}`;
        const group = groups.get(key) ?? { folder, world, items: [] };
        group.items.push(item);
        groups.set(key, group);
        run.enqueued(item);
        item.children.forEach((c) => run.enqueued(c));
      }
      await Promise.all(
        [...groups.values()].map((g) =>
          this.runGroup(run, g.folder, g.world, g.items, token),
        ),
      );
    } finally {
      run.end();
    }
  }

  private async runGroup(
    run: vscode.TestRun,
    folder: string,
    world: string | undefined,
    items: vscode.TestItem[],
    token: vscode.CancellationToken,
  ): Promise<void> {
    for (const item of items) {
      this.reported.fire({ kind: "started", file: item });
      run.started(item);
      item.children.forEach((c) => run.started(c));
    }
    const rel = (item: vscode.TestItem) =>
      relative(folder, item.uri!.fsPath).split("\\").join("/");
    const args = ["test", ...items.map(rel), "--dir", folder];
    args.push("--timeout", String(settings().testTimeout));
    if (world) {
      args.push("--world", world);
      try {
        args.push(...monitorOptions(JSON.parse(readFileSync(world, "utf8"))));
      } catch {
        // a broken world file: craftos-mcp says what is wrong with it
      }
    }
    let result = await this.exec(args, folder, run, token);
    // the pinned craftos-mcp is not on npm yet: once more on the release before it
    if (result.code !== 0 && noteMissingVersion(result.stderr))
      result = await this.exec(args, folder, run, token);
    const { code, stdout, stderr } = result;
    if (token.isCancellationRequested) {
      for (const item of items) run.skipped(item);
      return;
    }
    const report = parseTestReport(stdout);
    const byFile = new Map(report.files.map((f) => [f.file, f]));
    for (const item of items) {
      const result = byFile.get(rel(item));
      if (!result) {
        const why =
          stderr.trim() ||
          stdout.trim() ||
          `craftos-mcp test exited with code ${code}`;
        run.errored(item, new vscode.TestMessage(why));
        item.children.forEach((c) => run.skipped(c));
        continue;
      }
      this.report(run, item, result, folder);
    }
  }

  private report(
    run: vscode.TestRun,
    item: vscode.TestItem,
    result: ReportFile,
    folder: string,
  ): void {
    const seen = new Map<string, number>();
    const reported = new Set<string>();
    for (const t of result.tests) {
      const child = this.childItem(item, t.name, seen);
      if (!item.children.get(child.id)) item.children.add(child);
      reported.add(child.id);
      if (t.passed) {
        run.passed(child);
        continue;
      }
      const message = new vscode.TestMessage(t.error ?? "failed");
      message.location = this.locate(t.error ?? "", item, folder, child);
      run.failed(child, message);
      this.reported.fire({ kind: "failed", file: item, test: child, message });
    }
    item.children.forEach((c) => {
      if (!reported.has(c.id)) run.skipped(c);
    });
    if (result.problem) {
      const terminal = result.terminal.join("\n");
      const text =
        result.problem === "timed_out"
          ? `the file did not finish before the timeout (craftos-mcp.testTimeout)\n\n${terminal}`
          : `the file produced no results\n\n${terminal}`;
      const message = new vscode.TestMessage(text);
      const syntax =
        result.problem === "crashed" ? syntaxError(result.terminal) : undefined;
      if (syntax && item.uri)
        message.location = new vscode.Location(
          item.uri,
          new vscode.Position(syntax.line - 1, 0),
        );
      run.failed(item, message, result.durationMs);
      this.reported.fire({ kind: "failed", file: item, test: item, message });
    } else if (result.passed) run.passed(item, result.durationMs);
    else run.failed(item, [], result.durationMs);
  }

  /** Where an error points: in the test file if Lua names it, else the first workspace file it names. */
  private locate(
    error: string,
    file: vscode.TestItem,
    folder: string,
    child: vscode.TestItem,
  ): vscode.Location | undefined {
    const locations = errorLocations(error);
    const own = relative(folder, file.uri!.fsPath).split("\\").join("/");
    const hit =
      locations.find((l) => l.file === own) ??
      locations.find((l) => existsSync(join(folder, l.file)));
    if (hit)
      return new vscode.Location(
        vscode.Uri.file(join(folder, hit.file)),
        new vscode.Position(hit.line - 1, 0),
      );
    if (child.range) return new vscode.Location(file.uri!, child.range);
    return undefined;
  }

  private exec(
    args: string[],
    cwd: string,
    run: vscode.TestRun,
    token: vscode.CancellationToken,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((done) => {
      const child = spawnCommand(base(), args, {
        cwd,
        env: { ...process.env, ...settingsEnv() },
      });
      child.stdin?.end();
      let stdout = "";
      let stderr = "";
      const show = (chunk: Buffer) =>
        run.appendOutput(chunk.toString().replace(/\r?\n/g, "\r\n"));
      child.stdout?.on("data", (c: Buffer) => {
        stdout += c.toString();
        show(c);
      });
      child.stderr?.on("data", (c: Buffer) => {
        stderr += c.toString();
        show(c);
      });
      const cancel = token.onCancellationRequested(() => killTree(child));
      child.on("error", (error) => {
        cancel.dispose();
        done({ code: null, stdout, stderr: `${stderr}${error.message}` });
      });
      child.on("close", (code) => {
        cancel.dispose();
        done({ code, stdout, stderr });
      });
    });
  }
}
