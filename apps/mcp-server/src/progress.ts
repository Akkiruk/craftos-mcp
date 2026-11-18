// Long calls (craftos_test on a big suite, a long craftos_run): MCP progress notifications when the client asked for
// them (a progressToken in the request's _meta), so a client that resets its timeout on progress keeps waiting and a
// person sees how far it got; and a time budget for the whole call, after which the call stops and answers with what
// finished instead of being cut off with nothing.

/** The bits of the SDK's RequestHandlerExtra these use. */
export interface CallExtra {
  readonly signal: AbortSignal;
  readonly _meta?: { progressToken?: string | number } | undefined;
  readonly sendNotification: (notification: {
    method: "notifications/progress";
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => Promise<void>;
}

export type Progress = (
  progress: number,
  total?: number,
  message?: string,
) => void;

/** Send progress for this call; a no-op when the client sent no progressToken. Never throws. */
export function progressFor(extra: CallExtra): Progress {
  const token = extra._meta?.progressToken;
  if (token === undefined) return () => undefined;
  let last = -Infinity;
  return (progress, total, message) => {
    // progress must go up (the spec): a repeat is dropped
    if (progress <= last) return;
    last = progress;
    void extra
      .sendNotification({
        method: "notifications/progress",
        params: {
          progressToken: token,
          progress,
          ...(total !== undefined && { total }),
          ...(message !== undefined && { message }),
        },
      })
      .catch(() => undefined);
  };
}

/** The default budget of a call: CRAFTOS_CALL_BUDGET_MS, else ten minutes. */
export function defaultBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const set = Number(env["CRAFTOS_CALL_BUDGET_MS"]);
  return Number.isFinite(set) && set >= 1000 ? set : 600_000;
}

/** A signal that fires when the client cancels or the budget runs out; `expired` says which. */
export function withBudget(
  signal: AbortSignal,
  ms: number,
): { signal: AbortSignal; expired: () => boolean; dispose: () => void } {
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(), ms);
  timer.unref?.();
  return {
    signal: AbortSignal.any([signal, budget.signal]),
    expired: () => budget.signal.aborted && !signal.aborted,
    dispose: () => clearTimeout(timer),
  };
}

/** Progress while something runs that has no steps of its own (a program): elapsed seconds, every `everyMs`. */
export function ticker(
  progress: Progress,
  totalMs: number,
  label: string,
  everyMs = 2000,
): () => void {
  const started = Date.now();
  progress(0, totalMs / 1000, label);
  const timer = setInterval(() => {
    const s = Math.round((Date.now() - started) / 1000);
    progress(s, totalMs / 1000, `${label}, ${s} s`);
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
