import type { Server } from "node:http";
import {
  type ScreenCapture,
  type SessionManager,
  loadConfig,
  startWebApp,
} from "@craftos-mcp/runner";

export interface ViewerOptions {
  readonly port: number;
  readonly sessions: SessionManager;
  /** Screens from the most recent craftos_run, so one-shot runs can be inspected too. */
  readonly lastRun: () =>
    | { label: string; screens: ScreenCapture[] }
    | undefined;
  /** Told the URL once it listens (the port can differ from `port` when that was taken). */
  readonly onUrl?: (url: string) => void;
}

/**
 * The live viewer: the browser app (runner's webapp.ts, the same one `craftos-mcp app` starts) over the MCP server's
 * own sessions. Agents' sessions show up as tabs, and a person can make computers, type, touch and send sim commands
 * next to the agent. Binds to loopback and refuses requests from other sites.
 */
export function startViewer(options: ViewerOptions): Server {
  return startWebApp({
    port: options.port,
    sessions: options.sessions,
    config: loadConfig(),
    lastRun: options.lastRun,
    // a second MCP server (another editor window, another agent) gets a free port instead of no viewer
    portFallback: true,
    // the VS Code extension reads this line (Watch the Agent's Computers): keep its shape
    onListening: (url) => {
      options.onUrl?.(url);
      process.stderr.write(`craftos viewer: ${url}\n`);
    },
  });
}
