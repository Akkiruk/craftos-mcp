// The Lua settings merge (append, never overrule) and the ComputerCraft project check.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  addonSettings,
  isCcProject,
  isOurLibrary,
  planLuaSettings,
  withoutOurLibrary,
} from "../../src/luaSettings.ts";

const here = dirname(fileURLToPath(import.meta.url));
const OURS =
  "C:\\Users\\x\\globalStorage\\rogiedoji.craftos-mcp\\lua-addons\\cc-tweaked\\library";
const OLD =
  "/home/x/.vscode/extensions/rogiedoji.craftos-mcp-0.2.0/lua-addons/cc-tweaked/library";
const wanted = {
  library: OURS,
  version: "Lua 5.2",
  builtin: { os: "disable", io: "disable" },
};

test("empty settings get everything", () => {
  assert.deepEqual(planLuaSettings({}, wanted), {
    library: [OURS],
    version: "Lua 5.2",
    builtin: { os: "disable", io: "disable" },
  });
});

test("another library stays, ours goes after it", () => {
  const writes = planLuaSettings({ library: ["/their/lib"] }, wanted);
  assert.deepEqual(writes.library, ["/their/lib", OURS]);
});

test("already set up: nothing to write", () => {
  assert.deepEqual(
    planLuaSettings(
      {
        library: ["/their/lib", OURS],
        version: "Lua 5.2",
        builtin: { os: "disable", io: "disable" },
      },
      wanted,
    ),
    {},
  );
});

test("an old copy of ours is swapped for the new path, in place of nothing else", () => {
  const writes = planLuaSettings({ library: [OLD, "/their/lib"] }, wanted);
  assert.deepEqual(writes.library, ["/their/lib", OURS]);
});

test("the user's runtime.version is left alone, whatever it is", () => {
  assert.equal(
    planLuaSettings({ version: "Lua 5.4" }, wanted).version,
    undefined,
  );
  assert.equal(planLuaSettings({ version: "" }, wanted).version, undefined);
});

test("the user's builtin.os = enable is kept, the rest filled in", () => {
  const writes = planLuaSettings(
    { builtin: { os: "enable", utf8: "disable" } },
    wanted,
  );
  assert.deepEqual(writes.builtin, {
    os: "enable",
    io: "disable",
    utf8: "disable",
  });
});

test("remove takes every copy of ours out and nothing else", () => {
  assert.deepEqual(withoutOurLibrary(["/a", OURS, OLD]), ["/a"]);
  assert.equal(withoutOurLibrary(["/a"]), undefined);
  assert.equal(withoutOurLibrary(undefined), undefined);
  assert.ok(isOurLibrary(OURS));
  assert.ok(!isOurLibrary("/x/lua-addons/love/library"));
});

test("the values come from the addon's own config.json", () => {
  const config = readFileSync(
    join(here, "..", "..", "..", "..", "packages", "cc-types", "config.json"),
    "utf8",
  );
  const settings = addonSettings(config);
  assert.equal(settings.version, "Lua 5.2");
  assert.equal(settings.builtin?.os, "disable");
  assert.equal(settings.builtin?.io, "disable");
});

function project(files) {
  const root = mkdtempSync(join(tmpdir(), "craftos-cc-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    if (name.endsWith("/")) mkdirSync(join(root, name), { recursive: true });
    else writeFileSync(join(root, name), text);
  }
  return root;
}

test("CC projects are spotted, others are not", () => {
  assert.ok(isCcProject(project({ "startup.lua": "" })));
  assert.ok(isCcProject(project({ "lib/clock.test.lua": "" })));
  assert.ok(isCcProject(project({ "clock.world.json": "{}" })));
  assert.ok(isCcProject(project({ ".craftos/": "" })));
  assert.ok(
    isCcProject(
      project({ "src/door.lua": 'local m = peripheral.find("monitor")\n' }),
    ),
  );
  assert.ok(
    isCcProject(project({ "a.lua": 'local ui = require("cc.strings")\n' })),
  );
  assert.ok(
    !isCcProject(project({ "main.lua": "function love.draw() end\n" })),
  );
  assert.ok(
    !isCcProject(
      project({ "node_modules/x/startup.lua": "", "README.md": "" }),
    ),
  );
  assert.ok(!isCcProject(project({})));
});
