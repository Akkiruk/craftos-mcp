// The questions the extension asks on its own when a folder opens (use workspace/ as the workspace? set up Lua
// types? add the server to Cursor's config?), one at a time. Opening a ComputerCraft folder for the first time could
// otherwise put three notifications on the screen at once, next to the first-run setup's progress.
//
// No vscode import, so the unit tests can load it in plain Node.

/** How long an unanswered question keeps the next one waiting. VS Code tucks a notification away after about that. */
export const HOLD_MS = 20_000;

let last: Promise<unknown> = Promise.resolve();

/**
 * Ask when the question before this one has been answered, or has sat there for `holdMs`. Resolves with the answer.
 * Only for questions nobody asked for: one a command asks goes straight to the screen.
 */
export function oneAtATime<T>(
  question: () => PromiseLike<T>,
  holdMs = HOLD_MS,
): Promise<T> {
  const mine = last.then(question);
  last = Promise.race([
    mine.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, holdMs);
      // never the reason a process stays alive
      (timer as { unref?: () => void }).unref?.();
    }),
  ]);
  return mine;
}
