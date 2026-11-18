// Check a built CraftOS desktop app the way a person would meet it, on the platform this runs on.
//
//   node apps/desktop/scripts/check.mjs <release folder> [--install-dir <folder>] [--keep]
//
// <release folder> is what build.mjs wrote. The app is started with --self-test on a small project in a scratch
// folder, with an empty per-user folder (CRAFTOS_HOME), so the first run is real: it downloads CC:Tweaked's jar,
// builds the ROM, starts the project's program in a computer, reads "Hello from" off its screen, serves the browser
// app and runs the project's test. Then:
//   Windows  the installer is run silently (per user, no admin) into --install-dir (default: a scratch folder), the
//            Start-menu shortcut is looked for, the self test runs from the installed copy, and the uninstaller is
//            run and must leave nothing behind. --keep leaves it installed.
//   macOS    the .dmg is mounted, its CraftOS.app must be there with a valid (ad hoc) signature, and the self test
//            runs from the mounted app.
//   Linux    the AppImage and the .deb must be there, the .deb must hold the app, and the self test runs from the
//            unpacked app under xvfb (the AppImage is the same files in one executable).
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  args.splice(at, 2);
  return value;
};
const keep = args.includes("--keep");
if (keep) args.splice(args.indexOf("--keep"), 1);
const installOption = option("--install-dir");
if (args.length !== 1) {
  console.error(
    "usage: node apps/desktop/scripts/check.mjs <release folder> [--install-dir <folder>] [--keep]",
  );
  process.exit(2);
}
const OUT = resolve(args[0]);
const SCRATCH = mkdtempSync(join(tmpdir(), "craftos-check-"));

let failed = false;
const say = (ok, what, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${extra ? `  (${extra})` : ""}`);
  if (!ok) failed = true;
};
const files = readdirSync(OUT);
const find = (re) => files.find((f) => re.test(f));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A project as New project makes it. */
function project() {
  const dir = join(SCRATCH, "hello-project");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "hello.lua"),
    'term.clear() term.setCursorPos(1, 1) print("Hello from the check")\n',
  );
  writeFileSync(
    join(dir, "hello.test.lua"),
    'ccunit.test("numbers add up", function() ccunit.eq(1 + 1, 2) end)\n',
  );
  writeFileSync(
    join(dir, "craftos.json"),
    `${JSON.stringify({ workspace: ".", run: "hello.lua" }, null, 2)}\n`,
  );
  return dir;
}

/** Start the app with --self-test and read its report. `wrap`: a command to run it under (xvfb-run). */
function selfTest(exe, label, wrap = [], extra = []) {
  const report = join(SCRATCH, `${label}.json`);
  const env = {
    ...process.env,
    CRAFTOS_HOME: join(SCRATCH, `${label}-home`),
  };
  // a terminal started from an Electron app (an editor) hands this down; it would make the app run as plain Node
  delete env.ELECTRON_RUN_AS_NODE;
  const argv = [
    ...wrap,
    exe,
    ...extra,
    `--self-test=${project()}`,
    `--self-test-out=${report}`,
    `--user-data=${join(SCRATCH, `${label}-user-data`)}`,
  ];
  const started = Date.now();
  const result = spawnSync(argv[0], argv.slice(1), {
    env,
    stdio: ["ignore", "inherit", "inherit"],
    timeout: 10 * 60 * 1000,
  });
  let data;
  try {
    data = JSON.parse(readFileSync(report, "utf8"));
  } catch {
    data = { ok: false, error: `no report (exit ${result.status})` };
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  say(
    data.ok === true && result.status === 0,
    `${label}: first run builds the ROM, the program runs, the browser app is served, the test passes`,
    data.ok
      ? `v${data.version} ${data.platform}, ${seconds} s, screen: ${data.screen?.[0]}, tests: ${data.tests?.passed} passed`
      : JSON.stringify(data),
  );
  const rom = join(env.CRAFTOS_HOME, data.version ?? "", "rom");
  say(
    existsSync(rom) && readdirSync(rom).length > 0,
    `${label}: the ROM was built on this machine, into the per-user folder`,
    existsSync(rom) ? readdirSync(rom).join(", ") : "none",
  );
  return data;
}

function run(command, argv, options = {}) {
  return spawnSync(command, argv, { encoding: "utf8", ...options });
}

async function windows() {
  const setup = find(/-windows-x64-setup\.exe$/);
  say(Boolean(setup), "the installer is there", setup);
  say(
    Boolean(find(/^latest\.yml$/)),
    "latest.yml (for the app's own updates) is there",
  );
  say(
    Boolean(find(/-setup\.exe\.blockmap$/)),
    "the installer's .blockmap is there",
  );
  if (!setup) return;
  const latest = readFileSync(join(OUT, "latest.yml"), "utf8");
  say(latest.includes(setup), "latest.yml names this installer");

  const dir = resolve(installOption ?? join(SCRATCH, "installed", "CraftOS"));
  const shortcut = join(
    process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "CraftOS.lnk",
  );
  // An engine that has nothing to do with the app (as an MCP server's or a test run's would be) keeps running
  // through the install and the uninstall: the installer closes the app by its program's name before it touches
  // files, and that name must never match craftos.exe.
  const bystanderDir = join(SCRATCH, "bystander");
  mkdirSync(bystanderDir, { recursive: true });
  copyFileSync(process.execPath, join(bystanderDir, "craftos.exe"));
  const bystander = spawn(
    join(bystanderDir, "craftos.exe"),
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: "ignore" },
  );
  let bystanderGone = false;
  bystander.once("exit", () => (bystanderGone = true));

  // /S: no questions. /D: where to (NSIS wants it last and unquoted). No admin: the installer is per user.
  const installed = run(join(OUT, setup), ["/S", `/D=${dir}`], {
    windowsVerbatimArguments: true,
    timeout: 5 * 60 * 1000,
  });
  const exe = join(dir, "CraftOS-Desktop.exe");
  for (let i = 0; i < 120 && !existsSync(exe); i++) await sleep(500);
  say(
    installed.status === 0 && existsSync(exe),
    "the installer installs without admin rights",
    dir,
  );
  await sleep(500);
  say(!bystanderGone, "installing leaves a running craftos.exe engine alone");
  say(
    existsSync(shortcut),
    'a Start-menu shortcut "CraftOS" is made',
    shortcut,
  );
  say(
    existsSync(join(dir, "resources", "engine", "craftos.exe")) &&
      existsSync(join(dir, "resources", "craftos", "craftos-package.json")),
    "the engine and the emulator's files are inside",
  );
  say(
    !existsSync(join(dir, "resources", "craftos", "rom")),
    "no CC:Tweaked ROM is shipped",
  );
  if (existsSync(exe)) selfTest(exe, "installed");
  if (keep) return bystander.kill();
  const uninstaller = readdirSync(dir).find((f) =>
    /^Uninstall .*\.exe$/.test(f),
  );
  say(Boolean(uninstaller), "an uninstaller is there", uninstaller);
  if (!uninstaller) return bystander.kill();
  run(join(dir, uninstaller), ["/S"], { timeout: 5 * 60 * 1000 });
  // the uninstaller hands over to a copy of itself and returns at once
  for (let i = 0; i < 120 && (existsSync(exe) || existsSync(shortcut)); i++)
    await sleep(500);
  say(!bystanderGone, "uninstalling leaves a running craftos.exe engine alone");
  bystander.kill();
  say(!existsSync(exe), "uninstalling removes the app");
  say(!existsSync(shortcut), "and its Start-menu shortcut");
  const left = existsSync(dir) ? readdirSync(dir) : [];
  say(
    left.length === 0,
    "and leaves nothing in the install folder",
    left.join(", "),
  );
}

function mac() {
  const dmg = find(new RegExp(`-macos-${process.arch}\\.dmg$`));
  say(Boolean(dmg), "the .dmg is there", dmg);
  if (!dmg) return;
  const mount = join(SCRATCH, "mount");
  mkdirSync(mount);
  const attached = run("hdiutil", [
    "attach",
    join(OUT, dmg),
    "-nobrowse",
    "-readonly",
    "-mountpoint",
    mount,
  ]);
  say(attached.status === 0, "the .dmg mounts", attached.stderr?.trim());
  const app = join(mount, "CraftOS.app");
  try {
    say(existsSync(app), "CraftOS.app is in it");
    say(
      existsSync(join(mount, "Applications")),
      "with the Applications shortcut to drag it onto",
    );
    const signed = run("codesign", ["--verify", "--deep", app]);
    say(
      signed.status === 0,
      "its ad hoc signature holds",
      signed.stderr?.trim(),
    );
    say(
      existsSync(join(app, "Contents", "Resources", "engine", "craftos")) &&
        !existsSync(join(app, "Contents", "Resources", "craftos", "rom")),
      "the engine is inside, and no CC:Tweaked ROM",
    );
    selfTest(join(app, "Contents", "MacOS", "CraftOS"), "from-dmg");
  } finally {
    run("hdiutil", ["detach", mount, "-force"]);
  }
}

function linux() {
  const appImage = find(/-linux-x64\.AppImage$/);
  const deb = find(/-linux-x64\.deb$/);
  say(Boolean(appImage), "the AppImage is there", appImage);
  say(Boolean(deb), "the .deb is there", deb);
  say(
    Boolean(find(/^latest-linux\.yml$/)),
    "latest-linux.yml (for the AppImage's own updates) is there",
  );
  if (deb) {
    const listing = run("dpkg-deb", ["--contents", join(OUT, deb)]);
    say(
      listing.status === 0 &&
        /resources\/engine\/craftos\n/.test(listing.stdout) &&
        /resources\/craftos\/craftos-package\.json/.test(listing.stdout) &&
        /\.desktop\n/.test(listing.stdout),
      "the .deb holds the app, the engine and a menu entry",
    );
    say(
      !/resources\/craftos\/rom\//.test(listing.stdout),
      "and no CC:Tweaked ROM",
    );
  }
  const exe = join(OUT, "linux-unpacked", "craftos-desktop");
  say(existsSync(exe), "the unpacked app is there");
  if (!existsSync(exe)) return;
  const xvfb = run("which", ["xvfb-run"]).status === 0;
  // a display for Chromium; its sandbox needs a setuid helper that only an installed package has
  selfTest(exe, "unpacked", xvfb ? ["xvfb-run", "-a"] : [], ["--no-sandbox"]);
}

try {
  if (process.platform === "win32") await windows();
  else if (process.platform === "darwin") mac();
  else linux();
} finally {
  try {
    rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // a file still held for a moment after the app exits
  }
}
console.log(
  failed
    ? "\nthe desktop app did not pass its check"
    : "\nthe desktop app passed its check",
);
process.exit(failed ? 1 : 0);
