// Web test: the extension in VS Code for the Web (@vscode/test-web, cross-origin isolated as vscode.dev is), driven
// with Playwright's Chromium: open a program, Run in CraftOS, and read the computer's screens in the webview.
//
//   node test/web/run.mjs [--shots <dir>] [--headed]
//
// Build first (npm run build, with the browser engine: CRAFTOS_WEB_BUILD_DIR or engine/build-web). The first run
// downloads a VS Code for the Web build into .vscode-test-web/ and CC:Tweaked's jar from Modrinth (in the browser,
// as a user's first run does). Checks:
//   1. hello.lua prints its text on the terminal;
//   2. mon.lua with mon.world.json gets its monitor, and writes on it; a touch on the monitor reaches the program;
//   3. ask.lua reads what is typed on the real keyboard into the webview;
//   4. the desktop-only commands are not in the command palette.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const args = process.argv.slice(2);
const shots = args.includes("--shots")
  ? resolve(args[args.indexOf("--shots") + 1])
  : undefined;
const headed = args.includes("--headed");
const PORT = 3000 + Math.floor(Math.random() * 1000);

const scratch = mkdtempSync(join(tmpdir(), "craftos-vscode-web-"));
const project = join(scratch, "project");
mkdirSync(join(project, "lib"), { recursive: true });
writeFileSync(
  join(project, "lib", "greet.lua"),
  'return function(who) return "Hello, " .. who .. "!" end\n',
);
writeFileSync(
  join(project, "hello.lua"),
  [
    'local greet = dofile("lib/greet.lua")',
    'print(greet("browser"))',
    'print("running on " .. os.version())',
    "",
  ].join("\n"),
);
writeFileSync(
  join(project, "mon.lua"),
  [
    'local m = peripheral.find("monitor")',
    "m.setTextScale(1)",
    "m.clear()",
    "m.setCursorPos(2, 2)",
    'm.write("ON THE MONITOR")',
    'print("waiting for a touch")',
    'local _, side, x, y = os.pullEvent("monitor_touch")',
    'print("touched " .. side .. " at " .. x .. "," .. y)',
    "",
  ].join("\n"),
);
writeFileSync(
  join(project, "mon.world.json"),
  JSON.stringify(
    { monitors: [{ name: "top", blocksWide: 3, blocksHigh: 2 }] },
    null,
    2,
  ),
);
writeFileSync(
  join(project, "ask.lua"),
  ['write("name? ")', "local n = read()", 'print("hi " .. n)', ""].join("\n"),
);

if (shots) mkdirSync(shots, { recursive: true });
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const server = spawn(
  process.execPath,
  [
    join(
      root,
      "node_modules",
      "@vscode",
      "test-web",
      "out",
      "server",
      "index.js",
    ),
    "--browser=none",
    "--coi",
    `--port=${PORT}`,
    "--quality=stable",
    `--extensionDevelopmentPath=${root}`,
    "--testRunnerDataDir",
    join(root, ".vscode-test-web"),
    project,
  ],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
);
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

async function waitForServer() {
  const until = Date.now() + 5 * 60_000;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://localhost:${PORT}/`);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`test-web did not start:\n${serverLog}`);
}

/** The webview frame whose player runs `program`, once every computer has drawn (its ready). */
async function playerFrame(page, program, timeout = 90_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    for (const f of page.frames()) {
      const has = await f
        .evaluate((p) => window.craftosPlayer?.cart?.title === p, program)
        .catch(() => false);
      if (has) {
        await f.evaluate(() => window.craftosPlayer.ready).catch(() => {});
        return f;
      }
    }
    await page.waitForTimeout(500);
  }
  return undefined;
}

async function screenText(frame, name) {
  return frame
    .evaluate((n) => window.craftosPlayer.screenText(n).join("\n"), name)
    .catch((e) => `<${e.message}>`);
}

async function waitForText(frame, name, re, timeout = 60_000) {
  const until = Date.now() + timeout;
  let text = "";
  while (Date.now() < until) {
    text = await screenText(frame, name);
    if (re.test(text)) return text;
    // the player's "could not start" overlay: no point waiting
    const failed = await frame
      .evaluate(
        () =>
          [...document.querySelectorAll(".ccp-overlay")].find(
            (o) => !o.hidden && /could not/i.test(o.textContent),
          )?.textContent,
      )
      .catch(() => undefined);
    if (failed) return `<player: ${failed}>`;
    await new Promise((r) => setTimeout(r, 300));
  }
  return text;
}

async function command(page, title) {
  await page.keyboard.press("F1");
  await page.waitForSelector(".quick-input-widget input", { state: "visible" });
  await page.keyboard.type(title);
  await page.waitForTimeout(600);
  const items = await page
    .locator(".quick-input-list .monaco-list-row")
    .allInnerTexts();
  return items;
}

async function openFile(page, name) {
  // the test file system has no search provider for Quick Open: open it from the Explorer
  await page
    .locator(`.explorer-folders-view .monaco-list-row[aria-label="${name}"]`)
    .click();
  await page.waitForSelector(`.tab[aria-label*="${name}"]`, {
    timeout: 20_000,
  });
}

async function run(page, file) {
  await openFile(page, file);
  await command(page, "craftos-mcp: Run in CraftOS");
  await page.keyboard.press("Enter");
}

let browser;
let page;
try {
  await waitForServer();
  browser = await chromium.launch({ headless: !headed });
  page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const logs = [];
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(".monaco-workbench", { timeout: 120_000 });
  check(
    await page.evaluate(() => self.crossOriginIsolated),
    "the workbench is cross-origin isolated",
  );
  await page.waitForSelector(".explorer-folders-view .monaco-list-row", {
    timeout: 60_000,
  });

  // 1. hello.lua
  await run(page, "hello.lua");
  const hello = await playerFrame(page, "hello.lua");
  check(!!hello, "Run in CraftOS opens a player");
  if (!hello && shots)
    await page.screenshot({ path: join(shots, "no-player.png") });
  if (hello) {
    const text = await waitForText(hello, "terminal", /Hello, browser!/);
    check(
      /Hello, browser!/.test(text),
      "hello.lua's output is on the terminal (and its lib/ file was there)",
    );
    check(/running on CraftOS 1\.8/.test(text), "it runs on the CraftOS ROM");
    check(
      await hello.evaluate(
        () => !!document.querySelector('a[href="https://tweaked.cc"]'),
      ),
      'the player links to https://tweaked.cc ("Uses CC:Tweaked")',
    );
    if (shots) await page.screenshot({ path: join(shots, "hello.png") });
    if (!/Hello/.test(text)) console.log(text);
  }

  // 2. mon.lua with its world: a monitor, and a touch on it
  await run(page, "mon.lua");
  const mon = await playerFrame(page, "mon.lua");
  check(!!mon, "mon.lua opens a player");
  if (mon) {
    const monText = await waitForText(mon, "top", /ON THE MONITOR/);
    const screens = await mon.evaluate(() =>
      window.craftosPlayer.screens().map((s) => `${s.kind}:${s.name}`),
    );
    check(
      screens.includes("monitor:top"),
      `the world's monitor is there (${screens.join(", ")})`,
    );
    check(/ON THE MONITOR/.test(monText), "the program wrote on the monitor");
    await waitForText(mon, "terminal", /waiting for a touch/);
    await mon.evaluate(() => window.craftosPlayer.touch("top", 4, 3));
    const after = await waitForText(mon, "terminal", /touched top at 4,3/);
    check(
      /touched top at 4,3/.test(after),
      "a monitor touch reaches the program",
    );
    if (shots) await page.screenshot({ path: join(shots, "monitor.png") });
  }

  // 3. the keyboard: click the terminal, type, Enter
  await run(page, "ask.lua");
  const ask = await playerFrame(page, "ask.lua");
  check(!!ask, "ask.lua opens a player");
  if (ask) {
    await waitForText(ask, "terminal", /name\? /);
    await ask.locator(".ccp-screen.ccp-terminal").click();
    await page.keyboard.type("bob");
    await page.keyboard.press("Enter");
    const text = await waitForText(ask, "terminal", /hi bob/);
    check(/hi bob/.test(text), "typing on the keyboard reaches read()");
    if (shots) await page.screenshot({ path: join(shots, "keyboard.png") });
  }

  // 4. desktop-only commands are hidden (with a .lua file in front, where Run in CraftOS is offered)
  await page.keyboard.press("Escape");
  await openFile(page, "hello.lua");
  const listed = (await command(page, "craftos-mcp:")).join("\n");
  await page.keyboard.press("Escape");
  for (const hidden of [
    "Add to Claude Code",
    "Copy MCP Server JSON",
    "Restart MCP Server",
    "Cursor / Windsurf",
  ])
    check(
      !listed.includes(hidden),
      `"${hidden}" is not in the command palette`,
    );
  check(
    listed.includes("Run in CraftOS"),
    "Run in CraftOS is in the command palette",
  );

  if (failures.length) {
    console.log("--- browser console (last 60) ---");
    console.log(
      logs
        .filter((l) => !/%c (INFO|WARN)/.test(l))
        .slice(-80)
        .join("\n"),
    );
  }
} catch (error) {
  failures.push(String(error?.stack ?? error));
  if (shots)
    await page
      ?.screenshot({ path: join(shots, "failure.png") })
      .catch(() => {});
  console.error(error);
} finally {
  await browser?.close();
  server.kill();
  rmSync(scratch, { recursive: true, force: true });
}
console.log(failures.length ? `${failures.length} failed` : "all passed");
process.exit(failures.length ? 1 : 0);
