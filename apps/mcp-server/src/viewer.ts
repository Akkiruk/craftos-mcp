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
    onListening: (url) => process.stderr.write(`craftos viewer: ${url}\n`),
  });
}
