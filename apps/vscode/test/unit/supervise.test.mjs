// The supervisor against a fake MCP server (fake-server.mjs) in real child processes: a crash is restarted with the
// client's initialize replayed, calls in flight get an error, it gives up after 3 restarts, and Restart starts over.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Supervisor } from "../../src/supervise.ts";

const fake = fileURLToPath(new URL("./fake-server.mjs", import.meta.url));

function harness(options = {}) {
  const lines = [];
  const events = [];
  const waiters = [];
  const check = () => {
    for (const w of [...waiters])
      if (w.test()) {
        waiters.splice(waiters.indexOf(w), 1);
        w.done();
      }
  };
  const sup = new Supervisor({
    base: [process.execPath, fake],
    sub: [],
    env: { ...process.env, ...options.env },
    delayMs: 50,
    write: (line) => {
      lines.push(JSON.parse(line));
      check();
    },
    events: (e) => {
      events.push(e);
      check();
    },
    ...options.supervisor,
  });
  const until = (testFn, what, ms = 10_000) =>
    new Promise((resolve, reject) => {
      if (testFn()) return resolve();
      const timer = setTimeout(
        () => reject(new Error(`timed out: ${what}`)),
        ms,
      );
      waiters.push({
        test: testFn,
        done: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  let id = 0;
  const send = (method, params = {}) => {
    const msg = { jsonrpc: "2.0", id: ++id, method, params };
    sup.fromClient(JSON.stringify(msg));
    return msg.id;
  };
  const reply = (rid, what = `reply ${rid}`) =>
    until(() => lines.some((l) => l.id === rid), what).then(() =>
      lines.find((l) => l.id === rid),
    );
  const notify = (method) =>
    sup.fromClient(JSON.stringify({ jsonrpc: "2.0", method }));
  return { sup, lines, events, until, send, reply, notify };
}

async function initialized(h) {
  h.sup.start();
  const init = await h.reply(
    h.send("initialize", { protocolVersion: "2025-06-18" }),
  );
  h.notify("notifications/initialized");
  return init;
}

test("a crash restarts the server, replays initialize and fails the call it was on", async () => {
  const h = harness();
  const init = await initialized(h);
  const first = init.result.pid;
  const died = await h.reply(h.send("tools/call", { name: "die" }));
  assert.match(
    died.error.message,
    /stopped while answering this \(exit code 3\)/,
  );
  // the next call goes to a new server that was initialized behind the client's back
  const list = await h.reply(h.send("tools/list"));
  assert.notEqual(list.result.pid, first);
  assert.equal(list.result.initialized, 1);
  assert.deepEqual(list.result.tools, [{ name: "craftos_info" }]);
  // the replayed initialize's answer never reached the client
  assert.equal(h.lines.filter((l) => l.result?.serverInfo).length, 1);
  assert.deepEqual(
    h.events.map((e) => e.type),
    ["started", "crashed", "started"],
  );
  h.sup.stop();
});

test("calls sent while it restarts wait for the new server instead of failing", async () => {
  const h = harness({ supervisor: { delayMs: 300 } });
  await initialized(h);
  h.send("tools/call", { name: "die" });
  await h.until(() => h.events.some((e) => e.type === "crashed"), "crash");
  const list = await h.reply(h.send("tools/list"));
  assert.ok(list.result, JSON.stringify(list));
  h.sup.stop();
});

test("gives up after 3 restarts in the window, then Restart starts over", async () => {
  const h = harness();
  await initialized(h);
  for (let i = 0; i < 4; i++) {
    await h.until(() => h.sup.pid !== undefined, "running");
    await h.reply(h.send("tools/call", { name: "die" }));
  }
  await h.until(() => h.events.some((e) => e.type === "gave-up"), "gave up");
  assert.equal(h.sup.givenUp, true);
  const refused = await h.reply(h.send("tools/list"));
  assert.match(refused.error.message, /stopped 4 times in 2 minutes/);
  assert.match(refused.error.message, /Restart/);

  h.sup.restart();
  const list = await h.reply(h.send("tools/list"));
  assert.ok(list.result, JSON.stringify(list));
  assert.equal(h.sup.givenUp, false);
  h.sup.stop();
});

test("a restart from outside kills a stuck server and answers its stuck call", async () => {
  const h = harness();
  const init = await initialized(h);
  const stuck = h.send("tools/call", { name: "hang" });
  h.sup.restart();
  const answer = await h.reply(stuck);
  assert.match(answer.error.message, /restarted while answering this/);
  const list = await h.reply(h.send("tools/list"));
  assert.notEqual(list.result.pid, init.result.pid);
  assert.equal(h.events.filter((e) => e.type === "crashed").length, 0);
  h.sup.stop();
});

test("a pinned version missing on npm falls back without counting a crash", async () => {
  // fallbackFor only rewrites the default npx command, so give the fake that shape through a spawn wrapper
  const { spawn } = await import("node:child_process");
  const seen = [];
  const h = harness({
    env: { FAKE_ETARGET: "1" },
    supervisor: {
      base: ["npx", "-y", "craftos-mcp@0.4.0"],
      spawn: (base, sub, opts) => {
        seen.push(base.join(" "));
        const extra = base.includes("craftos-mcp@0.3.0") ? ["fallback"] : [];
        return spawn(process.execPath, [fake, ...extra], {
          env: opts.env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      },
    },
  });
  const init = await initialized(h);
  assert.ok(init.result, JSON.stringify(init));
  assert.deepEqual(seen, [
    "npx -y craftos-mcp@0.4.0",
    "npx -y craftos-mcp@0.3.0",
  ]);
  assert.deepEqual(
    h.events.map((e) => e.type),
    ["started", "fallback", "started"],
  );
  h.sup.stop();
});
