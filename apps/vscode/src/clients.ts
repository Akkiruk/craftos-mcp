// The MCP server for VS Code itself, and the commands that hand it to other clients (Claude Code, a JSON snippet).
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as vscode from "vscode";
import {
  EXTERNAL_BASE,
  NPM_PACKAGE,
  baseCommand,
  commandMissing,
  getPinnedStore,
  readSetupLine,
  setPinnedStore,
  spawnCommand,
} from "./launcher";
import {
  claudeCodeCommand,
  editorKind,
  editorTargets,
  mergeMcpServer,
} from "./mcpConfig";
import type { Status } from "./status";
import { ccProjectSign, craftosServersInFolder } from "./projectScan";
import { oneAtATime } from "./prompts";
import {
  configuredWorkspace,
  serverWorkspace,
  settings,
  settingsEnv,
  usePinFallback,
} from "./settings";
import type { SupervisorEvent } from "./supervise";
import { readViewerLine } from "./viewerPage";

export const PROVIDER_ID = "craftos-mcp.server";

/** What the server's supervisor has reported, oldest first (the integration tests read it). */
export type ServerEvent = SupervisorEvent & { supervisor: number };

interface Host {
  supervisorJs: string;
  extensionId: string;
  pipe: string;
  output: vscode.OutputChannel;
  status: Status;
  /** The command line the server last started with, for the status bar. */
  command: string;
  events: ServerEvent[];
  /** The connected supervisors, by their pid: Restart goes to them. */
  sockets: Map<number, Socket>;
  changed: vscode.EventEmitter<void>;
  /** When the supervisor itself died without saying goodbye, for the restart limit. */
  respawns: number[];
  /** The live viewer's URL, as the server last said it (`craftos viewer: <url>` on its stderr). */
  viewer?: string;
}

let host: Host | undefined;

/** Restarts allowed in RESTART_WINDOW_MS, both for the server (in the supervisor) and the supervisor (here). */
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 2 * 60 * 1000;

/**
 * The stdio server VS Code starts: the extension's supervisor (dist/supervisor.js, on the editor's own Node), which
 * runs craftos-mcp serve and starts it again if it dies, so the chat keeps the tools. Its workspace is
 * craftos-mcp.workspace in the first folder, else the first folder.
 */
export function serverDefinition(): vscode.McpStdioServerDefinition {
  // the pinned command, not base(): the supervisor falls back by itself, and the definition stays the same
  const real = baseCommand(settings().command);
  const folder = vscode.workspace.workspaceFolders?.[0];
  const env: Record<string, string> = { ...settingsEnv() };
  if (folder) env["CRAFTOS_WORKSPACE"] = serverWorkspace(folder);
  // a different command or setting is a different server: VS Code offers to refresh its tools
  const version = `${NPM_PACKAGE} ${JSON.stringify([real, env])}`;
  // the extension's own copy of the pinned package (src/pinned.ts), for the supervisor's directBase
  const store = getPinnedStore();
  if (store) env["CRAFTOS_VSCODE_STORE"] = store;
  env["CRAFTOS_SUPERVISE"] = JSON.stringify({
    base: real,
    sub: ["serve"],
    ...(host && { pipe: host.pipe }),
  });
  env["ELECTRON_RUN_AS_NODE"] = "1";
  const def = new vscode.McpStdioServerDefinition(
    "craftos-mcp",
    process.execPath,
    [host?.supervisorJs ?? "dist/supervisor.js"],
    env,
    version,
  );
  if (folder) def.cwd = folder.uri;
  return def;
}

/** ccProjectSign per folder, until a Lua or world file appears or a setting or the folders change. */
const signs = new Map<string, string | undefined>();

function ccSign(folder: string): string | undefined {
  if (!signs.has(folder)) signs.set(folder, ccProjectSign(folder));
  return signs.get(folder);
}

/**
 * Why the extension leaves its own server out (craftos-mcp.registerServer), or undefined to register it. auto: only in
 * a workspace that looks like a ComputerCraft project (ccProjectSign) and has no craftos server of its own in
 * .vscode/mcp.json; everywhere: any workspace without one; always: any; never: none.
 */
export function skipReason(): string | undefined {
  const mode = settings().registerServer;
  if (mode === "never") return "craftos-mcp.registerServer is never";
  if (mode === "always") return undefined;
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const names = craftosServersInFolder(folder.uri.fsPath);
    if (names.length)
      return `${folder.name}/.vscode/mcp.json already runs ${names.join(", ")} (craftos-mcp.registerServer is ${mode})`;
  }
  if (mode === "everywhere") return undefined;
  const folders = (vscode.workspace.workspaceFolders ?? []).filter(
    (f) => f.uri.scheme === "file",
  );
  if (folders.some((f) => ccSign(f.uri.fsPath))) return undefined;
  return folders.length
    ? "this workspace does not look like a ComputerCraft project: no Lua, world files or craftos.json (craftos-mcp.registerServer everywhere registers it anyway)"
    : "no folder is open (craftos-mcp.registerServer everywhere registers it anyway)";
}

/** The definitions the provider gives VS Code right now: none when skipReason says so. */
export function providedDefinitions(): vscode.McpStdioServerDefinition[] {
  const skip = skipReason();
  if (skip) {
    host?.output.appendLine(`MCP server not registered: ${skip}`);
    host?.status.set({ kind: "skipped", why: skip });
    return [];
  }
  if (host?.status.state.kind === "skipped") host.status.set({ kind: "idle" });
  const folder = vscode.workspace.workspaceFolders?.[0];
  const problem = folder && configuredWorkspace(folder).problem;
  if (problem) host?.output.appendLine(problem);
  return [serverDefinition()];
}

/** Where this editor's MCP server shows its live viewer, once it has said so. */
export function viewerUrl(): string | undefined {
  return host?.viewer;
}

export function serverEvents(): readonly ServerEvent[] {
  return host?.events ?? [];
}

/** Ask every running supervisor to start craftos-mcp again, with its restart count back at zero. */
export function restartServer(): number {
  if (!host) return 0;
  for (const socket of host.sockets.values())
    socket.write(`${JSON.stringify({ type: "restart" })}\n`);
  return host.sockets.size;
}

function onEvent(h: Host, socket: Socket, event: ServerEvent): void {
  h.sockets.set(event.supervisor, socket);
  if (event.type === "log") {
    // the server's own stderr: into the log, and the setup's progress into the status bar
    h.output.append(event.text);
    for (const line of event.text.split(/\r?\n/)) {
      const viewer = readViewerLine(line);
      if (viewer) h.viewer = viewer;
      const setup = readSetupLine(line);
      if (setup?.kind === "setting-up")
        h.status.set({ kind: "setting-up", detail: setup.detail });
      else if (setup?.kind === "ready")
        h.status.set({ kind: "running", command: h.command });
      else if (setup?.kind === "failed")
        h.status.set({ kind: "setup-failed", why: setup.why });
    }
    return;
  }
  h.events.push(event);
  if (h.events.length > 200) h.events.splice(0, h.events.length - 200);
  const log = (text: string) => h.output.appendLine(`MCP server: ${text}`);
  switch (event.type) {
    case "started":
      h.command = event.command.join(" ");
      h.status.set({ kind: "running", command: h.command });
      log(`started ${event.command.join(" ")} (pid ${event.pid})`);
      break;
    case "fallback":
      usePinFallback();
      log(
        `${NPM_PACKAGE} is not on npm yet, so it runs ${event.command.join(" ")}`,
      );
      break;
    case "crashed":
      h.status.set({ kind: "restarting", restarts: event.restarts });
      log(
        `stopped (exit code ${event.code ?? event.signal}), starting it again (${event.restarts} of ${MAX_RESTARTS} in 2 minutes)`,
      );
      break;
    case "gave-up": {
      h.status.set({ kind: "gave-up" });
      log(`stopped again, giving up. Its last output:\n${event.stderr.trim()}`);
      void vscode.window
        .showErrorMessage(
          `craftos-mcp's MCP server stopped ${event.restarts + 1} times in 2 minutes, so it was not started again. Its tools answer with an error until you restart it.`,
          "Restart",
          "Show Log",
        )
        .then((pick) => {
          if (pick === "Restart")
            socket.write(`${JSON.stringify({ type: "restart" })}\n`);
          if (pick === "Show Log") h.output.show();
        });
      break;
    }
    case "stopped":
      if (h.sockets.size <= 1) h.status.set({ kind: "idle" });
      log("stopped by VS Code");
      break;
  }
}

/**
 * The supervisor's line closed. After "stopped" that is VS Code stopping the server. Without it the supervisor
 * itself died (killed from outside): fire onDidChangeMcpServerDefinitions so VS Code looks at the server again, at
 * most MAX_RESTARTS times in RESTART_WINDOW_MS, then say so with a way to restart it by hand.
 */
function onClose(h: Host, pid: number | undefined): void {
  if (pid === undefined) return;
  h.sockets.delete(pid);
  const last = [...h.events].reverse().find((e) => e.supervisor === pid);
  if (!last || last.type === "stopped") return;
  const now = Date.now();
  h.respawns = h.respawns.filter((t) => now - t < RESTART_WINDOW_MS);
  if (h.respawns.length < MAX_RESTARTS) {
    h.respawns.push(now);
    h.output.appendLine(
      "MCP server: the server process went away, starting it again",
    );
    // firing the event alone does not start a stopped server (tried: VS Code only re-reads the list), so ask for a
    // start too, unless VS Code started a new one by itself meanwhile
    h.changed.fire();
    setTimeout(() => {
      if (!h.sockets.size) void startInVsCode(h, "workbench.mcp.startServer");
    }, 2000);
    return;
  }
  void vscode.window
    .showErrorMessage(
      `craftos-mcp's MCP server was stopped from outside ${MAX_RESTARTS + 1} times in 2 minutes, so it was not started again.`,
      "Restart",
      "Show Log",
    )
    .then(async (pick) => {
      if (pick === "Restart") {
        h.respawns = [];
        await startInVsCode(h, "workbench.mcp.restartServer");
      }
      if (pick === "Show Log") h.output.show();
    });
}

/**
 * VS Code's own id for the server: `<extension id, lower case>/<label>`, as its extension host builds it (1.101 to
 * 1.146 at least). Its startServer and restartServer commands take it.
 */
function serverId(h: Host): string {
  return `${h.extensionId.toLowerCase()}/craftos-mcp`;
}

async function startInVsCode(
  h: Host,
  command: "workbench.mcp.startServer" | "workbench.mcp.restartServer",
): Promise<void> {
  await vscode.commands
    .executeCommand(command, serverId(h), { autoTrustChanges: true })
    .then(undefined, (error: Error) =>
      h.output.appendLine(`MCP server: ${command} failed: ${error.message}`),
    );
}

/** craftos-mcp: Restart MCP Server. The running supervisors start craftos-mcp over; with none, VS Code restarts it. */
export async function restartCommand(): Promise<void> {
  if (!host) return;
  if (!restartServer())
    await startInVsCode(host, "workbench.mcp.restartServer");
}

/**
 * The pack settings changed (packPicker.ts): a running server gets VS Code's own restart, which starts it from the
 * new definition (its environment). A supervisor restart would keep the old environment. No server running: nothing.
 */
export async function restartForNewSettings(): Promise<void> {
  if (!host?.sockets.size) return;
  await startInVsCode(host, "workbench.mcp.restartServer");
}

function listen(h: Host): vscode.Disposable {
  const server = createServer((socket) => {
    let pid: number | undefined;
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        try {
          const event = JSON.parse(line) as ServerEvent;
          pid = event.supervisor;
          onEvent(h, socket, event);
        } catch {
          // not one of ours
        }
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => onClose(h, pid));
  });
  server.on("error", (error) =>
    h.output.appendLine(`MCP server: no restart channel (${error.message})`),
  );
  server.listen(h.pipe);
  return { dispose: () => server.close() };
}

/** Whether this editor lets extensions give it MCP servers (VS Code 1.101+, not Cursor or Windsurf). */
export function hasMcpApi(): boolean {
  return typeof vscode.lm?.registerMcpServerDefinitionProvider === "function";
}

export function registerServer(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  status: Status,
): vscode.EventEmitter<void> {
  const changed = new vscode.EventEmitter<void>();
  const id = randomBytes(6).toString("hex");
  // where firstRun puts the pinned package, so it starts with node instead of npx (src/pinned.ts)
  setPinnedStore(join(context.globalStorageUri.fsPath, "craftos-mcp"));
  host = {
    supervisorJs: context.asAbsolutePath(join("dist", "supervisor.js")),
    extensionId: context.extension.id,
    pipe:
      process.platform === "win32"
        ? `\\\\.\\pipe\\craftos-mcp-${process.pid}-${id}`
        : join(tmpdir(), `craftos-mcp-${process.pid}-${id}.sock`),
    output,
    status,
    command: "",
    events: [],
    sockets: new Map(),
    changed,
    respawns: [],
  };
  if (!hasMcpApi())
    status.set({
      kind: "skipped",
      why: `${vscode.env.appName} has no MCP API for extensions`,
    });
  else {
    const skip = skipReason();
    if (skip) status.set({ kind: "skipped", why: skip });
  }
  const mcpJson = vscode.workspace.createFileSystemWatcher(
    "**/.vscode/mcp.json",
  );
  // craftos.json stands in for settings (settings.ts): a new or changed one is a new server definition
  const projectJson =
    vscode.workspace.createFileSystemWatcher("**/craftos.json");
  const projectChanged = () => {
    status.refresh();
    changed.fire();
  };
  // registerServer auto: the first Lua or world file in a workspace that had none registers the server
  const ccFiles = vscode.workspace.createFileSystemWatcher(
    "**/{*.lua,*.world.json,craftos.json}",
    false,
    true,
    true,
  );
  context.subscriptions.push(
    changed.event(() => signs.clear()),
    ccFiles,
    ccFiles.onDidCreate(() => {
      if ([...signs.values()].some((s) => s === undefined)) changed.fire();
    }),
    changed,
    listen(host),
    mcpJson,
    mcpJson.onDidCreate(() => changed.fire()),
    mcpJson.onDidChange(() => changed.fire()),
    mcpJson.onDidDelete(() => changed.fire()),
    projectJson,
    projectJson.onDidCreate(projectChanged),
    projectJson.onDidChange(projectChanged),
    projectJson.onDidDelete(projectChanged),
    vscode.workspace.onDidChangeWorkspaceFolders(() => changed.fire()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("craftos-mcp")) changed.fire();
    }),
  );
  // VS Code forks without the MCP API (Cursor, Windsurf) still get the rest of the extension; extension.ts offers
  // to write their own MCP config instead
  if (hasMcpApi())
    context.subscriptions.push(
      vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, {
        onDidChangeMcpServerDefinitions: changed.event,
        provideMcpServerDefinitions: () => providedDefinitions(),
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
    // native Windows: `cmd /c npx ...`, as Claude Code's docs say
    ...claudeCodeCommand(externalCommand()),
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
/** The server entry other clients keep: { command, args, env? }. */
function externalServer(): Record<string, unknown> {
  const [command, ...args] = externalCommand();
  const env = settingsEnv();
  const server: Record<string, unknown> = { command, args };
  if (Object.keys(env).length) server["env"] = env;
  return server;
}

const OFFERED_EDITOR = "craftos-mcp.editorConfigOffered";

/**
 * Cursor and Windsurf have no MCP API for extensions, so the server goes in their own config file: merged in as
 * `craftos`, never overwriting. `ask` is the one-time offer on activation; the command asks every time.
 */
export async function addToEditor(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  ask: "offer" | "command",
): Promise<void> {
  const kind = editorKind(vscode.env.appName);
  if (!kind) {
    if (ask === "command")
      void vscode.window.showInformationMessage(
        hasMcpApi()
          ? `${vscode.env.appName} gets craftos-mcp's MCP server from this extension already; nothing to write.`
          : `craftos-mcp does not know where ${vscode.env.appName} keeps MCP servers. Copy MCP Server JSON gives you the entry to paste.`,
      );
    return;
  }
  if (ask === "offer") {
    if (context.globalState.get(OFFERED_EDITOR)) return;
    await context.globalState.update(OFFERED_EDITOR, true);
  }
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const targets = editorTargets(kind, folder);
  const editor = targets[0]!.editor;
  const picks = targets.map((t) => ({
    label: t.scope === "project" ? "This Project" : "All Projects",
    target: t,
  }));
  const choice =
    ask === "offer"
      ? await oneAtATime(() =>
          vscode.window.showInformationMessage(
            `${editor} does not let extensions add MCP servers, so its agent does not see craftos-mcp yet. Add it to ${editor}'s MCP config?`,
            ...picks.map((p) => p.label),
            "Not Now",
          ),
        )
      : (
          await vscode.window.showQuickPick(
            picks.map((p) => ({ label: p.label, description: p.target.file })),
            { placeHolder: `Where should ${editor} keep the craftos server?` },
          )
        )?.label;
  const target = picks.find((p) => p.label === choice)?.target;
  if (!target) return;
  let text: string | undefined;
  try {
    text = readFileSync(target.file, "utf8");
  } catch {
    text = undefined;
  }
  const merged = mergeMcpServer(text, "craftos", externalServer());
  if (merged.status === "exists") {
    void vscode.window.showInformationMessage(
      `${target.file} already has a craftos server; left it as it is.`,
    );
    return;
  }
  if (merged.status === "unreadable") {
    void vscode.window.showErrorMessage(
      `Could not add craftos to ${target.file}: ${merged.why}. Fix the file, or paste the entry from Copy MCP Server JSON.`,
    );
    return;
  }
  mkdirSync(dirname(target.file), { recursive: true });
  writeFileSync(target.file, merged.text);
  output.appendLine(`added craftos to ${target.file}`);
  const open = await vscode.window.showInformationMessage(
    `Added craftos to ${target.file}. ${editor} may ask you to enable it in its MCP settings.`,
    "Open File",
  );
  if (open) await vscode.window.showTextDocument(vscode.Uri.file(target.file));
}

export function mcpJson(kind: "mcpServers" | "vscode"): string {
  const server = externalServer();
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
