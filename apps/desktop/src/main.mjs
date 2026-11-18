// CraftOS, the desktop app: one window. It opens on the home screen (ui/home.html: recent projects, the Minecraft
// version, the mods, Run and Run tests); Run starts the emulator's browser app for the project and shows it in the
// same window. All the work is in core.mjs; this file is the window, the menus, the dialogs and the updates.
//
// Switches (for scripts and the release checks, not needed by people):
//   --open=<folder>        open on this project
//   --user-data=<folder>   keep recents and settings here instead of the per-user folder
//   --self-test=<folder>   no window: run the project's program, wait for --expect=<text> on its screen, run its
//                          tests, write the result as JSON to --self-test-out=<file> (and stdout), exit 0 or 1
import {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
} from "electron";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  JsonStore,
  RELEASES_URL,
  Recents,
  catalog,
  createProject,
  loadRunner,
  locate,
  newerRelease,
  openComputer,
  projectWorld,
  readProject,
  readSettings,
  runTests,
  saveProject,
  screenText,
  setUpAll,
  startApp,
} from "./core.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const flag = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

if (flag("user-data")) app.setPath("userData", flag("user-data"));
app.setName("CraftOS");

const loc = locate({
  packaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  here,
});
const runner = await loadRunner(loc);
const recents = new Recents(join(app.getPath("userData"), "recent.json"));
const settingsStore = new JsonStore(
  join(app.getPath("userData"), "settings.json"),
  {},
);

/** The app's version: the emulator's own (the package inside), which the installer is named after. */
const version = () => runner.packageVersion?.() ?? app.getVersion();

// ───────────────────────── the self test ─────────────────────────

async function selfTest(dir) {
  const report = {
    ok: false,
    version: version(),
    platform: `${process.platform}-${process.arch}`,
  };
  let running;
  try {
    const project = readProject(runner, dir);
    report.project = {
      minecraft: project.minecraft,
      run: project.run,
      tests: project.tests,
    };
    running = await startApp(loc, project, {
      onLog: (line) => process.stderr.write(`${line}\n`),
    });
    const id = await openComputer(running.url, {
      name: project.name,
      program: project.run,
      ...projectWorld(runner, project.dir),
    });
    const expect = flag("expect") ?? "Hello from";
    const until = Date.now() + 120_000;
    let text = "";
    while (Date.now() < until) {
      text = await screenText(running.url, id);
      if (text.includes(expect)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    report.screen = text
      .split("\n")
      .filter((l) => l.trim())
      .slice(0, 8);
    report.ran = text.includes(expect);
    const page = await fetch(running.url);
    report.page = page.ok && (await page.text()).includes("<html");
    const tests = await runTests(loc, project);
    report.tests = tests.ok
      ? { passed: tests.result.passed, failed: tests.result.failed }
      : { error: tests.message };
    report.ok =
      report.ran &&
      report.page &&
      tests.ok &&
      tests.result.failed === 0 &&
      tests.result.passed > 0;
  } catch (error) {
    report.error = error.message;
  } finally {
    await running?.stop();
  }
  const text = JSON.stringify(report, null, 2);
  const out = flag("self-test-out");
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${text}\n`);
  }
  process.stdout.write(`${text}\n`);
  app.exit(report.ok ? 0 : 1);
}

if (flag("self-test")) {
  await selfTest(flag("self-test"));
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // not awaited: the app's "ready" comes only after this file has finished loading
  void main();
}

// ───────────────────────── the window ─────────────────────────

async function main() {
  /** @type {BrowserWindow | undefined} */
  let win;
  /** The project that is running: its browser app's address and how to stop it. */
  let running;
  let update = { state: "idle" };

  const send = (channel, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  const settings = () => readSettings(settingsStore);
  const applyTheme = () => {
    nativeTheme.themeSource = settings().theme;
  };

  const stopRunning = async () => {
    const was = running;
    running = undefined;
    await was?.stop();
  };

  const setUpdate = (next) => {
    update = next;
    send("update", update);
  };

  /** Windows and the AppImage update themselves; the macOS app (unsigned) and the .deb are told where the new one is. */
  const selfUpdates =
    app.isPackaged &&
    (process.platform === "win32" ||
      (process.platform === "linux" && Boolean(process.env.APPIMAGE)));
  let updater;
  const checkForUpdate = async (asked) => {
    if (!app.isPackaged) return setUpdate({ state: "dev" });
    if (!selfUpdates) {
      const newer = await newerRelease(version());
      return setUpdate(
        newer
          ? { state: "available", ...newer }
          : { state: asked ? "none" : "idle" },
      );
    }
    try {
      if (!updater) {
        updater = (await import("electron-updater")).default.autoUpdater;
        updater.autoDownload = true;
        updater.autoInstallOnAppQuit = true;
        // a mirror of the release files, for trying an update without publishing one
        if (process.env.CRAFTOS_UPDATE_URL)
          updater.setFeedURL({
            provider: "generic",
            url: process.env.CRAFTOS_UPDATE_URL,
          });
        updater.on("update-available", (info) =>
          setUpdate({ state: "downloading", version: info.version }),
        );
        updater.on("update-not-available", () =>
          setUpdate({ state: asked ? "none" : "idle" }),
        );
        updater.on("update-downloaded", (info) =>
          setUpdate({ state: "ready", version: info.version }),
        );
        updater.on("error", (error) =>
          setUpdate({
            state: "failed",
            message: String(error?.message ?? error).split("\n")[0],
            url: RELEASES_URL,
          }),
        );
      }
      if (asked) setUpdate({ state: "checking" });
      await updater.checkForUpdates();
    } catch (error) {
      setUpdate({
        state: "failed",
        message: String(error?.message ?? error).split("\n")[0],
        url: RELEASES_URL,
      });
    }
  };

  const handlers = {
    state: () => ({
      version: version(),
      platform: process.platform,
      packaged: loc.packaged,
      catalog: catalog(runner),
      recents: recents.list(),
      settings: settings(),
      update,
      running: running ? { dir: running.project.dir, url: running.url } : null,
      startWith: flag("open") ?? null,
      documents: app.getPath("documents"),
    }),
    "project:pick": async () => {
      const picked = await dialog.showOpenDialog(win, {
        title: "Open the folder with your Lua programs",
        properties: ["openDirectory", "createDirectory"],
      });
      return picked.canceled ? null : picked.filePaths[0];
    },
    "project:read": (dir, remember) => {
      const project = readProject(runner, dir);
      if (remember) recents.add(project.dir);
      return project;
    },
    "project:save": (dir, change) => saveProject(runner, dir, change),
    "project:create": (options) => {
      const dir = createProject(runner, options);
      recents.add(dir);
      return dir;
    },
    "recents:list": () => recents.list(),
    "recents:remove": (dir) => {
      recents.remove(dir);
      return recents.list();
    },
    "run:start": async (dir) => {
      await stopRunning();
      // Run writes the choices down, so the folder works the same from the command line and for an AI agent
      let project = readProject(runner, dir);
      if (!project.hasFile) project = saveProject(runner, dir, {});
      if (project.errors.length)
        throw new Error(`craftos.json: ${project.errors.join("; ")}`);
      recents.add(project.dir);
      const started = await startApp(loc, project, {
        onLog: (line) => send("progress", line),
      });
      running = { ...started, project };
      started.exit.then(() => {
        if (running?.url === started.url) {
          running = undefined;
          send("stopped", { dir: project.dir });
        }
      });
      try {
        send("progress", "Starting the computer");
        await openComputer(started.url, {
          name: project.name,
          program: project.run,
          ...projectWorld(runner, project.dir),
        });
      } catch (error) {
        await stopRunning();
        throw error;
      }
      return { url: started.url, project };
    },
    "run:stop": () => stopRunning(),
    "tests:run": (dir) => {
      let project = readProject(runner, dir);
      if (!project.hasFile) project = saveProject(runner, dir, {});
      return runTests(loc, project, {
        onLog: (line) => send("progress", line),
      });
    },
    "settings:set": (change) => {
      settingsStore.write({ ...settings(), ...change });
      applyTheme();
      return settings();
    },
    "setup:all": () =>
      setUpAll(loc, { onLog: (line) => send("progress", line) }),
    "update:check": () => checkForUpdate(true),
    "update:install": () => {
      if (update.state === "ready" && updater) {
        void stopRunning().then(() => updater.quitAndInstall(true, true));
      } else if (update.url) void shell.openExternal(update.url);
    },
    "open:folder": (dir) => shell.openPath(dir),
    "open:file": (file) => shell.showItemInFolder(file),
    "open:link": (url) => {
      if (/^https:\/\//.test(url)) void shell.openExternal(url);
    },
  };
  for (const [name, handler] of Object.entries(handlers))
    ipcMain.handle(name, async (_event, ...args) => {
      try {
        return { ok: true, value: await handler(...args) };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    });

  await app.whenReady();
  applyTheme();
  Menu.setApplicationMenu(
    process.platform === "darwin"
      ? Menu.buildFromTemplate([
          { role: "appMenu" },
          { role: "editMenu" },
          { role: "windowMenu" },
        ])
      : null,
  );

  const createWindow = () => {
    win = new BrowserWindow({
      width: 1180,
      height: 780,
      minWidth: 640,
      minHeight: 480,
      title: "CraftOS",
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#17181c" : "#f5f5f2",
      icon: existsSync(join(here, "..", "build", "icon.png"))
        ? join(here, "..", "build", "icon.png")
        : undefined,
      webPreferences: {
        preload: join(here, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    // the window shows our own page and, inside it, the emulator's page on this machine: links go to the browser
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith("file:")) event.preventDefault();
    });
    void win.loadFile(join(here, "..", "ui", "home.html"));
    win.on("closed", () => {
      win = undefined;
    });
  };
  createWindow();

  app.on("second-instance", () => {
    if (!win) return createWindow();
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on("activate", () => {
    if (!win) createWindow();
  });
  app.on("window-all-closed", () => app.quit());
  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting || !running) return;
    // the computers are shut down first, never left running behind a closed window
    event.preventDefault();
    quitting = true;
    void stopRunning().finally(() => app.quit());
  });

  if (settings().autoUpdate) setTimeout(() => void checkForUpdate(false), 3000);
}
