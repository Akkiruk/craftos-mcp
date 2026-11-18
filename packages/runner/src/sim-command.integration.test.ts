// The emulator's in-computer `sim` program (rom/ccsim/sim.lua): a person changes the simulated world from the shell.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type WorldConfig,
  checkConfig,
  loadConfig,
  runProgram,
} from "./index.js";

const scratch = mkdtempSync(join(tmpdir(), "sim-command-ws-"));
const config = { ...loadConfig(), workspaceDir: scratch };
const ready = checkConfig(config).length === 0;
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const WORLD: WorldConfig = {
  addons: ["advanced-peripherals", "create"],
  simProgram: true,
  players: [{ name: "Alice", online: false }],
  peripherals: [
    { name: "chest_0", type: "minecraft:chest", size: 27 },
    { name: "playerDetector_0", type: "playerDetector" },
    { name: "chatBox_0", type: "chatBox" },
    { name: "Create_Station_0", type: "Create_Station", station: "Central" },
  ],
} as WorldConfig;

/** Run Lua that may call `sim`; it prints `RESULT <text>` lines, returned in order. */
async function run(
  source: string,
  world: WorldConfig = WORLD,
): Promise<{ results: string[]; screen: string }> {
  writeFileSync(join(scratch, "check.lua"), source);
  const result = await runProgram(config, {
    program: "check.lua",
    world,
    timeoutMs: 30000,
  });
  const screen = (result.screens[0]?.lines ?? []).join("\n");
  expect(result.status, `${screen}\n${result.stderr}`).toBe("completed");
  const results = screen
    .split("\n")
    .filter((l) => l.startsWith("RESULT "))
    .map((l) => l.slice(7).trimEnd());
  return { results, screen };
}

describe.skipIf(!ready)("sim program", () => {
  it("joins, leaves and adds players", async () => {
    const { results } = await run(`
      local det = peripheral.wrap("playerDetector_0")
      shell.run("sim join Alice")
      print("RESULT " .. table.concat(det.getOnlinePlayers(), ","))
      shell.run("sim join Bob")
      print("RESULT " .. table.concat(det.getOnlinePlayers(), ","))
      shell.run("sim leave Alice")
      print("RESULT " .. table.concat(det.getOnlinePlayers(), ","))
    `);
    expect(results).toEqual(["Alice", "Alice,Bob", "Bob"]);
  });

  it("chats as a player, reaching chat boxes", async () => {
    const { results } = await run(`
      local got
      parallel.waitForAll(
        function() shell.run("sim chat Alice hello there") end,
        function() local _, who, msg = os.pullEvent("chat") got = who .. ":" .. msg end)
      print("RESULT " .. got)
    `);
    expect(results).toEqual(["Alice:hello there"]);
  });

  it("advances the clock and fires timers", async () => {
    const { results } = await run(`
      local t0 = os.clock()
      local fired = false
      local id = os.startTimer(30)
      parallel.waitForAll(
        function() shell.run("sim advance 60") end,
        function() repeat local _, t = os.pullEvent("timer") until t == id fired = true end)
      print("RESULT " .. tostring(os.clock() - t0 >= 30) .. " " .. tostring(fired))
    `);
    expect(results).toEqual(["true true"]);
  });

  it("runs a sleep loop through the jump as often as the time it skips, as the time bar's jump", async () => {
    const { results } = await run(`
      local t0 = os.clock()
      local n = 0
      parallel.waitForAll(
        function() shell.run("sim advance 10") end,
        function() repeat sleep(1) n = n + 1 until os.clock() - t0 >= 9.99 end)
      print("RESULT " .. n)
    `);
    expect(results).toEqual(["10"]);
  });

  it("does not page help when a program runs it: nobody is there to press a key", async () => {
    const { results, screen } = await run(`
      shell.run("sim help")
      print("RESULT done")
    `);
    expect(screen).not.toContain("Press any key");
    expect(results).toEqual(["done"]);
  });

  it("puts items in an inventory, by the shortcut and the generic form", async () => {
    const { results } = await run(`
      local chest = peripheral.wrap("chest_0")
      shell.run("sim item chest_0 1 minecraft:diamond 5")
      local d = chest.getItemDetail(1)
      print("RESULT " .. d.name .. " " .. d.count)
      shell.run("sim setItem peripheral=chest_0 slot=2 item.name=minecraft:stone item.count=3")
      d = chest.getItemDetail(2)
      print("RESULT " .. d.name .. " " .. d.count)
      shell.run("sim setItem peripheral=chest_0 slot=3 item={name='minecraft:dirt',count=7}")
      d = chest.getItemDetail(3)
      print("RESULT " .. d.name .. " " .. d.count)
      shell.run("sim item chest_0 1")
      print("RESULT " .. tostring((chest.getItemDetail(1))))
    `);
    expect(results).toEqual([
      "minecraft:diamond 5",
      "minecraft:stone 3",
      "minecraft:dirt 7",
      "nil",
    ]);
  });

  it("sends an addon's command (a Create train arrives)", async () => {
    const { results } = await run(`
      local st = peripheral.wrap("Create_Station_0")
      print("RESULT " .. tostring(st.isTrainPresent()))
      shell.run("sim createTrainArrive station=Create_Station_0 train=Express")
      print("RESULT " .. tostring(st.isTrainPresent()) .. " " .. tostring(st.getTrainName()))
    `);
    expect(results).toEqual(["false", "true Express"]);
  });

  it("reports errors, lists commands and prints the state", async () => {
    const { screen } = await run(`
      shell.run("sim leave Nobody")
      shell.run("sim noSuchThing a=1")
      shell.run("sim setItem peripheral=chest_0 slot")
      shell.run("sim join Alice")
      shell.run("sim state")
    `);
    expect(screen).toContain("sim: unknown player");
    expect(screen).toContain("sim: unknown command");
    expect(screen).toContain("sim: expected key=value, got slot");
    expect(screen).toMatch(/Alice online/);
    expect(screen).toMatch(/chest_0 \(minecraft:chest, inventory\)/);
  });

  it("names every command in help, addons' included", async () => {
    const { results } = await run(`
      local lines = {}
      local w = window.create(term.current(), 1, 1, 400, 40, false)
      local old = term.redirect(w)
      shell.run("sim help")
      term.redirect(old)
      for y = 1, 40 do lines[#lines + 1] = (w.getLine(y)) end
      local text = table.concat(lines, " ")
      for _, name in ipairs({ "join", "chat", "advance", "setItem", "createTrainArrive", "addPlayer" }) do
        print("RESULT " .. name .. " " .. tostring(text:find(name, 1, true) ~= nil))
      end
      print("RESULT emulator " .. tostring(text:find("emulator's", 1, true) ~= nil))
    `);
    expect(results).toEqual([
      "join true",
      "chat true",
      "advance true",
      "setItem true",
      "createTrainArrive true",
      "addPlayer true",
      "emulator true",
    ]);
  });

  it("shows no economy, approvals or their commands in a world without the server mod", async () => {
    writeFileSync(
      join(scratch, "plain.lua"),
      `local w = window.create(term.current(), 1, 1, 400, 40, false)
      local old = term.redirect(w)
      shell.run("sim help")
      shell.run("sim join Alice")
      shell.run("sim state")
      term.redirect(old)
      local lines = {}
      for y = 1, 40 do lines[#lines + 1] = (w.getLine(y)) end
      local h = fs.open("/results/help.txt", "w")
      h.write(table.concat(lines, "\\n"))
      h.close()`,
    );
    const result = await runProgram(config, {
      program: "plain.lua",
      world: {
        ...WORLD,
      } as WorldConfig,
      timeoutMs: 30000,
      keepRuntime: true,
    });
    try {
      expect(result.status).toBe("completed");
      const text = readFileSync(
        join(result.runtimeDir!, "results", "help.txt"),
        "utf8",
      );
      expect(text).toContain("setItem");
      for (const word of [
        "approve",
        "revoke",
        "setBalance",
        "setEconomy",
        "balance",
      ])
        expect(text, word).not.toContain(word);
      const raw = JSON.parse(
        readFileSync(join(result.runtimeDir!, "results", "state.json"), "utf8"),
      ) as Record<string, unknown>;
      for (const key of [
        "balances",
        "ledger",
        "rejections",
        "pendingApprovals",
        "terminalLocked",
        "authenticated",
      ])
        expect(raw[key], key).toBeUndefined();
      expect(raw["live"]).toBeDefined();
    } finally {
      rmSync(result.runtimeDir!, { recursive: true, force: true });
    }
  });

  it("has a help topic, only where the program is", async () => {
    const lookup = `print("RESULT " .. tostring(help.lookup("sim") ~= nil))`;
    const on = await run(lookup);
    expect(on.results).toEqual(["true"]);
    const off = await run(lookup, { ...WORLD, simProgram: false });
    expect(off.results).toEqual(["false"]);
    // what `help sim` shows (the help program pages it, waiting for keys)
    const { results } = await run(`
      local h = fs.open(help.lookup("sim"), "r")
      local text = h.readAll()
      h.close()
      print("RESULT " .. tostring(text:find("sim join <player>", 1, true) ~= nil))
    `);
    expect(results).toEqual(["true"]);
  });

  it("completes verbs, players and peripherals in the shell", async () => {
    const { results } = await run(`
      local function c(line) return table.concat(shell.complete(line) or {}, ",") .. "|" end
      print("RESULT " .. c("sim jo"))
      shell.run("sim state")
      print("RESULT " .. c("sim join Al"))
      print("RESULT " .. c("sim item ch"))
    `);
    expect(results).toEqual(["in |", "ice |", "est_0 ,atBox_0 |"]);
  });

  it("is not there unless a person drives the computer, as on a real server", async () => {
    const { results } = await run(
      `
      print("RESULT alias " .. tostring(shell.aliases().sim))
      print("RESULT rom " .. tostring(fs.exists("/rom/programs/sim.lua")) .. " " .. tostring(fs.exists("/rom/autorun/sim.lua")))
      print("RESULT run " .. tostring(shell.run("sim join Alice")))
      os.queueEvent("ccsim_cmd", "sim:1", "list")
      local ev, token = os.pullEvent("ccsim_cmd")
      print("RESULT own event " .. ev .. " " .. token)
    `,
      { ...WORLD, simProgram: false },
    );
    expect(results).toEqual([
      "alias nil",
      "rom false false",
      "run false",
      "own event ccsim_cmd sim:1",
    ]);
  });

  it("will not unload the computer it runs on", async () => {
    const { screen } = await run(`shell.run("sim unload")`);
    expect(screen).toContain("hold Ctrl+R");
  });
});
