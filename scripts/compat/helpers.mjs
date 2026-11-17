// Shared steps for the project checks in projects/*.mjs.

/** Boot, install with a shell line (wget run, pastebin run, ...) and wait for the prompt to come back. */
export async function shellInstall(t, line, timeoutMs = 120000) {
  if (!t.booted) await t.boot();
  await t.shell(line);
  await t.sleep(1000);
  await t.waitForPrompt(timeoutMs);
  t.noCrash();
}

/**
 * Watch an animation: the screen must change at least `changes` times over `ms`, and never show a crash.
 * Returns how many different frames were seen.
 */
export async function watchAnimation(t, ms = 3000, changes = 3, monitor) {
  const seen = new Set();
  const end = Date.now() + ms;
  while (Date.now() < end) {
    seen.add(t.frameHash(monitor));
    t.noCrash(monitor);
    await t.sleep(50);
  }
  if (seen.size < changes)
    t.fail(
      `expected the screen to keep moving; saw ${seen.size} different frames in ${ms} ms`,
    );
  return seen.size;
}
