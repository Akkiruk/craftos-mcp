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
      "craftos-mcp.openWorldEditor",
      "craftos-mcp.openSettings",
      "craftos-mcp.watchAgents",
    ])
      assert.ok(all.includes(id), id);
    // every command has a title that reads as one in the palette, and the ones that only make sense from a lens or a
    // quick fix are not in it
    const contributed = ext.packageJSON.contributes.commands;
    assert.deepEqual(
      contributed
        .filter((c) => !/^[A-Z]/.test(c.title) || c.category !== "craftos-mcp")
        .map((c) => c.command),
      [],
    );
    assert.equal(
      new Set(contributed.map((c) => c.title)).size,
      contributed.length,
      "two commands with one title",
    );
    assert.ok(
      contributed.every((c) => all.includes(c.command)),
      contributed
        .filter((c) => !all.includes(c.command))
        .map((c) => c.command)
        .join(", "),
    );
    const hidden = ext.packageJSON.contributes.menus.commandPalette
      .filter((m) => m.when === "false")
      .map((m) => m.command);
    assert.deepEqual(hidden.sort(), [
      "craftos-mcp.debugTest",
      "craftos-mcp.enableAddon",
      "craftos-mcp.runTest",
    ]);
    // the settings come in a set order, the pack first and the developer's command last
    const props = Object.entries(
      ext.packageJSON.contributes.configuration.properties,
    ).sort((a, b) => a[1].order - b[1].order);
    assert.equal(props[0][0], "craftos-mcp.minecraftVersion");
    assert.equal(props[props.length - 1][0], "craftos-mcp.command");
    assert.ok(
      props.every(
        ([, p]) => typeof p.order === "number" && p.markdownDescription,
      ),
      "a setting without an order or a description",
    );
    const pkg = ext.packageJSON.contributes;
    assert.equal(pkg.walkthroughs[0].id, "craftos-mcp.start");
    assert.equal(pkg.jsonValidation[0].url, "./schemas/world.schema.json");
    const schema = require(
      join(ext.extensionPath, "schemas", "world.schema.json"),
    );
    assert.equal(schema.type, "object");
    // one status bar item: the pack it names, and a menu with the pickers in it
    assert.equal(api.status.item.text, "$(circuit-board) CraftOS 1.21.1");
    assert.equal(api.status.item.command, "craftos-mcp.menu");
    const menu = api.menuItems(false, true).filter((i) => i.command);
    assert.ok(
      menu.every((i) => all.includes(i.command)),
      "a menu entry without its command",
    );
    for (const id of [
      "craftos-mcp.runInCraftOS",
      "craftos-mcp.debugInCraftOS",
      "craftos-mcp.pickMinecraftVersion",
      "craftos-mcp.pickAddons",
      "craftos-mcp.restartServer",
    ])
      assert.ok(
        menu.some((i) => i.command === id),
        id,
      );
    assert.ok(
      !api
        .menuItems(false, false)
        .some((i) => i.command === "craftos-mcp.runInCraftOS"),
      "Run in the menu without a Lua file open",
    );
    assert.equal(
      menu.find((i) => i.command === "craftos-mcp.pickMinecraftVersion")
        .description,
      "1.21.1 (CC:Tweaked 1.121.0), the default",
    );
    assert.equal(
      menu.find((i) => i.command === "craftos-mcp.pickAddons").description,
      "19 of 19 on",
    );
    assert.ok(
      all.includes("craftos-mcp.debugInCraftOS"),
      "craftos-mcp.debugInCraftOS",
    );
  });

  if (process.env.CRAFTOS_IT_ONLY === "debug") return debuggerSteps(api);

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
    "a world file opens in the World Editor, its edits are text edits, and it reopens as text",
    async () => {
      const { viewType, edit, lastRender } = api.worldEditor;
      assert.deepEqual(
        ext.packageJSON.contributes.customEditors.map((e) => [
          e.viewType,
          e.selector[0].filenamePattern,
          e.priority,
        ]),
        [[viewType, "*.world.json", "default"]],
      );
      const file = join(project, "base.world.json");
      const original = readFileSync(file, "utf8");
      const uri = vscode.Uri.file(file);
      const key = uri.toString();
      const activeInput = () =>
        vscode.window.tabGroups.activeTabGroup.activeTab?.input;

      // a world file opens in it by default
      await vscode.commands.executeCommand("vscode.open", uri);
      await until(
        () =>
          activeInput() instanceof vscode.TabInputCustom &&
          activeInput().viewType === viewType,
        "the World Editor tab",
      );
      // its webview ran under the real CSP and drew the computer: the monitor and the modem on their sides, the chest
      // on the network and the other computer in the folder
      await until(
        () => lastRender.get(key),
        "the World Editor drawing the world",
        30_000,
      );
      const seen = lastRender.get(key);
      console.log(`       drew ${JSON.stringify(seen)}`);
      assert.equal(seen.parseError, false);
      assert.equal(seen.tiles, 3, "monitor, modem and the computer");
      // the chest, and the folder's other parseable world files as other computers: relay, clock and typo
      assert.equal(
        seen.rows,
        4,
        "the chest on the network and relay, clock and typo .world.json",
      );
      assert.equal(seen.problems, 0);

      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.toString() === key,
      );
      assert.ok(doc, "the World Editor's text document");
      assert.equal(doc.getText(), original, "opening changes nothing");
      assert.equal(doc.isDirty, false);

      // the webview's edit path: only the edited part changes, CRLF stays, and the document is dirty
      lastRender.delete(key);
      await edit(doc, [
        { op: "set", path: ["peripherals", 0, "kind"], value: "wired" },
        { op: "set", path: ["peripherals", 0, "network"], value: "base" },
        { op: "remove", path: ["monitors", 0, "blocksHigh"] },
      ]);
      const edited = original
        .replace('"kind": "ender" }', '"kind": "wired", "network": "base" }')
        .replace(', "blocksHigh": 2 }', " }");
      assert.equal(doc.getText(), edited);
      assert.equal(doc.isDirty, true);
      await until(
        () => lastRender.get(key),
        "the World Editor redrawing after the edit",
      );

      // undo and redo are the text document's own
      await vscode.commands.executeCommand("undo");
      await until(
        () => doc.getText() === original,
        "undo to give the file back",
      );
      await vscode.commands.executeCommand("redo");
      await until(
        () => doc.getText() === edited,
        "redo to make the edit again",
      );
      assert.ok(await doc.save());
      assert.equal(readFileSync(file, "utf8"), edited);

      // a schema problem shows in the editor's count
      lastRender.delete(key);
      await edit(doc, [
        { op: "set", path: ["peripherals", 0, "kind"], value: "laser" },
      ]);
      await until(
        () => lastRender.get(key)?.problems === 1,
        "the schema problem counted",
      );
      await vscode.commands.executeCommand("undo");
      await until(() => doc.getText() === edited, "undo of the bad kind");

      // Reopen Editor With... Text Editor
      await vscode.commands.executeCommand("vscode.openWith", uri, "default");
      await until(
        () =>
          activeInput() instanceof vscode.TabInputText &&
          activeInput().uri.toString() === key,
        "the text editor tab",
      );
      // and back
      await vscode.commands.executeCommand("craftos-mcp.openWorldEditor", uri);
      await until(
        () => activeInput() instanceof vscode.TabInputCustom,
        "the World Editor again",
      );

      // a file that does not parse says where, and does not get written
      const broken = vscode.Uri.file(join(project, "broken.world.json"));
      const brokenText = readFileSync(broken.fsPath, "utf8");
      await vscode.commands.executeCommand("vscode.openWith", broken, viewType);
      await until(
        () => lastRender.get(broken.toString())?.parseError === true,
        "the broken file's message",
      );
      assert.equal(
        vscode.workspace.textDocuments.find(
          (d) => d.uri.toString() === broken.toString(),
        ).isDirty,
        false,
      );
      assert.equal(readFileSync(broken.fsPath, "utf8"), brokenText);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
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

  const packConfig = () => vscode.workspace.getConfiguration("craftos-mcp");
  const resetPack = async () => {
    await packConfig().update(
      "minecraftVersion",
      undefined,
      vscode.ConfigurationTarget.Workspace,
    );
    await packConfig().update(
      "addons",
      undefined,
      vscode.ConfigurationTarget.Workspace,
    );
  };

  await step(
    "the status bar's pack picker writes the version and addons the server gets",
    async () => {
      const commands = await vscode.commands.getCommands(true);
      for (const id of [
        "craftos-mcp.pickMinecraftVersion",
        "craftos-mcp.pickAddons",
        "craftos-mcp.runTest",
      ])
        assert.ok(commands.includes(id), id);
      assert.equal(api.status.item.text, "$(circuit-board) CraftOS 1.21.1");
      try {
        // the real picker: Default, 1.21.1, 1.20.1, 1.18.2; the last one
        const picked = vscode.commands.executeCommand(
          "craftos-mcp.pickMinecraftVersion",
        );
        await sleep(1000);
        for (let i = 0; i < 3; i++)
          await vscode.commands.executeCommand(
            "workbench.action.quickOpenSelectNext",
          );
        await vscode.commands.executeCommand(
          "workbench.action.acceptSelectedQuickOpenItem",
        );
        await picked;
        assert.equal(packConfig().get("minecraftVersion"), "1.18.2");
        assert.equal(
          packConfig().inspect("minecraftVersion").workspaceValue,
          "1.18.2",
          "not a workspace setting",
        );
        assert.equal(api.serverDefinition().env.CRAFTOS_VERSION, "1.18.2");
        assert.equal(api.status.item.text, "$(circuit-board) CraftOS 1.18.2");
        assert.ok(
          api.status.item.tooltip.value.includes(
            "Minecraft 1.18.2 (CC:Tweaked 1.101.3), addons: 15 of 15 on",
          ),
          api.status.item.tooltip.value,
        );

        // the checklist: everything is on; untick the focused one and accept
        const listed = vscode.commands.executeCommand("craftos-mcp.pickAddons");
        await sleep(1000);
        await vscode.commands.executeCommand(
          "workbench.action.quickOpenSelectNext",
        );
        await vscode.commands.executeCommand(
          "workbench.action.quickPickManyToggle",
        );
        await vscode.commands.executeCommand(
          "workbench.action.acceptSelectedQuickOpenItem",
        );
        await listed;
        const spec = packConfig().get("addons");
        assert.equal(spec.split(",").length, 14, spec);
        assert.equal(api.serverDefinition().env.CRAFTOS_ADDONS, spec);
        console.log(
          `       picked 1.18.2 and ${spec.split(",").length} addons`,
        );

        // by argument (the quick fixes use it); what an addon needs comes with it
        await vscode.commands.executeCommand("craftos-mcp.pickAddons", [
          "mekanism-generators",
          "bigger-reactors",
        ]);
        assert.equal(
          packConfig().get("addons"),
          "mekanism,mekanism-generators,bigger-reactors",
        );
        // 1.21.1 has no Bigger Reactors: it comes out of the list
        await vscode.commands.executeCommand(
          "craftos-mcp.pickMinecraftVersion",
          "1.21.1",
        );
        assert.equal(
          packConfig().get("addons"),
          "mekanism,mekanism-generators",
        );
        assert.equal(
          api.status.item.text,
          "$(circuit-board) CraftOS 1.21.1 · 2/19 addons",
        );
      } finally {
        await resetPack();
      }
      assert.equal(api.serverDefinition().env.CRAFTOS_VERSION, undefined);
      assert.equal(api.serverDefinition().env.CRAFTOS_ADDONS, undefined);
    },
  );

  await step(
    "diagnostics: goto on 1.18.2, os.shutdown(code), an addon that is off, with quick fixes",
    async () => {
      const file = join(project, "warn.lua");
      writeFileSync(
        file,
        [
          "for i = 1, 3 do",
          "  if i == 2 then goto continue end",
          "  ::continue::",
          "end",
          '-- goto in a comment, "os.shutdown(1)" too',
          'local chat = peripheral.find("chatBox")',
          "os.shutdown(1)",
          "",
        ].join("\n"),
      );
      const uri = vscode.Uri.file(file);
      const ours = () =>
        vscode.languages
          .getDiagnostics(uri)
          .filter((d) => d.source === "craftos-mcp");
      try {
        await vscode.window.showTextDocument(uri);
        await until(
          () => ours().length === 1,
          "only the os.shutdown warning on the default version",
        );
        assert.equal(ours()[0].code, "shutdown-exit-code");
        assert.equal(ours()[0].range.start.line, 6);
        const fixes = await vscode.commands.executeCommand(
          "vscode.executeCodeActionProvider",
          uri,
          ours()[0].range,
        );
        assert.ok(
          fixes.some((f) => /Remove the exit code/.test(f.title)),
          fixes.map((f) => f.title).join("; "),
        );

        await packConfig().update(
          "minecraftVersion",
          "1.18.2",
          vscode.ConfigurationTarget.Workspace,
        );
        await packConfig().update(
          "addons",
          "create",
          vscode.ConfigurationTarget.Workspace,
        );
        await until(
          () => ours().length === 4,
          "goto, the label, the chat box and os.shutdown on 1.18.2 with create only",
        );
        const codes = ours()
          .map((d) => d.code)
          .sort();
        assert.deepEqual(codes, [
          "addon-off",
          "goto-lua51",
          "label-lua51",
          "shutdown-exit-code",
        ]);
        const chat = ours().find((d) => d.code === "addon-off");
        assert.match(chat.message, /Advanced Peripherals/);
        const addonFix = await vscode.commands.executeCommand(
          "vscode.executeCodeActionProvider",
          uri,
          chat.range,
        );
        const on = addonFix.find((f) =>
          /Switch on Advanced Peripherals/.test(f.title),
        );
        assert.ok(on, addonFix.map((f) => f.title).join("; "));
        await vscode.commands.executeCommand(
          on.command.command,
          ...on.command.arguments,
        );
        assert.equal(packConfig().get("addons"), "advanced-peripherals,create");
        await until(() => ours().length === 3, "the chat box warning gone");
        console.log(
          `       ${ours()
            .map((d) => d.code)
            .join(", ")}`,
        );
      } finally {
        await resetPack();
        await vscode.commands.executeCommand(
          "workbench.action.closeAllEditors",
        );
        rmSync(file, { force: true });
      }
    },
  );

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
    "New World writes the world the program asks for and opens it in the World Editor",
    async () => {
      const program = join(project, "screen.lua");
      writeFileSync(
        program,
        'local mon = peripheral.find("monitor")\nmon.setTextScale(0.5)\nmon.write("hi")\n',
      );
      await vscode.window.showTextDocument(vscode.Uri.file(program));
      await vscode.commands.executeCommand("craftos-mcp.newWorld");
      const made = join(project, "screen.world.json");
      const activeInput = () =>
        vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      await until(
        () =>
          activeInput() instanceof vscode.TabInputCustom &&
          activeInput().uri.fsPath.toLowerCase() === made.toLowerCase(),
        "the new world in the World Editor",
      );
      assert.equal(activeInput().viewType, api.worldEditor.viewType);
      assert.deepEqual(JSON.parse(readFileSync(made, "utf8")), {
        monitors: [{ name: "top", blocksWide: 3, blocksHigh: 2 }],
      });
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      rmSync(made);
      rmSync(program);
    },
  );

  await step(
    "the MCP server definition is the supervisor running npx craftos-mcp@0.4.1 serve in the project",
    async () => {
      const def = api.serverDefinition();
      assert.ok(def instanceof vscode.McpStdioServerDefinition);
      assert.equal(def.command, process.execPath);
      assert.match(def.args[0], /dist[\\/]supervisor\.js$/);
      const supervise = JSON.parse(def.env.CRAFTOS_SUPERVISE);
      assert.deepEqual(supervise.base, ["npx", "-y", "craftos-mcp@0.4.1"]);
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
    "craftos-mcp.registerServer: auto registers in a ComputerCraft project, everywhere too",
    async () => {
      // the project has Lua and world files: auto registers it
      assert.equal(api.skipReason(), undefined);
      await config().update(
        "registerServer",
        "everywhere",
        vscode.ConfigurationTarget.Workspace,
      );
      try {
        assert.equal(api.skipReason(), undefined);
        assert.equal(api.providedDefinitions().length, 1);
      } finally {
        await config().update(
          "registerServer",
          undefined,
          vscode.ConfigurationTarget.Workspace,
        );
      }
    },
  );

  await step(
    "the pinned craftos-mcp is downloaded into the extension's storage and starts with node, not npx",
    async () => {
      const store = api.serverDefinition().env.CRAFTOS_VSCODE_STORE;
      assert.ok(store, "no CRAFTOS_VSCODE_STORE for the supervisor");
      assert.ok(store.toLowerCase().includes("globalstorage"), store);
      // the version the extension pins: the base command ends in craftos-mcp@<version>
      const pinnedBase = JSON.parse(
        api.serverDefinition().env.CRAFTOS_SUPERVISE,
      ).base;
      const pinnedVersion = String(pinnedBase.at(-1)).replace(
        /^craftos-mcp@/,
        "",
      );
      const marker = join(store, pinnedVersion, "pinned.json");
      await until(() => existsSync(marker), "the pinned package", 180_000);
      const bin = join(
        store,
        pinnedVersion,
        "node_modules",
        "craftos-mcp",
        JSON.parse(readFileSync(marker, "utf8")).bin,
      );
      assert.ok(existsSync(bin), bin);
      const version = spawnSync("node", [bin, "--version"], {
        encoding: "utf8",
      });
      assert.equal(version.stdout.trim(), pinnedVersion);
      console.log(`       ${bin}`);
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
        // two starts already while craftos-mcp@0.4.1 is not on npm: it, then the 0.4.0 fallback
        const base = started().length;
        const fellBack = mine().some((e) => e.type === "fallback");
        console.log(
          `       ${fellBack ? "fell back to 0.4.0" : "runs the pinned version"}`,
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
    "Watch the Agent's Computers opens the server's own viewer in a panel",
    async () => {
      await until(
        () => api.viewerUrl(),
        "the server to say where its viewer is",
        60_000,
      );
      const url = api.viewerUrl();
      console.log(`       viewer: ${url}`);
      const res = await fetch(new URL("api/sessions", url));
      assert.equal(res.status, 200);
      const panel = await api.watchAgents();
      assert.ok(panel, "no panel");
      assert.equal(panel.title, "Agent's Computers");
      assert.match(
        panel.webview.html,
        /<iframe src="http:\/\/127\.0\.0\.1:\d+\/"/,
      );
      // a second time shows the same panel
      assert.equal(await api.watchAgents(), panel);
      panel.dispose();
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

  await step(
    "craftos.json stands in for the pack settings, under a setting someone set",
    async () => {
      const file = join(project, "craftos.json");
      const config = vscode.workspace.getConfiguration("craftos-mcp");
      assert.equal(api.settings().mc, "");
      writeFileSync(
        file,
        JSON.stringify({ minecraft: "1.20.1", addons: ["create"] }),
      );
      try {
        assert.equal(api.settings().mc, "1.20.1");
        assert.equal(api.settings().addons, "create");
        assert.equal(api.serverDefinition().env.CRAFTOS_VERSION, "1.20.1");
        await config.update(
          "minecraftVersion",
          "1.18.2",
          vscode.ConfigurationTarget.Workspace,
        );
        assert.equal(api.settings().mc, "1.18.2");
        // the schema is packed for jsonValidation
        const pkg = ext.packageJSON.contributes.jsonValidation;
        assert.deepEqual(pkg[1], {
          fileMatch: ["craftos.json"],
          url: "./schemas/craftos.schema.json",
        });
        const schema = require(
          join(ext.extensionPath, "schemas", "craftos.schema.json"),
        );
        assert.ok(
          schema.properties?.minecraft,
          "the stand-in craftos.json schema was packed",
        );
      } finally {
        await config.update(
          "minecraftVersion",
          undefined,
          vscode.ConfigurationTarget.Workspace,
        );
        rmSync(file, { force: true });
      }
      assert.equal(api.settings().mc, "");
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
    "Run test CodeLens above each test runs it in the Testing view and marks the failing line",
    async () => {
      const uri = vscode.Uri.file(join(project, "math.test.lua"));
      await vscode.window.showTextDocument(uri);
      let lenses = [];
      await untilAsync(async () => {
        lenses =
          (await vscode.commands.executeCommand(
            "vscode.executeCodeLensProvider",
            uri,
          )) ?? [];
        return (
          lenses.filter((l) => l.command?.command === "craftos-mcp.runTest")
            .length === 2
        );
      }, "two Run test lenses");
      const run = lenses.filter(
        (l) => l.command?.command === "craftos-mcp.runTest",
      );
      assert.deepEqual(
        run.map((l) => [l.range.start.line, l.command.arguments[1]]),
        [
          [0, "adds"],
          [1, "breaks"],
        ],
      );
      assert.ok(run.every((l) => /Run test/.test(l.command.title)));
      // and Debug test next to each, which debugs the test's file
      const debug = lenses.filter(
        (l) => l.command?.command === "craftos-mcp.debugTest",
      );
      assert.deepEqual(
        debug.map((l) => [l.range.start.line, l.command.arguments[1]]),
        [
          [0, "adds"],
          [1, "breaks"],
        ],
      );
      assert.ok(
        debug.every(
          (l) => /Debug test/.test(l.command.title) && l.command.tooltip,
        ),
      );

      const log = recordRuns(controller);
      await vscode.commands.executeCommand(
        run[1].command.command,
        ...run[1].command.arguments,
      );
      const broke = log.find((e) => e.label === "breaks");
      assert.equal(broke?.method, "failed", JSON.stringify(log));
      const marks = api.testLens.failureMarks();
      assert.equal(marks.length, 1, JSON.stringify(marks));
      assert.equal(marks[0].line, 2);
      assert.match(marks[0].text, /breaks: .*expected 3 but got 2/);
      // an edit takes the mark away
      const editor = vscode.window.activeTextEditor;
      await editor.edit((e) => e.insert(new vscode.Position(4, 0), "\n"));
      assert.equal(api.testLens.failureMarks().length, 0);
      await vscode.commands.executeCommand("workbench.action.files.revert");
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
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
      // the editor's shortcuts get out of the emulator's frame, and a dead emulator can be started again
      assert.match(html, /craftos-key/);
      assert.match(html, /new KeyboardEvent\("keydown"/);
      assert.match(html, /<button id="restart"[^>]*>Start Again<\/button>/);
      assert.match(html, />Run Again<\/button>/);

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

      const sessionsOf = async (url) =>
        (await (await fetch(`${url}/api/sessions`)).json()).sessions;
      const screenOf = async (url, id) =>
        JSON.stringify(
          await (await fetch(`${url}/api/sessions/${id}/screens`)).json(),
        );

      // saving the program runs it over in the panel, with the saved file
      const clockUri = vscode.Uri.file(join(project, "clock.lua"));
      const doc = await vscode.workspace.openTextDocument(clockUri);
      const editor = await vscode.window.showTextDocument(
        doc,
        vscode.ViewColumn.One,
      );
      const at = doc.getText().indexOf("clock started");
      await editor.edit((e) =>
        e.replace(
          new vscode.Range(doc.positionAt(at), doc.positionAt(at + 13)),
          "clock rerun",
        ),
      );
      await doc.save();
      let rerun;
      await untilAsync(
        async () => {
          const now = await sessionsOf(running.url);
          rerun = now.find((s) => s.id !== sessions[0].id);
          return (
            now.length === 1 &&
            rerun &&
            /clock rerun/.test(await screenOf(running.url, rerun.id))
          );
        },
        "the program run over after the save",
        60_000,
      );
      console.log(`       saved: session ${sessions[0].id} -> ${rerun.id}`);

      // a new Minecraft version restarts the panel's app in it
      const oldUrl = running.url;
      try {
        await vscode.commands.executeCommand(
          "craftos-mcp.pickMinecraftVersion",
          "1.20.1",
        );
        await until(
          () => running.url !== oldUrl,
          "a new app behind the panel",
          240_000,
        );
        let fresh = [];
        await untilAsync(
          async () => {
            fresh = await sessionsOf(running.url);
            return (
              fresh.length === 1 &&
              /clock rerun/.test(await screenOf(running.url, fresh[0].id))
            );
          },
          "the program running in the new app",
          120_000,
        );
        assert.equal(fresh[0].program, "clock.lua");
        assert.match(
          running.panel.webview.html,
          new RegExp(`src="${running.url}/"`),
        );
        console.log(`       1.20.1: ${oldUrl} -> ${running.url}`);
      } finally {
        await resetPack();
        await vscode.workspace.fs.writeFile(
          clockUri,
          Buffer.from(doc.getText().replace("clock rerun", "clock started")),
        );
      }

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

  await debuggerSteps(api);
};

/**
 * The debugger, through VS Code's own debug API: a breakpoint set in the editor stops the program in the Run in
 * CraftOS panel, the stack and variables come back, a step and an uncaught error stop it again, and Stop closes
 * the panel. Then a test file under ccunit.
 */
async function debuggerSteps(api) {
  const command = process.env.CRAFTOS_IT_DEBUG_COMMAND;
  if (!command) {
    console.log(
      "  skip the debugger: no craftos-mcp with the debugger (build the clone, or set CRAFTOS_IT_DEBUG_COMMAND)",
    );
    return;
  }
  const config = vscode.workspace.getConfiguration("craftos-mcp");
  await config.update(
    "command",
    JSON.parse(command),
    vscode.ConfigurationTarget.Global,
  );

  // every message the adapter sends VS Code, to wait for stops on
  const messages = [];
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory("craftos", {
    createDebugAdapterTracker: () => ({
      onDidSendMessage: (m) => messages.push(m),
    }),
  });
  let taken = 0;
  const nextEvent = async (name, ms = 60_000) => {
    let found;
    await until(
      () => {
        for (let i = taken; i < messages.length; i++)
          if (messages[i].type === "event" && messages[i].event === name) {
            taken = i + 1;
            found = messages[i].body ?? {};
            return true;
          }
        return false;
      },
      `a ${name} event from the debugger`,
      ms,
    );
    return found;
  };
  const session = () => {
    assert.ok(vscode.debug.activeDebugSession, "no debug session");
    return vscode.debug.activeDebugSession;
  };
  const topFrame = async () => {
    const { stackFrames } = await session().customRequest("stackTrace", {
      threadId: 1,
    });
    return stackFrames[0];
  };
  const localsOf = async (frameId) => {
    const { scopes } = await session().customRequest("scopes", { frameId });
    const { variables } = await session().customRequest("variables", {
      variablesReference: scopes[0].variablesReference,
    });
    return Object.fromEntries(variables.map((v) => [v.name, v.value]));
  };
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();

  try {
    const program = vscode.Uri.file(join(project, "debugme.lua"));
    let pid;
    await step(
      "Debug in CraftOS stops at a breakpoint, with the panel showing the computer",
      async () => {
        const contributes = vscode.extensions.getExtension(
          "Rogiedoji.craftos-mcp",
        ).packageJSON.contributes;
        assert.equal(contributes.debuggers[0].type, "craftos");
        assert.deepEqual(contributes.breakpoints, [{ language: "lua" }]);
        vscode.debug.addBreakpoints([
          new vscode.SourceBreakpoint(
            new vscode.Location(program, new vscode.Position(4, 0)),
          ),
        ]);
        const started = await vscode.commands.executeCommand(
          "craftos-mcp.debugInCraftOS",
          program,
        );
        assert.equal(started, true, "the debug session did not start");
        const stopped = await nextEvent("stopped", 300_000); // a first run sets the emulator up
        assert.equal(stopped.reason, "breakpoint");
        assert.equal(session().type, "craftos");

        const top = await topFrame();
        assert.ok(same(top.source.path, program.fsPath), top.source.path);
        assert.equal(top.line, 5);
        assert.deepEqual(await localsOf(top.id), { count: "6" });
        const doubled = await session().customRequest("evaluate", {
          expression: "count * 2",
          frameId: top.id,
          context: "watch",
        });
        assert.equal(doubled.result, "12");

        // the same panel Run in CraftOS opens, with the computer in it
        const panels = api.runningPanels();
        assert.equal(panels.length, 1);
        assert.equal(panels[0].program, "debugme.lua");
        pid = panels[0].child.pid;
        const { sessions } = await (
          await fetch(`${panels[0].url}/api/sessions`)
        ).json();
        assert.equal(sessions.length, 1);
        // VS Code itself shows the stop: the editor is on the line
        await until(
          () => vscode.debug.activeStackItem !== undefined,
          "VS Code to focus the stopped frame",
        );
      },
    );

    await step(
      "a step moves one line, and the uncaught error stops where it is raised",
      async () => {
        await session().customRequest("next", { threadId: 1 });
        assert.equal((await nextEvent("stopped")).reason, "step");
        assert.equal((await topFrame()).line, 6);
        await session().customRequest("continue", { threadId: 1 });
        const stopped = await nextEvent("stopped");
        assert.equal(stopped.reason, "exception");
        assert.match(stopped.text, /debugme\.lua:6: debug boom/);
        const top = await topFrame();
        assert.ok(same(top.source.path, program.fsPath));
        assert.equal(top.line, 6);
      },
    );

    await step(
      "Stop ends the session, closes the panel and stops the emulator",
      async () => {
        await vscode.debug.stopDebugging();
        await until(
          () => vscode.debug.activeDebugSession === undefined,
          "the session to end",
        );
        await until(
          () => api.runningPanels().length === 0,
          "the panel to close",
        );
        for (let i = 0; i < 40 && alive(pid); i++) await sleep(250);
        assert.equal(alive(pid), false, "the app is still running after Stop");
        vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
      },
    );

    await step(
      "a test file debugs under ccunit: a breakpoint in a test, then its failing assertion",
      async () => {
        const test = vscode.Uri.file(join(project, "math.test.lua"));
        taken = messages.length;
        vscode.debug.addBreakpoints([
          new vscode.SourceBreakpoint(
            new vscode.Location(test, new vscode.Position(2, 0)),
          ),
        ]);
        const started = await vscode.debug.startDebugging(
          vscode.workspace.workspaceFolders[0],
          {
            type: "craftos",
            request: "launch",
            name: "math.test.lua",
            program: "math.test.lua",
          },
        );
        assert.equal(started, true);
        // line 3 is the failing assertion inside the "breaks" test: first the breakpoint on it, then the error it raises
        assert.equal(
          (await nextEvent("stopped", 120_000)).reason,
          "breakpoint",
        );
        assert.equal((await topFrame()).line, 3);
        await session().customRequest("continue", { threadId: 1 });
        const stopped = await nextEvent("stopped");
        assert.equal(stopped.reason, "exception");
        assert.match(stopped.text, /expected 3 but got 2/);
        const { stackFrames } = await session().customRequest("stackTrace", {
          threadId: 1,
        });
        const mine = stackFrames.find((f) => f.presentationHint !== "subtle");
        assert.ok(same(mine.source.path, test.fsPath), mine.source.path);
        assert.equal(mine.line, 3);

        // the file runs out and the session ends; the panel stays, with the results the computer printed on it
        await session().customRequest("continue", { threadId: 1 });
        await nextEvent("terminated");
        await until(
          () => vscode.debug.activeDebugSession === undefined,
          "the session to end",
        );
        const panels = api.runningPanels();
        assert.equal(panels.length, 1);
        let screens = "";
        await untilAsync(
          async () => {
            const { sessions } = await (
              await fetch(`${panels[0].url}/api/sessions`)
            ).json();
            screens = JSON.stringify(
              await (
                await fetch(
                  `${panels[0].url}/api/sessions/${sessions[0].id}/screens`,
                )
              ).json(),
            );
            return /1 passed, 1 failed/.test(screens);
          },
          "the test results on the panel's terminal",
          20_000,
        );
        assert.match(screens, /pass  adds/);
        assert.match(screens, /FAIL  breaks/);
        panels[0].panel.dispose();
        await until(
          () => api.runningPanels().length === 0,
          "the panel to close",
        );
      },
    );

    await step(
      "Debug in the Testing view runs the test file under the debugger",
      async () => {
        taken = messages.length;
        vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
        await api.tests.discover();
        // the view's own Debug All: it uses the controller's Debug profile
        const debugging = vscode.commands.executeCommand("testing.debugAll");
        const stopped = await nextEvent("stopped", 120_000);
        assert.equal(stopped.reason, "exception");
        assert.match(stopped.text, /expected 3 but got 2/);
        assert.equal(session().configuration.test, true);
        await session().customRequest("continue", { threadId: 1 });
        await nextEvent("terminated");
        // the test run ends with the session
        await Promise.race([
          debugging,
          sleep(30_000).then(() => {
            throw new Error("the test run did not end with the debug session");
          }),
        ]);
        const panels = api.runningPanels();
        assert.equal(panels.length, 1);
        assert.equal(panels[0].program, "math.test.lua");
        panels[0].panel.dispose();
        await until(
          () => api.runningPanels().length === 0,
          "the panel to close",
        );
      },
    );

    await step(
      "the Debug test lens debugs the test's file under ccunit",
      async () => {
        taken = messages.length;
        const uri = vscode.Uri.file(join(project, "math.test.lua"));
        // as the lens calls it: the file, the test's name and line
        const started = vscode.commands.executeCommand(
          "craftos-mcp.debugTest",
          uri,
          "breaks",
          1,
        );
        const stopped = await nextEvent("stopped", 120_000);
        assert.equal(await started, true);
        assert.equal(stopped.reason, "exception");
        assert.match(stopped.text, /expected 3 but got 2/);
        assert.equal(session().configuration.test, true);
        await session().customRequest("continue", { threadId: 1 });
        await nextEvent("terminated");
        const panels = api.runningPanels();
        assert.equal(panels.length, 1);
        assert.equal(panels[0].program, "math.test.lua");
        panels[0].panel.dispose();
        await until(
          () => api.runningPanels().length === 0,
          "the panel to close",
        );
      },
    );
  } finally {
    tracker.dispose();
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await config.update(
      "command",
      undefined,
      vscode.ConfigurationTarget.Global,
    );
  }
}
