// The extension's own questions come one at a time.
import assert from "node:assert/strict";
import { test } from "node:test";
import { oneAtATime } from "../../src/prompts.ts";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test("a second question waits for the first one's answer", async () => {
  const shown = [];
  let answerFirst;
  const first = oneAtATime(() => {
    shown.push("first");
    return new Promise((resolve) => (answerFirst = resolve));
  });
  const second = oneAtATime(async () => {
    shown.push("second");
    return "b";
  });
  await tick();
  assert.deepEqual(shown, ["first"]);
  answerFirst("a");
  assert.equal(await first, "a");
  assert.equal(await second, "b");
  assert.deepEqual(shown, ["first", "second"]);
});

test("a question left unanswered only holds the next one for a while", async () => {
  const shown = [];
  void oneAtATime(() => {
    shown.push("ignored");
    return new Promise(() => undefined);
  }, 20);
  const next = oneAtATime(async () => {
    shown.push("next");
    return 1;
  }, 20);
  await tick();
  assert.deepEqual(shown, ["ignored"]);
  assert.equal(await next, 1);
  assert.deepEqual(shown, ["ignored", "next"]);
});

test("a question that throws does not stop the ones after it", async () => {
  await assert.rejects(
    oneAtATime(async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(await oneAtATime(async () => "fine"), "fine");
});
