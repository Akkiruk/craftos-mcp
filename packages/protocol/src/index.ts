export const protocolVersion = 1 as const;

export interface EngineIdentity {
  readonly adapter: string;
  readonly engine: string;
  readonly engineVersion: string;
  readonly romVersion?: string;
}

export interface RunRequest {
  readonly protocolVersion: typeof protocolVersion;
  readonly program: string;
  readonly arguments: readonly string[];
  readonly timeoutMs: number;
}

export type RunStatus =
  | "completed"
  | "program_error"
  | "timed_out"
  | "engine_crashed"
  | "protocol_error";

export interface TerminalSnapshot {
  readonly width: number;
  readonly height: number;
  readonly lines: readonly string[];
  readonly cursor: {
    readonly x: number;
    readonly y: number;
    readonly blinking: boolean;
  };
}

export interface RunResult {
  readonly protocolVersion: typeof protocolVersion;
  readonly engine: EngineIdentity;
  readonly status: RunStatus;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly terminal: TerminalSnapshot;
  readonly diagnostics: readonly string[];
}
