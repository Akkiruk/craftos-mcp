// Runs inside VS Code (run.mjs starts it): checks the installed extension end to end against the real emulator.
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { dirname, join } = require("node:path");
const vscode = require("vscode");

async function until(test, what, ms = 60_000) {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function untilAsync(test, what, ms = 60_000) {
  const end = Date.now() + ms;
  while (!(await test())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

function killTreeByPid(pid) {
  if (process.platform === "win32")
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
    });
  else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      process.kill(pid, "SIGKILL");
    }
  }
}

/** A newline-JSON MCP client on a child's stdio. */
function client(child) {
  let buffer = "";
  let nextId = 1;
  const waiting = new Map();
  child.stderr.on("data", () => undefined);
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
    }
  });
  return {
    notify(method) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
    },
    request(method, params, ms = 240_000) {
      const id = nextId++;
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`${method} timed out`)),
          ms,
        );
        waiting.set(id, (msg) => {
          clearTimeout(timer);
          waiting.delete(id);
          msg.error
            ? reject(new Error(msg.error.message))
            : resolve(msg.result);
        });
      });
    },
  };
}

const project = process.env.CRAFTOS_PROJECT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function step(name, body) {
  const started = Date.now();
  try {
    await body();
    console.log(`  ok   ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    console.log(`  FAIL ${name}: ${error.stack ?? error}`);
    throw error;
  }
}

/** Record what a test run reports, by wrapping the controller's createTestRun. */
function recordRuns(controller) {
  const log = [];
  const create = controller.createTestRun.bind(controller);
  controller.createTestRun = (...args) => {
    const run = create(...args);
    for (const method of ["passed", "failed", "errored", "skipped"]) {
      const original = run[method].bind(run);
      run[method] = (item, message, duration) => {
        log.push({ method, id: item.id, label: item.label, message });
        return original(item, message, duration);
      };
    }
    return run;
  };
  return log;
}

exports.run = async function run() {
  const ext = vscode.extensions.getExtension("Rogiedoji.craftos-mcp");
  assert.ok(ext, "the installed extension is not there");
  const api = await ext.activate();

  await step("commands are registered", async () => {
    const all = await vscode.commands.getCommands(true);
    for (const id of [
      "craftos-mcp.runInCraftOS",
      "craftos-mcp.addToClaudeCode",
      "craftos-mcp.copyMcpJson",
      "craftos-mcp.restartServer",
      "craftos-mcp.addToEditor",
      "craftos-mcp.newTest",
      "craftos-mcp.newWorld",
      "craftos-mcp.showLog",
      "craftos-mcp.menu",
      "craftos-mcp.walkthrough",
      "craftos-mcp.setUpLuaTypes",
    ])
      assert.ok(all.includes(id), id);
    const pkg = ext.packageJSON.contributes;
    assert.equal(pkg.walkthroughs[0].id, "craftos-mcp.start");
    assert.equal(pkg.jsonValidation[0].url, "./schemas/world.schema.json");
    const schema = require(
      join(ext.extensionPath, "schemas", "world.schema.json"),
    );
    assert.equal(schema.type, "object");
    assert.ok(api.status.item.text.includes("CraftOS"), api.status.item.text);
  });

  await step(
    "the world schema is the real one: a typo'd key is flagged, peripheral types complete",
    async () => {
      const schema = require(
        join(ext.extensionPath, "schemas", "world.schema.json"),
      );
      assert.ok(
        schema.properties?.peripherals,
        "the stand-in schema was packed, not schemas/world.schema.json",
      );
      assert.deepEqual(
        ext.packageJSON.contributes.jsonValidation[0].fileMatch,
        ["*.world.json"],
      );
      const typo = vscode.Uri.file(join(project, "typo.world.json"));
      await vscode.window.showTextDocument(typo);
      await until(
        () =>
          vscode.languages
            .getDiagnostics(typo)
            .some((d) => /periferals/.test(d.message)),
        "a diagnostic on the typo'd key",
      );
      const message = vscode.languages
        .getDiagnostics(typo)
        .find((d) => /periferals/.test(d.message)).message;
      console.log(`       ${message}`);

      const text = '{\n  "peripherals": [{ "name": "x", "type": "" }]\n}\n';
      const file = join(project, "complete.world.json");
      writeFileSync(file, text);
      const uri = vscode.Uri.file(file);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
      const at = doc.positionAt(text.indexOf('"type": "') + '"type": "'.length);
      let labels = [];
      await untilAsync(async () => {
        const list = await vscode.commands.executeCommand(
          "vscode.executeCompletionItemProvider",
          uri,
          at,
        );
        labels = (list?.items ?? []).map((i) =>
          String(typeof i.label === "string" ? i.label : i.label.label).replace(
            /"/g,
            "",
          ),
        );
        return labels.includes("playerDetector");
      }, "playerDetector among the type completions");
      console.log(
        `       ${labels.length} peripheral types complete, playerDetector among them`,
      );
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      rmSync(file);
    },
  );

  await step(
    "Set Up Lua Types appends to the workspace's Lua settings and keeps the user's own",
    async () => {
      if (process.env.CRAFTOS_LUA_INSTALLED !== "1") {
        // without the Lua extension the command offers to install it and waits for an answer nobody gives here
        console.log("       skipped: sumneko.lua could not be installed");
        return;
      }
      const settingsFile = join(project, ".vscode", "settings.json");
      const userSettings = join(
        process.env.CRAFTOS_USER_DATA,
        "User",
        "settings.json",
      );
      const files = vscode.Uri.file(join(project, "files.lua"));
      const doc = await vscode.workspace.openTextDocument(files);
      await vscode.window.showTextDocument(doc);
      const undefinedFs = () =>
        vscode.languages
          .getDiagnostics(files)
          .filter((d) => /Undefined global `fs`/.test(d.message));
      // before: the language server knows nothing of CC
      await until(
        () => undefinedFs().length > 0,
        "Undefined global `fs` before the set up",
        180_000,
      );
      console.log(
        `       before: ${undefinedFs().length} x "${undefinedFs()[0].message}"`,
      );

      await vscode.commands.executeCommand("craftos-mcp.setUpLuaTypes");
      const written = JSON.parse(readFileSync(settingsFile, "utf8"));
      const library = written["Lua.workspace.library"];
      assert.equal(library.length, 2, JSON.stringify(library));
      assert.equal(
        library[0],
        join(project, "otherlib"),
        "the user's library went",
      );
      assert.match(
        library[1],
        /[\\/]globalStorage[\\/]rogiedoji\.craftos-mcp[\\/]lua-addons[\\/]cc-tweaked[\\/]library$/i,
      );
      assert.ok(
        existsSync(join(library[1], "fs.lua")),
        "the copy in globalStorage is missing",
      );
      assert.equal(written["Lua.runtime.version"], "Lua 5.2");
      assert.deepEqual(written["Lua.runtime.builtin"], {
        os: "enable",
        io: "disable",
        ffi: "disable",
        jit: "disable",
      });
      const user = JSON.parse(readFileSync(userSettings, "utf8"));
      assert.deepEqual(user["Lua.workspace.userThirdParty"], [
        dirname(dirname(library[1])),
      ]);
      for (const key of [
        "Lua.workspace.library",
        "Lua.runtime.version",
        "Lua.runtime.builtin",
      ])
        assert.equal(
          user[key],
          undefined,
          `${key} went into the user settings`,
        );

      const once = readFileSync(settingsFile, "utf8");
      await vscode.commands.executeCommand("craftos-mcp.setUpLuaTypes");
      assert.equal(
        readFileSync(settingsFile, "utf8"),
        once,
        "a second set up wrote again",
      );

      // after: fs is known, and its hover comes from our library
      const open = doc.positionAt(doc.getText().indexOf("fs.open") + 4);
      let hover = "";
      await untilAsync(
        async () => {
          const hovers = await vscode.commands.executeCommand(
            "vscode.executeHoverProvider",
            files,
            open,
          );
          hover = (hovers ?? [])
            .flatMap((h) => h.contents)
            .map((c) => (typeof c === "string" ? c : c.value))
            .join("\n");
          return undefinedFs().length === 0 && /tweaked\.cc/.test(hover);
        },
        "no Undefined global `fs` and a hover from the library",
        180_000,
      );
      console.log(
        `       after: no Undefined global \`fs\`; hover on fs.open: ${hover.split("\n").find((l) => l.trim() && !l.startsWith("```")) ?? ""}`,
      );

      await vscode.commands.executeCommand("craftos-mcp.removeLuaTypes");
      const removed = JSON.parse(readFileSync(settingsFile, "utf8"));
      assert.deepEqual(removed["Lua.workspace.library"], [
        join(project, "otherlib"),
      ]);
      const userAfter = JSON.parse(readFileSync(userSettings, "utf8"));
      assert.equal(userAfter["Lua.workspace.userThirdParty"], undefined);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    },
  );

  if (process.env.CRAFTOS_IT_ONLY === "lua") return;

  await step(
    "the walkthrough opens and New Test writes name.test.lua",
    async () => {
      await vscode.commands.executeCommand("craftos-mcp.walkthrough");
      const clock = vscode.Uri.file(join(project, "clock.lua"));
      await vscode.window.showTextDocument(clock);
      await vscode.commands.executeCommand("craftos-mcp.newTest");
      const made = join(project, "clock.test.lua");
      await until(
        () =>
          vscode.window.activeTextEditor?.document.uri.fsPath.toLowerCase() ===
          made.toLowerCase(),
        "the new test open",
      );
      const text = vscode.window.activeTextEditor.document.getText();
      assert.match(text, /shell\.run\("clock\.lua"\)/);
      assert.match(text, /clock\.world\.json/);
      await vscode.window.activeTextEditor.document.save();
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      rmSync(made);
      await api.tests.discover();
    },
  );

  await step(
    "the MCP server definition is the supervisor running npx craftos-mcp@0.3.0 serve in the project",
    async () => {
      const def = api.serverDefinition();
      assert.ok(def instanceof vscode.McpStdioServerDefinition);
      assert.equal(def.command, process.execPath);
      assert.match(def.args[0], /dist[\\/]supervisor\.js$/);
      const supervise = JSON.parse(def.env.CRAFTOS_SUPERVISE);
      assert.deepEqual(supervise.base, ["npx", "-y", "craftos-mcp@0.3.0"]);
      assert.deepEqual(supervise.sub, ["serve"]);
      assert.ok(supervise.pipe, "no restart channel");
      assert.equal(def.cwd.fsPath.toLowerCase(), project.toLowerCase());
      assert.equal(
        def.env.CRAFTOS_WORKSPACE.toLowerCase(),
        project.toLowerCase(),
      );
      assert.equal(api.providedDefinitions().length, 1);
      console.log(`       ${supervise.base.join(" ")} serve`);
    },
  );

  let testSupervisor;
  const config = () => vscode.workspace.getConfiguration("craftos-mcp");
  const same = (a, b) => assert.equal(a.toLowerCase(), b.toLowerCase());

  await step(
    "craftos-mcp.workspace moves the server's and the files' workspace",
    async () => {
      await config().update(
        "workspace",
        "lib",
        vscode.ConfigurationTarget.Workspace,
      );
      try {
        same(
          api.serverDefinition().env.CRAFTOS_WORKSPACE,
          join(project, "lib"),
        );
        same(
          api.runFolder(vscode.Uri.file(join(project, "lib", "x.lua"))),
          join(project, "lib"),
        );
        same(
          api.projectFolder(
            vscode.Uri.file(join(project, "lib", "x.test.lua")),
          ),
          join(project, "lib"),
        );
        // outside the setting's folder: Run uses the program's own folder, the tests the workspace folder
        same(
          api.runFolder(vscode.Uri.file(join(project, "sub", "y.lua"))),
          join(project, "sub"),
        );
        same(
          api.projectFolder(vscode.Uri.file(join(project, "math.test.lua"))),
          project,
        );
        // the Testing view only looks inside the setting's folder
        await api.tests.discover();
        assert.equal(api.tests.controller.items.size, 0);
        await config().update(
          "workspace",
          "no-such-folder",
          vscode.ConfigurationTarget.Workspace,
        );
        same(api.serverDefinition().env.CRAFTOS_WORKSPACE, project);
      } finally {
        await config().update(
          "workspace",
          undefined,
          vscode.ConfigurationTarget.Workspace,
        );
      }
      same(
        api.runFolder(vscode.Uri.file(join(project, "sub", "y.lua"))),
        join(project, "sub"),
      );
      same(api.serverDefinition().env.CRAFTOS_WORKSPACE, project);
    },
  );

  await step(
    "craftos-mcp.registerServer: auto skips a craftos server in .vscode/mcp.json",
    async () => {
      const file = join(project, ".vscode", "mcp.json");
      mkdirSync(join(project, ".vscode"), { recursive: true });
      writeFileSync(
        file,
        '{\n  // dev build\n  "servers": { "craftos-dev": { "type": "stdio", "command": "node", "args": ["x.js"] } }\n}\n',
      );
      try {
        assert.match(api.skipReason() ?? "", /craftos-dev/);
        assert.equal(api.providedDefinitions().length, 0);
        await config().update(
          "registerServer",
          "always",
          vscode.ConfigurationTarget.Workspace,
        );
        assert.equal(api.providedDefinitions().length, 1);
        await config().update(
          "registerServer",
          "never",
          vscode.ConfigurationTarget.Workspace,
        );
        rmSync(file);
        assert.equal(api.providedDefinitions().length, 0);
      } finally {
        rmSync(file, { force: true });
        await config().update(
          "registerServer",
          undefined,
          vscode.ConfigurationTarget.Workspace,
        );
      }
      assert.equal(api.providedDefinitions().length, 1);
    },
  );

  await step(
    "a killed server comes back with its tools, gives up after 3 restarts, and Restart brings it back",
    async () => {
      const def = api.serverDefinition();
      // start it the way VS Code does: the definition's command, no shell, its env on top of ours
      const child = spawn(def.command, def.args, {
        cwd: def.cwd.fsPath,
        env: { ...process.env, ...def.env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      testSupervisor = child.pid;
      const mcp = client(child);
      try {
        await mcp.request("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "craftos-vscode-it", version: "0" },
        });
        mcp.notify("notifications/initialized");
        const before = (await mcp.request("tools/list", {})).tools.length;
        assert.ok(before > 20, `${before} tools`);

        const mine = () =>
          api.serverEvents().filter((e) => e.supervisor === child.pid);
        const started = () => mine().filter((e) => e.type === "started");
        await until(() => started().length >= 1, "started event");
        // two starts already while craftos-mcp@0.3.0 is not on npm: it, then the 0.2.0 fallback
        const base = started().length;
        const fellBack = mine().some((e) => e.type === "fallback");
        console.log(
          `       ${fellBack ? "fell back to 0.2.0" : "runs the pinned version"}`,
        );
        const killLatest = () => killTreeByPid(started().at(-1).pid);

        killLatest();
        await until(
          () => started().length >= base + 1,
          "restart after the kill",
          180_000,
        );
        const after = await mcp.request("tools/list", {});
        assert.equal(after.tools.length, before);
        const info = await mcp.request("tools/call", {
          name: "craftos_info",
          arguments: {},
        });
        assert.ok(!info.isError, JSON.stringify(info).slice(0, 400));
        console.log(`       killed it, back with ${after.tools.length} tools`);

        for (let n = 2; n <= 3; n++) {
          // wait for the new one to answer before killing it, so each kill hits a running server
          await mcp.request("tools/list", {});
          killLatest();
          await until(
            () => started().length >= base + n,
            `restart ${n}`,
            180_000,
          );
        }
        await mcp.request("tools/list", {});
        killLatest();
        await until(
          () => mine().some((e) => e.type === "gave-up"),
          "gave up",
          30_000,
        );
        const refused = await mcp.request("tools/list", {}).then(
          () => "answered",
          (error) => error.message,
        );
        assert.match(refused, /stopped 4 times in 2 minutes/);

        assert.ok(api.restartServer() >= 1, "no supervisor to restart");
        await until(
          () => started().length >= base + 4,
          "start after Restart",
          180_000,
        );
        assert.equal(
          (await mcp.request("tools/list", {})).tools.length,
          before,
        );
        console.log("       gave up after 3 restarts, Restart brought it back");
      } finally {
        child.stdin.end();
        await new Promise((r) => {
          const t = setTimeout(r, 10_000);
          child.on("exit", () => {
            clearTimeout(t);
            r();
          });
        });
      }
      assert.equal(
        alive(child.pid),
        false,
        "the supervisor kept running after stdin closed",
      );
      await until(
        () =>
          api
            .serverEvents()
            .some((e) => e.supervisor === child.pid && e.type === "stopped"),
        "stopped event",
        5_000,
      );
    },
  );

  // VS Code's own copy of the server: started through VS Code, its tools in vscode.lm.tools (what a chat sees)
  const ours = () =>
    vscode.lm.tools
      .filter((t) => /craftos_info$/.test(t.name))
      .map((t) => t.name);
  const supervisors = () => {
    const by = new Map();
    for (const e of api.serverEvents())
      if (e.supervisor !== testSupervisor)
        by.set(e.supervisor, [...(by.get(e.supervisor) ?? []), e]);
    return by;
  };
  const running = () =>
    [...supervisors()].filter(
      ([pid, events]) =>
        alive(pid) && !events.some((e) => e.type === "stopped"),
    );
  const startedIn = (pid) =>
    (supervisors().get(pid) ?? []).filter((e) => e.type === "started");

  await step(
    "VS Code starts the server and its tools show in vscode.lm.tools",
    async () => {
      await vscode.commands.executeCommand("workbench.mcp.startServer", "*");
      await until(
        () => ours().length > 0 && running().length === 1,
        "craftos tools in lm.tools",
        180_000,
      );
      console.log(`       ${ours().join(", ")}`);
      await until(
        () => api.status.state.kind === "running",
        "the status bar to say running",
        30_000,
      );
      console.log(`       status bar: ${api.status.item.text}`);
    },
  );

  await step(
    "a crashed server comes back and VS Code keeps its tools the whole time (F6, F8)",
    async () => {
      const [pid] = running()[0];
      const before = startedIn(pid).length;
      killTreeByPid(startedIn(pid).at(-1).pid);
      let dropped = false;
      const end = Date.now() + 180_000;
      while (startedIn(pid).length === before) {
        if (!ours().length) dropped = true;
        if (Date.now() > end) throw new Error("not restarted");
        await sleep(100);
      }
      await sleep(3000);
      assert.equal(
        dropped,
        false,
        "the tools left vscode.lm.tools while it restarted",
      );
      assert.ok(ours().length > 0, "no tools after the restart");
      assert.equal(running().length, 1);
      assert.equal(running()[0][0], pid, "VS Code started a new supervisor");
    },
  );

  const SERVER_ID = "rogiedoji.craftos-mcp/craftos-mcp";

  await step(
    "VS Code's own Restart starts a new server with its tools (F8)",
    async () => {
      const [old] = running()[0];
      await vscode.commands.executeCommand(
        "workbench.mcp.restartServer",
        SERVER_ID,
      );
      await until(
        () => running().some(([p]) => p !== old),
        "new supervisor",
        60_000,
      );
      await until(() => !alive(old), "the old supervisor to exit", 10_000);
      await sleep(2000);
      assert.ok(ours().length > 0, "no tools after VS Code's restart");
      const [now] = running()[0];
      const events = supervisors()
        .get(old)
        .map((e) => e.type);
      console.log(
        `       ${old} -> ${now}; the old one said ${events.join(", ")}`,
      );
    },
  );

  await step(
    "the whole server process killed from outside: the extension starts it again",
    async () => {
      const [old] = running()[0];
      killTreeByPid(old);
      await until(
        () => running().some(([p]) => p !== old),
        "a new supervisor",
        60_000,
      );
      await sleep(2000);
      assert.ok(ours().length > 0, "no tools after the restart");
      console.log(`       ${old} -> ${running()[0][0]}`);
    },
  );

  await step("copied JSON is the README's server entry", async () => {
    const json = JSON.parse(api.mcpJson("mcpServers"));
    assert.deepEqual(json, {
      mcpServers: {
        craftos: { command: "npx", args: ["-y", "craftos-mcp", "serve"] },
      },
    });
  });

  const controller = api.tests.controller;
  await step(
    "math.test.lua shows in the Testing view with its two tests",
    async () => {
      await api.tests.discover();
      const items = [];
      controller.items.forEach((i) => items.push(i));
      const file = items.find((i) => i.label === "math.test.lua");
      assert.ok(file, `no math.test.lua in ${items.map((i) => i.label)}`);
      assert.deepEqual(
        items.map((i) => i.label),
        ["math.test.lua"],
        "copies in .runtime, .claude/worktrees or node_modules were listed",
      );
      const kids = [];
      file.children.forEach((c) => kids.push([c.label, c.range.start.line]));
      assert.deepEqual(kids, [
        ["adds", 0],
        ["breaks", 1],
      ]);
    },
  );

  await step(
    "running it passes one test and fails the other at line 3",
    async () => {
      const log = recordRuns(controller);
      const source = new vscode.CancellationTokenSource();
      await api.tests.run(new vscode.TestRunRequest(), source.token);
      const byLabel = Object.fromEntries(log.map((e) => [e.label, e]));
      assert.equal(byLabel["adds"]?.method, "passed", JSON.stringify(log));
      const broke = byLabel["breaks"];
      assert.equal(broke?.method, "failed", JSON.stringify(log));
      const message = Array.isArray(broke.message)
        ? broke.message[0]
        : broke.message;
      assert.match(String(message.message), /expected 3 but got 2/);
      assert.equal(
        message.location.uri.fsPath.toLowerCase(),
        join(project, "math.test.lua").toLowerCase(),
      );
      assert.equal(message.location.range.start.line, 2); // line 3, 0-based
      assert.equal(byLabel["math.test.lua"]?.method, "failed");
    },
  );

  await step(
    "Run in CraftOS shows the program with its world and monitor, and closing stops it",
    async () => {
      const running = await api.runInCraftOS(
        vscode.Uri.file(join(project, "clock.lua")),
      );
      assert.ok(running, "no panel");
      const html = running.panel.webview.html;
      assert.match(html, /Content-Security-Policy/);
      assert.match(
        html,
        /default-src 'none'; frame-src http:\/\/127\.0\.0\.1:\d+;/,
      );
      assert.match(html, /<iframe id="app" src="http:\/\/127\.0\.0\.1:\d+\/"/);

      const page = await fetch(running.url + "/");
      assert.equal(page.status, 200);
      assert.equal(page.headers.get("x-frame-options"), null);

      const { sessions } = await (
        await fetch(`${running.url}/api/sessions`)
      ).json();
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].program, "clock.lua");
      let text = "";
      for (let i = 0; i < 60 && !/HELLO Alice/.test(text); i++) {
        await sleep(500);
        text = JSON.stringify(
          await (
            await fetch(`${running.url}/api/sessions/${sessions[0].id}/screens`)
          ).json(),
        );
      }
      assert.match(text, /HELLO Alice/, text);
      assert.match(text, /clock started/, text);

      const pid = running.child.pid;
      running.panel.dispose();
      for (let i = 0; i < 40 && alive(pid); i++) await sleep(250);
      assert.equal(
        alive(pid),
        false,
        "the app is still running after the panel closed",
      );
      assert.equal(api.runningPanels().length, 0);
      const gone = await fetch(`${running.url}/api/sessions`).then(
        () => "still answering",
        () => "gone",
      );
      assert.equal(gone, "gone");
    },
  );
};
