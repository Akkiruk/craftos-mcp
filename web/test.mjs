// Browser tests of the web runtime and every cart (web/README.md), in headless Chromium with Playwright:
//
//   node web/test.mjs [--shots <dir>] [--only <test,test>]      (npm run test:web)
//
// Needs web/dist built (node web/build-runtime.mjs && node web/build-carts.mjs). Playwright is not a dependency of
// this repo: PLAYWRIGHT_MODULE names its index.mjs (default: the "playwright" package) and CHROMIUM_PATH a Chromium
// executable (default: Playwright's own). Each test gets its own page, and they all run at once.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startServer } from "./serve.mjs";

const WEB = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const SHOTS = arg("--shots");
const only = arg("--only") ? new Set(arg("--only").split(",")) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

if (
  !existsSync(join(WEB, "dist", "runtime", "manifest.json")) ||
  !existsSync(join(WEB, "dist", "carts", "index.json"))
) {
  console.error(
    "web/dist is not built: node web/build-runtime.mjs && node web/build-carts.mjs",
  );
  process.exit(1);
}
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE
    ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : "playwright"
);
const index = JSON.parse(
  readFileSync(join(WEB, "dist", "carts", "index.json"), "utf8"),
);
const cartJson = (id) =>
  JSON.parse(readFileSync(join(WEB, "dist", "carts", `${id}.json`), "utf8"));

const PORT = 8800 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}/`;
const server = await startServer(PORT);
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH && {
    executablePath: process.env.CHROMIUM_PATH,
  }),
  args: ["--enable-precise-memory-info"],
});

// ---- helpers ----

class Fail extends Error {}
const check = (ok, message) => {
  if (!ok) throw new Fail(message);
};

async function openPage(options = {}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    ...options,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.waitForFunction(() => window.dev?.loaded);
  check(
    await page.evaluate(() => self.crossOriginIsolated),
    "page is not cross-origin isolated",
  );
  return { page, context, errors };
}

/** Open a cart (an id or a cart object) and wait until every computer has drawn. */
async function play(page, cart, options) {
  await page.evaluate(([c, o]) => dev.open(c, o), [cart, options ?? {}]);
  const result = await page.evaluate(() =>
    Promise.race([
      dev.player.ready.then(
        () => "ok",
        (e) => `failed: ${e.message}`,
      ),
      new Promise((r) => setTimeout(() => r("timed out"), 45000)),
    ]),
  );
  check(
    result === "ok",
    `cart ${typeof cart === "string" ? cart : cart.id} did not start: ${result}`,
  );
}

const waitFor = async (page, fn, arg, ms = 15000, what = "condition") => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await page.evaluate(fn, arg);
    if (v) return v;
    if (Date.now() > end) throw new Fail(`timed out waiting for ${what}`);
    await page.waitForTimeout(100);
  }
};
const text = (page, screen = "terminal", computer) =>
  page.evaluate(
    ([s, c]) => dev.player.screenText(s, c).join("\n"),
    [screen, computer],
  );
const waitText = (page, needle, screen = "terminal", computer, ms = 15000) =>
  waitFor(
    page,
    ([n, s, c]) => dev.player.screenText(s, c).join("\n").includes(n),
    [needle, screen, computer],
    ms,
    `"${needle}" on ${screen}${computer ? ` of ${computer}` : ""}`,
  );

/** The shell is waiting at its prompt (keys typed before it reads them would be lost, as on a real computer). */
const waitPrompt = (page, computer) =>
  waitFor(
    page,
    (c) =>
      /^> ?$/.test(
        dev.player
          .screenText("terminal", c)
          .filter((l) => l.trim())
          .at(-1) ?? "",
      ),
    computer,
    15000,
    "the shell prompt",
  );

/** Where cell (x, y) of a screen is on the page, for real mouse clicks and taps. */
const cellPoint = (page, screen, x, y, computer) =>
  page.evaluate(
    ([s, x, y, c]) => {
      const canvas = dev.player.canvas(s, c);
      const r = canvas.getBoundingClientRect();
      return {
        x: r.left + ((2 + (x - 0.5) * 6) / canvas.width) * r.width,
        y: r.top + ((2 + (y - 0.5) * 9) / canvas.height) * r.height,
      };
    },
    [screen, x, y, computer],
  );
const click = async (page, screen, x, y, computer) => {
  await waitFor(
    page,
    ([s, c]) =>
      dev.player
        .screens()
        .some((o) => o.name === s && (!c || o.computer === c)),
    [screen, computer],
    15000,
    `${screen} to appear`,
  );
  const p = await cellPoint(page, screen, x, y, computer);
  await page.mouse.click(p.x, p.y);
};

const shot = (page, name) =>
  SHOTS ? page.screenshot({ path: join(SHOTS, `${name}.png`) }) : undefined;

/** Cells of one background colour on a monitor, as [x, y] (0-based). */
const cellsOf = (page, screen, colour) =>
  page.evaluate(
    ([s, col]) => {
      const c = dev.player.screenCells(s);
      const out = [];
      c.colors.forEach((v, i) => {
        if (v >> 4 === col) out.push([i % c.width, Math.floor(i / c.width)]);
      });
      return out;
    },
    [screen, colour],
  );

/** A screen has something on it: text, or more than one colour. */
const drawn = (page, screen, computer) =>
  page.evaluate(
    ([s, c]) => {
      const cells = dev.player.screenCells(s, c);
      if (!cells) {
        const canvas = dev.player.canvas(s, c);
        if (!canvas) return false;
        const data = canvas
          .getContext("2d")
          .getImageData(0, 0, canvas.width, canvas.height).data;
        const seen = new Set();
        for (let i = 0; i < data.length; i += 4 * 17)
          seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
        return seen.size > 4;
      }
      const seen = new Set();
      cells.text.forEach((t, i) => seen.add(t * 256 + cells.colors[i]));
      return seen.size > 1;
    },
    [screen, computer],
  );

// ---- tests ----

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// Every cart boots and draws each screen it lists; four pages share the carts
for (let lane = 0; lane < 4; lane++) {
  test(`boot-${lane + 1}`, async () => {
    const { page } = await openPage();
    const mine = index.carts.filter((_, i) => i % 4 === lane);
    const report = [];
    for (const entry of mine) {
      const cart = cartJson(entry.id);
      const started = Date.now();
      await play(page, entry.id);
      for (const c of cart.computers)
        for (const s of c.screens) {
          const name =
            s === "terminal" ? "terminal" : s.slice(s.indexOf(":") + 1);
          await waitFor(
            page,
            ([n, comp]) => dev.player.canvas(n, comp) !== null,
            [name, c.name],
            20000,
            `${entry.id}: ${s} of ${c.name}`,
          );
          const end = Date.now() + 15000;
          while (!(await drawn(page, name, c.name))) {
            if (Date.now() > end)
              throw new Fail(`${entry.id}: ${s} of ${c.name} stays blank`);
            await page.waitForTimeout(200);
          }
        }
      report.push(`${entry.id} ${Date.now() - started}ms`);
      await shot(page, `cart-${entry.id}`);
    }
    return report.join(", ");
  });
}

test("board-tap-move", async () => {
  const { page } = await openPage();
  await play(page, "reversi");
  await waitText(page, "Flip them all", "left");
  // real clicks on the canvas: idle -> menu -> the game -> lobby -> START
  await click(page, "left", 60, 40);
  await waitText(page, "pick a game", "left");
  await click(page, "left", 40, 25);
  await waitText(page, "WHO IS PLAYING?", "left");
  await click(page, "left", 61, 75);
  await waitText(page, "MOVE 1", "left");
  await shot(page, "reversi-start");
  // red (the person) moves first: tap squares around the middle of the board until one is a legal move
  for (let y = 26; y <= 56; y += 3)
    for (let x = 30; x <= 92; x += 5) {
      await click(page, "left", x, y);
      await page.waitForTimeout(60);
      if (!(await text(page, "left")).includes("MOVE 1")) {
        await page.waitForTimeout(500);
        await shot(page, "reversi-moved");
        return `move made at cell ${x},${y}`;
      }
    }
  throw new Fail("no tap made a move");
});

test("keyboard-game", async () => {
  const { page } = await openPage();
  await play(page, "snake");
  await page.evaluate(() => dev.player.touch("top", 60, 40));
  await waitText(page, "Pick a game", "top");
  await page.evaluate(() => dev.player.touch("top", 40, 25));
  await waitText(page, "HIGH SCORES", "top");
  await page.evaluate(() => dev.player.touch("top", 61, 65)); // START
  await waitFor(
    page,
    () => !dev.player.screenText("top").join("\n").includes("HIGH SCORES"),
    undefined,
    10000,
    "the game to start",
  );
  const SNAKE = 13; // green
  // the snake's top row in the playing field (the title above it is green too)
  const top = async () =>
    Math.min(
      ...(await cellsOf(page, "top", SNAKE))
        .filter(([, y]) => y >= 8)
        .map(([, y]) => y),
    );
  await waitFor(
    page,
    ([s, col]) =>
      dev.player
        .screenCells(s)
        .colors.some((v, i) => v >> 4 === col && i >= 8 * 121),
    ["top", SNAKE],
    10000,
    "the snake",
  );
  // it runs right along one row on its own
  const before = await top();
  await page.waitForTimeout(400);
  check(
    (await top()) === before,
    `the snake moved off its row by itself (${before} -> ${await top()})`,
  );
  // the snake starts moving right; Up on the real keyboard (the player has focus) turns it
  await page.focus(".ccp");
  await page.keyboard.down("ArrowUp");
  await page.waitForTimeout(80);
  await page.keyboard.up("ArrowUp");
  const end = Date.now() + 4000;
  while ((await top()) >= before - 2) {
    if (Date.now() > end)
      throw new Fail(
        `the snake did not turn up (top row ${before} -> ${await top()})`,
      );
    await page.waitForTimeout(100);
  }
  await shot(page, "snake-turned");
  // pause: the snake stops; resume: it moves again
  await page.evaluate(() => dev.player.pause());
  await page.waitForTimeout(400);
  const frozen = JSON.stringify(await cellsOf(page, "top", SNAKE));
  await page.waitForTimeout(800);
  check(
    JSON.stringify(await cellsOf(page, "top", SNAKE)) === frozen,
    "the snake moved while paused",
  );
  await page.evaluate(() => dev.player.resume());
  await waitFor(
    page,
    ([s, col, f]) => {
      const c = dev.player.screenCells(s);
      const out = [];
      c.colors.forEach((v, i) => {
        if (v >> 4 === col) out.push([i % c.width, Math.floor(i / c.width)]);
      });
      return JSON.stringify(out) !== f;
    },
    ["top", SNAKE, frozen],
    5000,
    "the snake to move after resume",
  );
  // a hidden tab pauses too
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      value: true,
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  check(
    await page.evaluate(() => dev.events.some((e) => e.type === "paused")),
    "hiding the tab did not pause",
  );
  return `snake turned up from row ${before}; pause and hidden-tab pause work`;
});

test("shell-typing", async () => {
  const { page } = await openPage();
  await play(page, "shell");
  await waitPrompt(page);
  await page.focus(".ccp");
  await page.keyboard.type("id");
  await page.keyboard.press("Enter");
  await waitText(page, "This is computer #0");
  await page.keyboard.type("lua");
  await page.keyboard.press("Enter");
  await waitText(page, "Interactive Lua prompt");
  await page.keyboard.type("6*7");
  await page.keyboard.press("Enter");
  await waitText(page, "42");
  // Ctrl+T as a button ends lua's prompt
  await page.getByRole("button", { name: "Ctrl+T" }).click();
  await waitPrompt(page).catch(async (e) => {
    throw new Fail(
      `${e.message}: ${(await text(page))
        .split("\n")
        .filter((l) => l.trim())
        .slice(-4)
        .join(" | ")}`,
    );
  });
  // mouse on an advanced computer: a click on cell 7,5 reaches the program as mouse_click
  await page.keyboard.type("lua");
  await page.keyboard.press("Enter");
  await waitText(page, "Interactive Lua prompt");
  await page.keyboard.type(
    'print(table.concat({ "got", os.pullEvent("mouse_click") }, ","))',
  );
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  await click(page, "terminal", 7, 5);
  await waitText(
    page,
    "got,mouse_click,1,7,5",
    "terminal",
    undefined,
    5000,
  ).catch(async () => {
    throw new Fail(
      `no mouse_click 1 7 5: ${(await text(page)).split("\n").slice(-4).join(" | ")}`,
    );
  });
  return "typed, ran, Ctrl+T, mouse_click at the right cell";
});

test("rednet-two-computers", async () => {
  const { page } = await openPage();
  await play(page, "rednet-chat");
  await waitText(page, "Bob joined", "terminal", "alice", 20000);
  await waitText(page, "Alice joined", "terminal", "bob", 20000);
  // type into Alice's computer: click her screen, then the keyboard
  await click(page, "terminal", 10, 10, "alice");
  await page.keyboard.type("hello from alice");
  await page.keyboard.press("Enter");
  await waitText(page, "hello from alice", "terminal", "bob");
  await shot(page, "rednet-chat");
  return "Alice's message reached Bob over rednet";
});

test("versus-network", async () => {
  const { page } = await openPage();
  await play(page, "versus-paddle");
  // each cabinet finds the other over rednet: North's wall offers a game with South
  await click(page, "top", 60, 40, "north");
  await waitText(page, "play with South", "top", "north", 20000);
  await click(page, "top", 40, 30, "north");
  await waitText(page, "South is here", "top", "north");
  await click(page, "top", 61, 47, "north"); // PLAY SOUTH
  await waitText(page, "Waiting for South to tap their wall", "top", "north");
  await page.waitForTimeout(500); // South's wall says TAP TO JOIN (in the big font, so not as text)
  await click(page, "top", 60, 40, "south");
  // the match starts: North stops waiting
  await waitFor(
    page,
    () =>
      !dev.player
        .screenText("top", "north")
        .join("\n")
        .includes("Waiting for South"),
    undefined,
    15000,
    "South to join",
  );
  const nets = await page.evaluate(() =>
    dev.events.filter((e) => e.type === "net").map((e) => e.computer),
  );
  check(
    nets.includes("north") && nets.includes("south"),
    `only ${[...new Set(nets)]} sent anything`,
  );
  await page.waitForTimeout(1500);
  await shot(page, "versus-match");
  return `North challenged South over rednet, South joined; ${nets.length} batches of modem traffic`;
});

test("sim-command", async () => {
  const { page } = await openPage();
  await play(page, "power-monitor");
  await waitText(page, "80", "top");
  const before = await text(page, "top");
  await page.getByRole("button", { name: "Drain battery" }).click();
  await waitFor(
    page,
    (b) =>
      dev.player.screenText("top").join("\n") !== b &&
      dev.player.screenText("top").join("\n").includes("4"),
    before,
    10000,
    "the monitor to show the drained battery",
  );
  await shot(page, "power-drained");
  // the GPU's pixel screen renders and takes taps (tmTouch)
  await play(page, "gpu-demo");
  const v1 = await page.evaluate(
    () => dev.player.screens().find((s) => s.kind === "pixels")?.version ?? 0,
  );
  await page.waitForTimeout(1000);
  const gpu = await page.evaluate(() =>
    dev.player.screens().find((s) => s.kind === "pixels"),
  );
  check(gpu && gpu.version > v1, "the GPU screen does not animate");
  check(await drawn(page, gpu.name), "the GPU screen is blank");
  const canvas = await page.evaluate((n) => {
    const r = dev.player.canvas(n).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, gpu.name);
  await page.mouse.click(canvas.x, canvas.y);
  check(
    await page.evaluate(() =>
      dev.events.some((e) => e.type === "sim" && e.command.cmd === "tmTouch"),
    ),
    "a tap on the GPU sent no tmTouch",
  );
  await shot(page, "gpu");
  return `battery drained on the monitor; GPU ${gpu.width}x${gpu.height} at version ${gpu.version}`;
});

test("switch-carts-10x", async () => {
  const { page } = await openPage();
  const cdp = await page.context().newCDPSession(page);
  // The page's memory, workers included. Slow (about a minute): the engine's threads sit in Atomics.wait and only
  // answer at Chrome's deadline. It counts the shared wasm memory once per thread that touched it, so it is a
  // number to compare, not the real footprint.
  const measure = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    const bytes = await page.evaluate(async () => {
      try {
        return (await performance.measureUserAgentSpecificMemory()).bytes;
      } catch {
        return performance.memory?.usedJSHeapSize ?? 0;
      }
    });
    return {
      bytes,
      workers: page.workers().length,
      live: await page.evaluate(() => dev.runtimeStats()),
    };
  };
  const cycle = ["reversi", "versus", "gpu-demo", "rednet-chat", "snake"];
  await play(page, cycle[0]);
  const first = await measure();
  let last;
  for (let i = 1; i <= 10; i++) {
    await play(page, cycle[i % cycle.length]);
    await page.waitForTimeout(300);
  }
  await play(page, cycle[0]);
  await page.waitForTimeout(500);
  last = await measure();
  check(
    last.live.workers === 1 && last.live.players === 1,
    `after switching: ${JSON.stringify(last.live)}`,
  );
  check(
    last.workers <= first.workers,
    `page workers grew from ${first.workers} to ${last.workers}`,
  );
  check(
    last.bytes < first.bytes * 1.5 + 32e6,
    `memory grew from ${(first.bytes / 1e6).toFixed(0)} MB to ${(last.bytes / 1e6).toFixed(0)} MB`,
  );
  // destroy leaves nothing
  await page.evaluate(() => dev.player.destroy());
  await page.waitForTimeout(300);
  const gone = await page.evaluate(() => dev.runtimeStats());
  check(
    gone.workers === 0 && gone.players === 0,
    `after destroy: ${JSON.stringify(gone)}`,
  );
  // the engine's own threads (workers nested in the terminated one) go a moment later
  const until = Date.now() + 10000;
  while (page.workers().length > 0 && Date.now() < until)
    await page.waitForTimeout(200);
  check(
    page.workers().length === 0,
    `${page.workers().length} workers still running 10 s after destroy`,
  );
  return `memory ${(first.bytes / 1e6).toFixed(0)} MB -> ${(last.bytes / 1e6).toFixed(0)} MB, page workers ${first.workers} -> ${last.workers} -> 0 after destroy`;
});

test("yield-abort", async () => {
  const { page } = await openPage();
  const cart = {
    id: "abort",
    title: "abort",
    computers: [
      {
        id: 0,
        files: {},
        world: "{}",
        boot: 'local ok, err = pcall(function() while true do end end)\nprint("yield ok:", tostring(err))\n',
        screens: ["terminal"],
      },
    ],
  };
  const started = Date.now();
  await play(page, cart);
  await waitText(page, "yield ok:", "terminal", undefined, 30000);
  const t = await text(page);
  check(
    /too long without yielding/i.test(t),
    `the abort said: ${t.split("\n").find((l) => l.includes("yield ok"))}`,
  );
  // the computer still works afterwards
  await waitPrompt(page);
  await page.focus(".ccp");
  await page.keyboard.type("id");
  await page.keyboard.press("Enter");
  await waitText(page, "This is computer #0");
  return `aborted after ${((Date.now() - started) / 1000).toFixed(1)} s`;
});

test("phone", async () => {
  const { page } = await openPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  await play(page, "reversi");
  await waitText(page, "Flip them all", "left");
  const box = await page.evaluate(() => {
    const r = dev.player.canvas("left").getBoundingClientRect();
    return { left: r.left, right: r.right, width: r.width, height: r.height };
  });
  check(
    box.left >= 0 && box.right <= 390,
    `the wall overflows the phone: ${JSON.stringify(box)}`,
  );
  const p = await cellPoint(page, "left", 60, 40);
  await page.touchscreen.tap(p.x, p.y);
  await waitText(page, "pick a game", "left");
  await shot(page, "phone-reversi");
  // a keyboard game on a phone gets the on-screen keys
  await play(page, "snake");
  const keys = await page.evaluate(() =>
    [...document.querySelectorAll(".ccp-keys button")].map(
      (b) => b.dataset.key,
    ),
  );
  check(
    keys.includes("up") &&
      !(await page.evaluate(() => document.querySelector(".ccp-keys").hidden)),
    `no keys bar: ${keys}`,
  );
  await shot(page, "phone-snake");
  return `wall ${box.width.toFixed(0)}x${box.height.toFixed(0)} px on a 390 px phone; tap opened the menu; keys bar ${keys.join(" ")}`;
});

test("credits-link", async () => {
  const { page } = await openPage();
  await play(page, "shell");
  const href = await page.evaluate(
    () =>
      [...document.querySelectorAll(".ccp a")].find((a) =>
        /CC:Tweaked/.test(a.textContent),
      )?.href,
  );
  check(href === "https://tweaked.cc/", `the CC:Tweaked link is ${href}`);
  return href;
});

// ---- run ----

const chosen = tests.filter(
  (t) =>
    !only ||
    only.has(t.name) ||
    (only.has("boot") && t.name.startsWith("boot")),
);
const started = Date.now();
const results = await Promise.all(
  chosen.map(async (t) => {
    const t0 = Date.now();
    try {
      const note = await t.fn();
      return { name: t.name, ok: true, note, ms: Date.now() - t0 };
    } catch (e) {
      return {
        name: t.name,
        ok: false,
        note: e instanceof Fail ? e.message : e.stack,
        ms: Date.now() - t0,
      };
    }
  }),
);
for (const r of results)
  console.log(
    `${r.ok ? "PASS" : "FAIL"} ${r.name} (${(r.ms / 1000).toFixed(1)} s)${r.note ? ": " + r.note : ""}`,
  );
const failed = results.filter((r) => !r.ok).length;
console.log(
  `${results.length - failed}/${results.length} passed in ${((Date.now() - started) / 1000).toFixed(0)} s`,
);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
