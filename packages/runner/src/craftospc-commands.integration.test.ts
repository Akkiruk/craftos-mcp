// CraftOS-PC's commands (attach, detach, config, mount) on a computer a person drives, CraftOS-PC's APIs when a world
// turns them on (craftosPcApis), and the plain CC:Tweaked surface everywhere else (rom/ccsim/craftospc*).
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type WorldConfig,
  checkConfig,
  importCraftosPc,
  loadConfig,
  runProgram,
} from "./index.js";

const scratch = mkdtempSync(join(tmpdir(), "craftospc-cmd-ws-"));
const config = { ...loadConfig(), workspaceDir: scratch };
const ready = checkConfig(config).length === 0;
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// What a shell command printed, one string with "|" between lines (the screen is too small to read it from)
const CAPTURE = `
local function capture(cmd)
  local out = {}
  local p, pe = _G.print, _G.printError
  _G.print = function(...)
    local t = table.pack(...)
    for i = 1, t.n do t[i] = tostring(t[i]) end
    out[#out + 1] = table.concat(t, " ")
  end
  _G.printError = _G.print
  local ok, err = pcall(shell.run, cmd)
  _G.print, _G.printError = p, pe
  if not ok then out[#out + 1] = "ERR " .. tostring(err) end
  return table.concat(out, "|")
end
local results = {}
local function result(v) results[#results + 1] = tostring(v) end
`;
const DONE = `
local h = fs.open("/results/check.json", "w")
h.write(textutils.serializeJSON(results))
h.close()
`;

async function run(
  source: string,
  world: WorldConfig,
  mc = "1.21.1",
): Promise<string[]> {
  writeFileSync(join(scratch, "check.lua"), CAPTURE + source + DONE);
  const result = await runProgram(config, {
    program: "check.lua",
    world: { addons: "none", version: mc, ...world },
    timeoutMs: 30000,
    keepRuntime: true,
  });
  try {
    const screen = (result.screens[0]?.lines ?? []).join("\n");
    expect(result.status, `${screen}\n${result.stderr}`).toBe("completed");
    return JSON.parse(
      readFileSync(join(result.runtimeDir!, "results", "check.json"), "utf8"),
    ) as string[];
  } finally {
    if (result.runtimeDir)
      rmSync(result.runtimeDir, { recursive: true, force: true });
  }
}

describe.skipIf(!ready)(
  "CraftOS-PC commands on a computer a person drives",
  () => {
    for (const mc of ["1.18.2", "1.21.1"])
      it(`attach and detach place and break blocks, live (${mc})`, async () => {
        const r = await run(
          `
        local seen = {}
        parallel.waitForAny(function()
          while true do local e, side = os.pullEvent() if e == "peripheral" or e == "peripheral_detach" then seen[#seen + 1] = e .. ":" .. side end end
        end, function()
          result(capture("attach left monitor"))
          result(peripheral.getType("left"))
          result(table.concat({ peripheral.call("left", "getSize") }, "x"))
          result(capture("attach top speaker"))
          result(peripheral.getType("top"))
          result(capture("attach back chest"))
          result(peripheral.getType("back") .. " " .. peripheral.call("back", "size"))
          result(capture("attach right modem"))
          result(tostring(peripheral.call("right", "isWireless")))
          result(capture("detach left"))
          result(tostring(peripheral.isPresent("left")))
          result(capture("attach left monitor 2 1"))
          result(table.concat({ peripheral.call("left", "getSize") }, "x"))
          os.sleep(0.2)
        end)
        result(table.concat(seen, ","))
      `,
          { simProgram: true },
          mc,
        );
        expect(r[0]).toContain("Placed a monitor (5x3 blocks) on left.");
        expect(r[0]).toContain(
          "In the game you would put the block next to the computer",
        );
        expect(r[0]).toContain(
          `world file's "monitors":|  { "name": "left", "blocksWide": 5, "blocksHigh": 3 }`,
        );
        expect(r[5]).toContain(
          `world file's "peripherals":|  { "name": "back", "type": "minecraft:chest", "size": 27 }`,
        );
        expect(r.slice(1, 3)).toEqual(["monitor", "50x19"]);
        expect(r[3]).toContain("Placed a speaker on top.");
        expect(r[4]).toBe("speaker");
        expect(r[5]).toContain("Placed a chest on back.");
        expect(r[6]).toBe("minecraft:chest 27");
        expect(r[8]).toBe("true");
        expect(r[9]).toContain("Took the peripheral off left.");
        expect(r[10]).toBe("false");
        expect(r[12]).toBe("18x5");
        expect(r[13]).toContain("peripheral:left");
        expect(r[13]).toContain("peripheral_detach:left");
      });

    it("explains what has no counterpart, and config and mount say where things live", async () => {
      const r = await run(
        `
      result(capture("attach left printer"))
      result(capture("attach left computer"))
      result(capture("attach"))
      result(capture("detach nowhere"))
      result(capture("config get isColor"))
      result(capture("config get defaultWidth"))
      result(capture("config set isColor false"))
      result(capture("config get showFPS"))
      result(capture("config list"))
      result(capture("mount"))
      result(capture("mount stuff C:/Users"))
      result(capture("unmount stuff"))
      `,
        { simProgram: true },
      );
      expect(r[0]).toContain("Placed a printer on left.");
      expect(r[0]).toContain(
        `{ "name": "left", "type": "printer", "ink": 64, "paper": 64 }`,
      );
      expect(r[1]).toContain("make a network");
      expect(r[2]).toContain("Usage: attach <side> <type> [options]");
      expect(r[3]).toContain("detach: no peripheral named nowhere");
      expect(r[4]).toBe("isColor = true");
      expect(r[5]).toBe("defaultWidth = 51");
      expect(r[6]).toContain(
        "isColor cannot be changed from inside the computer here",
      );
      expect(r[6]).toContain('"advanced": false');
      expect(r[7]).toContain("CraftOS-PC's showFPS has no counterpart here");
      expect(r[8]).toContain("http_enable = true");
      expect(r[9]).toContain("rom on /rom (read only)");
      expect(r[9]).not.toContain("ccunit");
      expect(r[9]).not.toContain("results");
      expect(r[10]).toContain("A real computer cannot see folders on your PC");
      expect(r[11]).toContain("A real computer cannot see folders on your PC");
    });

    it("a program of the same name in the computer's files wins", async () => {
      writeFileSync(join(scratch, "config.lua"), 'print("my own config")');
      try {
        const r = await run(`result(capture("config list"))`, {
          simProgram: true,
        });
        expect(r).toEqual(["my own config"]);
      } finally {
        rmSync(join(scratch, "config.lua"), { force: true });
      }
    });

    it("a computer nobody drives has none of it, as on a server", async () => {
      const r = await run(
        `
      result(tostring(shell.resolveProgram("attach")))
      result(tostring(shell.resolveProgram("mount")))
      result(type(periphemu) .. " " .. type(config) .. " " .. type(mounter))
      result(tostring(fs.exists("/rom/ccsim/craftospc")))
      `,
        {},
      );
      expect(r).toEqual(["nil", "nil", "nil nil nil", "false"]);
    });
  },
);

describe.skipIf(!ready)(
  "CraftOS-PC's APIs, when the world turns them on",
  () => {
    for (const mc of ["1.18.2", "1.21.1"])
      it(`periphemu, config and mounter act as the game would (${mc})`, async () => {
        const r = await run(
          `
        result(tostring(periphemu.create("left", "monitor")))
        result(peripheral.getType("left"))
        result(tostring(periphemu.create("left", "monitor")))
        result(tostring(periphemu.create("top", "drive")))
        result(peripheral.getType("top"))
        result(tostring(periphemu.remove("left")))
        result(tostring(periphemu.remove("left")))
        result(tostring(peripheral.isPresent("left")))
        result(table.concat(periphemu.names(), ","))
        local ok, err = periphemu.create("bottom", "printer")
        result(tostring(ok) .. " " .. tostring(err) .. " " .. tostring(peripheral.call("bottom", "getPaperLevel")))
        ok, err = pcall(periphemu.create, "left", "nosuchblock")
        result(tostring(ok) .. " " .. tostring(err))
        result(tostring(config.get("isColor")))
        ok, err = pcall(config.set, "isColor", false)
        result(tostring(ok) .. " " .. tostring(err))
        result(tostring(config.getType("defaultWidth")))
        ok, err = pcall(mounter.mount, "x", "C:/")
        result(tostring(ok) .. " " .. tostring(err))
        result(textutils.serialize(mounter.list(), { compact = true }))
        result(tostring(_HOST:find("CraftOS-PC", 1, true)))
        result(tostring(term.setGraphicsMode))
        `,
          { craftosPcApis: true },
          mc,
        );
        expect(r.slice(0, 9)).toEqual([
          "true",
          "monitor",
          "false",
          "true",
          "drive",
          "true",
          "false",
          "false",
          "monitor,drive,speaker,printer,modem,chest,tank,energy",
        ]);
        // a printer goes in, with a stack of ink and of paper
        expect(r[9]).toBe("true nil 64");
        expect(r[10]).toContain("false ");
        expect(r[10]).toContain("nosuchblock");
        expect(r[11]).toBe("true");
        expect(r[12]).toContain("isColor cannot be changed");
        expect(r[13]).toBe("number");
        expect(r[14]).toContain(
          "A real computer cannot see folders on your PC",
        );
        expect(r[15]).toContain('["/rom"]={"rom",}');
        expect(r[16]).toBe("nil");
        expect(r[17]).toBe("nil");
      });
  },
);

describe.skipIf(!ready)("a world's label", () => {
  it("is the computer's own label", async () => {
    const r = await run(
      `result(tostring(os.getComputerLabel()))
       os.setComputerLabel("Other")
       result(os.getComputerLabel())`,
      { label: "Base" },
    );
    expect(r).toEqual(["Base", "Other"]);
  });
});

describe.skipIf(!ready)("a computer brought over from CraftOS-PC", () => {
  it("boots with its files, label and peripherals, and its periphemu startup still runs", async () => {
    const source = join(scratch, "CraftOS-PC");
    mkdirSync(join(source, "computer", "4"), { recursive: true });
    mkdirSync(join(source, "config"), { recursive: true });
    writeFileSync(
      join(source, "computer", "4", "startup.lua"),
      'periphemu.create("top", "monitor")\nperiphemu.create("left", "speaker")\nperiphemu.create("right", "printer")\n_G.STARTED = peripheral.getType("top")\n',
    );
    writeFileSync(
      join(source, "config", "4.json"),
      JSON.stringify({
        base64: true,
        label: Buffer.from("Display").toString("base64"),
      }),
    );
    const out = join(scratch, "imported");
    const [c] = importCraftosPc(source, out).computers;
    writeFileSync(
      join(c!.dir, "check.lua"),
      CAPTURE +
        `
        shell.run("startup")
        result(_G.STARTED)
        result(os.getComputerLabel())
        result(peripheral.getType("left"))
        result(table.concat({ peripheral.call("top", "getSize") }, "x"))
        ` +
        DONE,
    );
    const { monitors = [], ...world } = c!.world;
    const result = await runProgram(
      { ...config, workspaceDir: c!.dir },
      {
        program: "check.lua",
        world: { addons: "none", ...world },
        monitors,
        timeoutMs: 30000,
        keepRuntime: true,
      },
    );
    try {
      expect(result.status, result.screens[0]?.lines.join("\n")).toBe(
        "completed",
      );
      const r = JSON.parse(
        readFileSync(join(result.runtimeDir!, "results", "check.json"), "utf8"),
      ) as string[];
      expect(r).toEqual(["monitor", "Display", "speaker", "50x19"]);
    } finally {
      rmSync(result.runtimeDir!, { recursive: true, force: true });
    }
  });
});
