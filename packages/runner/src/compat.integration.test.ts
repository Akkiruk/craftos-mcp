// What running the community's programs turned up (docs/compatibility.md, scripts/compat): each case here is a
// difference from a real CC:Tweaked computer that broke one of them, pinned to what CC:Tweaked does.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type WorldConfig,
  checkConfig,
  loadConfig,
  readResultFile,
  resolveVersion,
  romDirFor,
  startEngine,
  testBoot,
} from "./index.js";

const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "compat-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(config).length === 0;
const newer = existsSync(
  join(romDirFor(config, resolveVersion("1.21.1", {})), "bios.lua"),
);

/** Both CC:Tweaked versions: Minecraft 1.18.2 has 1.101.3, Minecraft 1.21.1 has 1.121.0. */
const VERSIONS = [
  { mc: "1.18.2", cc: "1.101.3", there: true },
  { mc: "1.21.1", cc: "1.121.0", there: newer },
] as const;

// A body that is not text, sent in two parts with a pause between: a handle that read from the socket gave back
// only what had arrived.
const BINARY = Buffer.from(Array.from({ length: 20000 }, (_, i) => i % 256));
// "é€x" in UTF-8: one character CC's charset has, one it has not, one plain
const UTF8 = Buffer.from([0xc3, 0xa9, 0xe2, 0x82, 0xac, 0x78]);

let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/slow") {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.write(BINARY.subarray(0, 3000));
      setTimeout(() => res.end(BINARY.subarray(3000)), 400);
    } else if (req.url === "/stall") {
      // the headers and a part of the body, then nothing: closed by afterAll
      res.writeHead(200, {
        "Content-Type": "text/plain",
        "Content-Length": "100",
      });
      res.write("abc");
    } else if (req.url === "/utf8") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(UTF8);
    } else {
      res.writeHead(404);
      res.end("no");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(scratch, { recursive: true, force: true });
});

interface Case {
  name: string;
  passed: boolean;
  error?: string;
}

/** Run a ccunit file on a fresh computer and return the failed cases as text (none: an empty list). */
async function failures(
  name: string,
  lua: string,
  world: WorldConfig,
): Promise<string[]> {
  writeFileSync(join(scratch, name), lua.replaceAll("PORT", String(port)));
  const handle = startEngine(config, testBoot(name, []), {
    label: "test",
    world: { addons: "none", ...world },
    httpRules: { deny: [] },
  });
  try {
    await handle.session.waitForExit(60000);
    const parsed = readResultFile<{ tests: Case[] }>(
      handle.resultsDir,
      "results.json",
    );
    expect(parsed?.tests.length ?? 0).toBeGreaterThan(0);
    return (parsed?.tests ?? [])
      .filter((t) => !t.passed)
      .map((t) => `${t.name}: ${t.error}`);
  } finally {
    handle.dispose();
  }
}

describe.skipIf(!ready)("what a program can tell the emulator by", () => {
  for (const v of VERSIONS) {
    it.skipIf(!v.there)(
      `${v.mc}: _HOST, globals, terminal methods and the root folder are a real computer's`,
      async () => {
        const failed = await failures(
          `surface-${v.mc}.lua`,
          `
-- C3D reads _HOST for "CraftOS-PC" and then calls config.set, which only CraftOS-PC has
ccunit.test("_HOST is ServerContext.getHostString's", function()
  ccunit.eq(_HOST, "ComputerCraft ${v.cc} (Minecraft ${v.mc})")
end)
ccunit.test("no global of the engine's is left", function()
  for _, name in ipairs({ "_CCPC_UPDATED_VERSION", "_CCPC_FIRST_RUN", "_CCPC_STARTUP_SCRIPT", "_HEADLESS",
    "periphemu", "config", "mounter" }) do
    ccunit.eq(_G[name], nil, name)
  end
end)
-- term.redirect gives its target a stand-in for every native function the target lacks. With CraftOS-PC's graphics
-- functions still on the native terminal while the shell's window was made, that window had a getGraphicsMode which
-- raised "Redirect object is missing method getGraphicsMode": C3D asks \`if win.getGraphicsMode then\`
ccunit.test("windows have CC's terminal methods and no others", function()
  local win = window.create(term.current(), 1, 1, 5, 5, false)
  local before = 0 for _ in pairs(win) do before = before + 1 end
  local old = term.redirect(win)
  term.redirect(old)
  local after = 0 for _ in pairs(win) do after = after + 1 end
  ccunit.eq(after, before, "a redirect added methods to the window")
  for _, name in ipairs({ "drawPixels", "getFrozen", "getGraphicsMode", "getPixel", "getPixels", "relativeMouse",
    "screenshot", "setFrozen", "setGraphicsMode", "setPixel", "showMouse" }) do
    for label, t in pairs({ term = term, current = term.current(), native = term.native(), window = win }) do
      ccunit.eq(t[name], nil, label .. "." .. name)
    end
  end
end)
-- /ccunit and /results are the harness's own: a file manager listed them and an installer that wipes the disk
-- would have deleted them
ccunit.test("the root folder lists no harness mount", function()
  for _, pattern in ipairs({ "*", "/*", "r*", "*s" }) do
    for _, name in ipairs(fs.find(pattern)) do
      ccunit.truthy(name ~= "results" and name ~= "ccunit", pattern .. " found " .. name)
    end
  end
  for _, name in ipairs(fs.list("/")) do ccunit.truthy(name ~= "results" and name ~= "ccunit", "listed " .. name) end
  for _, name in ipairs(fs.find("*/*")) do
    ccunit.truthy(not name:find("^results/") and not name:find("^ccunit/"), "*/* found " .. name)
  end
  -- a path that names one still reaches it: tests and the simulation do
  ccunit.truthy(fs.exists("/results/world.json"))
  ccunit.truthy(#fs.find("results/*.json") >= 1)
  ccunit.truthy(fs.isDir("ccunit"))
end)
ccunit.test("an ordinary computer has no pocket API", function() ccunit.eq(pocket, nil) end)
-- the simulation wraps redstone to save changed outputs: its errors named the wrapper's own file and line
ccunit.test("a redstone error names no file of the emulator's", function()
  -- a Java function's error is placed at its caller: "pcall: " under a bare pcall on 1.101.3, the nearest Lua
  -- line from 1.109 on (this file's, here)
  local here = ${v.cc === "1.101.3" ? `"pcall: "` : `"/surface%-[%d%.]+%.lua:%d+: "`}
  local _, err = pcall(redstone.setOutput, 0)
  ccunit.truthy(err:find("^" .. here .. "bad argument #1 %(string expected, got number%)$"), err)
  _, err = pcall(rs.setAnalogOutput, "blah", 1)
  ccunit.truthy(err:find("^" .. here .. "bad argument #1 %(unknown option blah%)$"), err)
  _, err = pcall(function() redstone.setBundledOutput("top", "x") end)
  ccunit.truthy(err:find("^/surface%-[%d%.]+%.lua:%d+: bad argument #2 %(number expected, got string%)$"), err)
  redstone.setOutput("top", true)
  ccunit.eq(redstone.getOutput("top"), true)
end)
-- Herobrine's release is one file with its data as raw bytes in a string, a backslash before the ones that need
-- it. Cobalt 0.6.0 and 0.9.9 (asked directly, tools/conformance/cobalt-oracle) take an unknown escape as the
-- character itself, as Lua 5.1 does; native Lua 5.2 raised "invalid escape sequence"
ccunit.test("an escape the lexer does not know is the character itself", function()
  local bs = string.char(92)
  ccunit.eq(load('return "' .. bs .. 'q' .. bs .. '."')(), "q.")
  ccunit.eq(load('return "a' .. bs .. string.char(200) .. bs .. string.char(1) .. 'b"')(), "a\\200\\1b")
  ccunit.eq(load('return "' .. bs .. 'x41' .. bs .. 'z   B' .. bs .. 'u{43}' .. bs .. '68"')(), "ABCD")
  local fn, err = load('return "' .. bs .. '256"')
  ccunit.eq(fn, nil)
  ccunit.truthy(tostring(err):find("escape sequence too large", 1, true), err)
end)
-- cc.require copies the registry's _LOADED into package.loaded from CC:Tweaked 1.109 on: native Lua's own entries
-- ("os", "package", "_G", "") made \`require "os"\` work here and fail on a server
ccunit.test("only Cobalt's libraries can be required by name", function()
  ccunit.eq((pcall(require, "os")), false)
  ccunit.eq((pcall(require, "io")), false)
  ccunit.eq(require("string"), string)
  ccunit.eq(require("bit32"), bit32)
  ${
    v.cc === "1.101.3"
      ? ""
      : `local names = {}
  for name in pairs(debug.getregistry()._LOADED) do names[#names + 1] = name end
  table.sort(names)
  ccunit.eq(names, { "bit32", "cc.internal.error_info", "coroutine", "debug", "math", "string", "table", "utf8" })
  ccunit.eq(require("utf8"), utf8)`
  }
end)
`,
          { version: v.mc },
        );
        expect(failed).toEqual([]);
      },
      90000,
    );

    it.skipIf(!v.there)(
      `${v.mc}: a pocket computer has the pocket API`,
      async () => {
        // iPod OS's installer starts with \`if not pocket then print("Please use a pocket computer.")\`
        const failed = await failures(
          `pocket-${v.mc}.lua`,
          `
ccunit.test("pocket is PocketAPI's two methods", function()
  ccunit.eq(type(pocket), "table")
  local names = {}
  for name, fn in pairs(pocket) do ccunit.eq(type(fn), "function") names[#names + 1] = name end
  table.sort(names)
  ccunit.eq(names, { "equipBack", "unequipBack" })
end)
ccunit.test("the shell and the settings know it is a pocket computer", function()
  ccunit.truthy(shell.path():find("/rom/programs/pocket", 1, true), shell.path())
  ccunit.eq(settings.get("motd.enable"), false) -- bios.lua: default = pocket == nil
  local w, h = term.getSize()
  ccunit.eq({ w, h }, { 26, 20 })
end)
ccunit.test("the upgrade on its back comes off once", function()
  ccunit.eq(peripheral.getType("back"), "modem")
  ccunit.eq({ pocket.unequipBack() }, { true })
  ccunit.eq(peripheral.isPresent("back"), false)
  ccunit.eq({ pocket.unequipBack() }, { false, "Nothing to unequip" })
  ccunit.eq({ pocket.equipBack() }, { false, "Cannot find a valid upgrade" })
end)
`,
          {
            version: v.mc,
            kind: "pocket",
            peripherals: [{ name: "back", type: "modem" }],
          },
        );
        expect(failed).toEqual([]);
      },
      90000,
    );

    it.skipIf(!v.there)(
      `${v.mc}: a drive can start with a floppy disk in it, 125000 bytes big`,
      async () => {
        // RedOS installs from a floppy; Quartz plays the songs on one
        const failed = await failures(
          `disk-${v.mc}.lua`,
          `
ccunit.test("the disk is mounted at /disk with its files", function()
  ccunit.eq(disk.isPresent("left"), true)
  ccunit.eq(disk.hasData("left"), true)
  ccunit.eq(disk.getMountPath("left"), "disk")
  ccunit.eq(disk.getID("left"), 7)
  local h = fs.open("disk/notes/hello.txt", "r")
  ccunit.eq(h.readAll(), "on the disk")
  h.close()
  ccunit.eq(fs.getDrive("disk/notes"), "left")
end)
ccunit.test("it holds 125000 bytes, not what the host's disk does", function()
  ccunit.eq(fs.getCapacity("disk"), 125000)
  -- FileMount counts a folder as 500 bytes and a file as max(size, 500): notes/ and hello.txt
  ccunit.eq(fs.getFreeSpace("disk"), 124000)
  local h = fs.open("disk/big.txt", "w")
  h.write(("x"):rep(20000))
  h.close()
  ccunit.eq(fs.getFreeSpace("disk"), 104000)
  ccunit.eq(fs.getCapacity("/"), fs.getCapacity("startup.lua")) -- the computer's own drive is not a floppy
end)
ccunit.test("a full disk refuses what does not fit (row 139)", function()
  -- the counting channel refuses a write whole, before any of it is written
  local h = fs.open("disk/fill.bin", "wb")
  h.write(("y"):rep(100000))
  ccunit.eq(fs.getFreeSpace("disk"), 4000)
  -- the handle's own error, placed like every error a handle raises
  local ok, err = pcall(h.write, ("y"):rep(4001))
  ccunit.truthy(not ok and tostring(err):find("Out of space$"), err)
  h.write(("y"):rep(4000))
  ok, err = pcall(h.write, 65)
  ccunit.truthy(not ok and tostring(err):find("Out of space$"), err)
  h.close()
  ccunit.eq(fs.getSize("disk/fill.bin"), 104000)
  ccunit.eq(fs.getFreeSpace("disk"), 0)
  -- a new file needs 500 bytes, a folder 500 each; a file that is there already can be opened again
  ccunit.eq({ fs.open("disk/new.txt", "w") }, { nil, "/disk/new.txt: Out of space" })
  ok, err = pcall(fs.makeDir, "disk/more")
  ccunit.truthy(not ok and tostring(err):find("/disk/more: Out of space$"), err)
  h = fs.open("disk/big.txt", "w") -- truncated: its 20000 bytes are free again
  ccunit.eq(fs.getFreeSpace("disk"), 19500)
  h.write("text, the old way")
  h.close()
  ccunit.eq(fs.getFreeSpace("disk"), 19500)
  fs.delete("disk/fill.bin")
  ccunit.eq(fs.getFreeSpace("disk"), 123500)
  -- the computer's own drive is not counted this way
  h = fs.open("big-on-the-computer.txt", "w")
  h.write(("z"):rep(130000))
  h.close()
  ccunit.eq(fs.getSize("big-on-the-computer.txt"), 130000)
end)
`,
          {
            version: v.mc,
            peripherals: [{ name: "left", type: "drive", disk: 7 }],
            disks: { "7": { "notes/hello.txt": "on the disk" } },
          },
        );
        expect(failed).toEqual([]);
      },
      90000,
    );

    it.skipIf(!v.there)(
      `${v.mc}: read(n) on a response gives n bytes, however slowly they arrived`,
      async () => {
        // Musicify and Pocketbox read a song 16384 and 6000 bytes at a time: read(n) gave "" (what the socket had
        // ready), and both stopped at "Cannot play empty audio"
        const text =
          v.cc === "1.101.3"
            ? // EncodedReadableHandle: the body decoded as UTF-8, a character CC's charset lacks is "?"
              `ccunit.eq(h.readAll(), "\\233?x")`
            : // AbstractHandle from 1.109: a text handle holds the bytes as they are
              `ccunit.eq(h.readAll(), "\\195\\169\\226\\130\\172x")`;
        const failed = await failures(
          `http-${v.mc}.lua`,
          `
local function byte(i) return i % 256 end
ccunit.test("a binary handle: read() is a number, read(n) is n bytes", function()
  local h = assert(http.get("http://127.0.0.1:PORT/slow", nil, true))
  ccunit.eq(h.read(), byte(0))
  ccunit.eq(h.read(), byte(1))
  local part = h.read(6000)
  ccunit.eq(#part, 6000)
  ccunit.eq(part:byte(1), byte(2))
  ccunit.eq(part:byte(6000), byte(6001))
  ccunit.eq(h.read(0), "")
  ccunit.raises(function() h.read(-1) end, "Cannot read a negative number of bytes")
  ccunit.eq(#h.read(100000), 20000 - 6002)
  ccunit.eq(h.read(1), nil)
  ccunit.eq(h.read(), nil)
  h.close()
end)
ccunit.test("a text handle: read() is one character, read(n) is n of them", function()
  local h = assert(http.get("http://127.0.0.1:PORT/slow"))
  ccunit.eq(h.read(), "\\0")
  ccunit.eq(#h.read(16), 16)
  local rest = h.read(100000)
  ccunit.truthy(#rest > 6000, "read(100000) gave " .. #rest) -- past the 3000 bytes that came first
  ccunit.eq(h.read(1), nil)
  h.close()
end)
ccunit.test("the table form's binary field is read too", function()
  http.request({ url = "http://127.0.0.1:PORT/slow", binary = true })
  local timer = os.startTimer(15)
  while true do
    local ev, a, h = os.pullEvent()
    if ev == "http_success" then
      ccunit.eq(h.read(), byte(0))
      ccunit.eq(#h.readAll(), 19999)
      h.close()
      break
    elseif ev == "http_failure" or (ev == "timer" and a == timer) then
      error("no http_success: " .. ev)
    end
  end
end)
ccunit.test("text is ${v.cc === "1.101.3" ? "decoded" : "bytes"} on ${v.cc}", function()
  local h = assert(http.get("http://127.0.0.1:PORT/utf8"))
  ${text}
  h.close()
  h = assert(http.get("http://127.0.0.1:PORT/utf8", nil, true))
  ccunit.eq(h.readAll(), "\\195\\169\\226\\130\\172x")
  h.close()
end)
`,
          { version: v.mc },
        );
        expect(failed).toEqual([]);
      },
      90000,
    );

    it.skipIf(!v.there)(
      `${v.mc}: a body that stops coming times out, and the timeout field is the version's`,
      async () => {
        // CC's ReadTimeoutHandler fails a request that hears nothing for its timeout, in the body too; the engine
        // answered http_success with the 3 bytes that had come. 1.101.3 reads no timeout field (always 30 s), so
        // only the newer version waits out a short one here.
        const lua =
          v.cc === "1.101.3"
            ? `
ccunit.test("the timeout field is not read", function()
  ccunit.eq(http.request({ url = "http://127.0.0.1:PORT/utf8", timeout = "soon" }), true)
  local ev
  repeat ev = os.pullEvent() until ev == "http_success" or ev == "http_failure"
  ccunit.eq(ev, "http_success")
end)
`
            : `
ccunit.test("a stalled body is Timed out", function()
  ccunit.eq(http.request({ url = "http://127.0.0.1:PORT/stall", timeout = 1 }), true)
  local t0 = os.epoch("utc")
  local ev, url, why
  repeat ev, url, why = os.pullEvent() until ev == "http_success" or ev == "http_failure"
  ccunit.eq({ ev, why }, { "http_failure", "Timed out" })
  ccunit.truthy(os.epoch("utc") - t0 >= 900, "failed after " .. (os.epoch("utc") - t0) .. " ms")
end)
ccunit.test("the timeout is 0 to 60 seconds", function()
  -- HTTPAPI.getTimeout's message, at the line of rom/apis/http/http.lua that called the native request
  for _, t in ipairs({ 61, -1 }) do
    local ok, err = pcall(http.request, { url = "http://127.0.0.1:PORT/utf8", timeout = t })
    ccunit.eq(ok, false)
    ccunit.truthy(tostring(err):find("timeout out of range (between 0.0 and 60.0)", 1, true), tostring(err))
  end
end)
`;
        const failed = await failures(`stall-${v.mc}.lua`, lua, {
          version: v.mc,
        });
        expect(failed).toEqual([]);
      },
      90000,
    );

    it.skipIf(!v.there)(
      `${v.mc}: debug.sethook works on a computer slowed to Cobalt's speed`,
      async () => {
        // LevelOS sets a count hook on every process: with cobaltSpeed on, debug.sethook raised
        // "Cannot set hooks while debugger is attached", because the slowdown is itself a hook
        const failed = await failures(
          `hook-${v.mc}.lua`,
          `
ccunit.test("no hook to begin with", function()
  ccunit.eq({ debug.gethook() }, { nil, "", 0 })
end)
ccunit.test("a count hook is called and reported", function()
  local calls = 0
  local function hook() calls = calls + 1 end
  debug.sethook(hook, "", 1000)
  local x = 0
  for i = 1, 200000 do x = x + i end
  local fn, mask, count = debug.gethook()
  debug.sethook()
  ccunit.truthy(calls > 50, "called " .. calls .. " times")
  ccunit.eq({ fn == hook, mask, count }, { true, "", 1000 })
  ccunit.eq({ debug.gethook() }, { nil, "", 0 })
end)
ccunit.test("a line hook sees lines only, and the slowdown's count stays its own", function()
  local events = {}
  debug.sethook(function(event) events[event] = (events[event] or 0) + 1 end, "l")
  local y = 1
  for i = 1, 5000 do y = y + i end
  local _, mask, count = debug.gethook()
  debug.sethook()
  ccunit.truthy((events.line or 0) > 5000, "lines: " .. tostring(events.line))
  ccunit.eq(events.count, nil)
  ccunit.eq({ mask, count }, { "l", 0 })
end)
ccunit.test("a hook on another coroutine", function()
  local calls = 0
  local co = coroutine.create(function() for i = 1, 100000 do end return "done" end)
  debug.sethook(co, function() calls = calls + 1 end, "", 100)
  ccunit.eq({ coroutine.resume(co) }, { true, "done" })
  ccunit.truthy(calls > 100, "called " .. calls .. " times")
end)
ccunit.test("the computer is still slowed down afterwards", function()
  local started = os.epoch("utc")
  for i = 1, 2000000 do end
  ccunit.truthy(os.epoch("utc") - started >= 20, "2,000,000 steps took " .. (os.epoch("utc") - started) .. " ms")
end)
`,
          { version: v.mc, cobaltSpeed: true },
        );
        expect(failed).toEqual([]);
      },
      90000,
    );
  }
});
