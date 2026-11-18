// The vhcctweaks addon (docs/vhcctweaks.md): how a world switches it on, which release it gets, and a short tour of what
// it adds. Runs in both builds: here vhcctweaks is on by default on 1.18.2, in the public copy it is opt-in.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type TestRunResult,
  type WorldConfig,
  checkConfig,
  linksInUse,
  loadConfig,
  resolveVersion,
  runTests,
  vhccVersion,
  worldJson,
} from "./index.js";

const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "vhcc-addon-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(config).length === 0;
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const DEFAULT_ON = false;

const on1182 = (world: WorldConfig = {}): WorldConfig => ({
  version: "1.18.2",
  ...world,
});

function put(name: string, content: string): void {
  const file = join(scratch, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

async function runLua(
  lua: string,
  world: WorldConfig,
  name = "case.test.lua",
): Promise<TestRunResult> {
  put(name, lua);
  return runTests(config, { paths: [name], world, timeoutMs: 30000 }, 1);
}

function expectAllPassed(result: TestRunResult): void {
  const failures = result.files.flatMap((f) =>
    f.tests.filter((t) => !t.passed).map((t) => `${t.name}: ${t.error}`),
  );
  expect(failures).toEqual([]);
  expect(result.files.map((f) => f.status)).toEqual(["passed"]);
}

describe("which vhcctweaks a world runs", () => {
  const v1182 = resolveVersion("1.18.2");
  it("names the release, or the addon gives 2.2.36", () => {
    expect(vhccVersion({ vhcctweaks: "2.2.37" }, v1182)).toBe("2.2.37");
    expect(vhccVersion({ vhcctweaks: "2.2.35" }, v1182)).toBe("2.2.35");
    expect(vhccVersion({ addons: ["vhcctweaks"] }, v1182)).toBe("2.2.36");
    expect(vhccVersion({ addons: ["all", "vhcctweaks"] }, v1182)).toBe(
      "2.2.36",
    );
    expect(
      vhccVersion({ addons: ["vhcctweaks"], vhcctweaks: false }, v1182),
    ).toBe(false);
    expect(vhccVersion({}, v1182)).toBe(DEFAULT_ON ? "2.2.36" : false);
    expect(vhccVersion({ addons: "all" }, v1182)).toBe(
      DEFAULT_ON ? "2.2.36" : false,
    );
  });

  it("only exists on 1.18.2", () => {
    const v121 = resolveVersion("1.21.1");
    expect(vhccVersion({}, v121)).toBe(false);
    expect(() =>
      worldJson({ version: "1.21.1", vhcctweaks: "2.2.36" }),
    ).toThrow(/only exists for Minecraft 1\.18\.2.*"version": "1\.18\.2"/);
    expect(() =>
      worldJson({ version: "1.21.1", addons: ["vhcctweaks"] }),
    ).toThrow(/vhcctweaks.*no release for Minecraft 1\.21\.1/);
  });

  it("goes to the sim as the release or false", () => {
    const sent = (world: WorldConfig) =>
      (JSON.parse(worldJson(world)) as { vhcctweaks: unknown }).vhcctweaks;
    expect(sent(on1182({ addons: ["vhcctweaks"] }))).toBe("2.2.36");
    expect(sent(on1182({ vhcctweaks: "2.2.37" }))).toBe("2.2.37");
    expect(sent({ version: "1.21.1" })).toBe(false);
  });
});

describe("the linked computers note", () => {
  const ender = [{ name: "top", type: "modem", kind: "ender" as const }];
  it("is for a world with links: the mod at 2.2.36 or later and an ender modem", () => {
    expect(
      linksInUse(on1182({ vhcctweaks: "2.2.36", peripherals: ender })),
    ).toBe(true);
    expect(
      linksInUse(on1182({ vhcctweaks: "2.2.37", peripherals: ender })),
    ).toBe(true);
    expect(
      linksInUse(on1182({ vhcctweaks: "2.2.35", peripherals: ender })),
    ).toBe(false);
    expect(linksInUse(on1182({ vhcctweaks: false, peripherals: ender }))).toBe(
      false,
    );
    expect(linksInUse(on1182({ vhcctweaks: "2.2.36" }))).toBe(false);
    expect(linksInUse({ version: "1.21.1", peripherals: ender })).toBe(false);
  });
});

describe.skipIf(!ready)("the vhcctweaks addon on a computer", () => {
  it("is off without it, and the computer is plain CC:Tweaked", async () => {
    const result = await runLua(
      `
ccunit.test("no mod", function()
  ccunit.eq(ccvault, nil)
  ccunit.eq(vhcc, nil)
  ccunit.eq(peripheral.hasType("top", "peripheral_hub"), false)
end)
`,
      on1182({
        vhcctweaks: false,
        peripherals: [{ name: "top", type: "modem", kind: "ender" }],
      }),
      "off.test.lua",
    );
    expectAllPassed(result);
  }, 60000);

  it("named in the addons: ccvault, vhcc and linked ender modems", async () => {
    const result = await runLua(
      `
ccunit.test("ccvault", function()
  ccunit.truthy(ccvault.isAvailable())
  ccunit.eq(ccvault.getPlayerBalance("steve"), 1000)
  ccunit.truthy(ccvault.requestAuth())
  ccunit.eq(ccvault.getBalance("player"), 500)
  local result = ccvault.transfer("player", "host", 120, "a sale")
  ccunit.truthy(result.success)
  ccunit.eq(ccvault.getBalance("player"), 380)
  ccunit.eq(ccvault.getBalance("host"), 1120)
  ccunit.eq(ccvault.verifyTransaction(result.txId).amount, 120)
end)

ccunit.test("vhcc files", function()
  ccunit.truthy(vhcc.write("notes/a.txt", "hello"))
  ccunit.eq(vhcc.read("notes/a.txt"), "hello")
  ccunit.eq(vhcc.exists("notes/a.txt"), true)
end)

ccunit.test("an ender modem is a peripheral hub", function()
  ccunit.eq(peripheral.hasType("top", "peripheral_hub"), true)
  ccunit.truthy(peripheral.wrap("top").getLinks)
end)

ccunit.test("2.2.37 is not there on 2.2.36", function()
  ccunit.eq(ccvault.getPlayerGearPower, nil)
end)
`,
      on1182({
        addons: ["all", "vhcctweaks"],
        players: [
          { name: "Steve", balance: 1000 },
          { name: "Alex", balance: 500 },
        ],
        host: "Steve",
        interacting: "Alex",
        autoApprove: true,
        peripherals: [{ name: "top", type: "modem", kind: "ender" }],
      }),
      "on.test.lua",
    );
    expectAllPassed(result);
  }, 60000);

  it('"2.2.37": the player reads and identify', async () => {
    const result = await runLua(
      `
ccunit.test("2.2.37 API", function()
  ccunit.eq(type(ccvault.getPlayerGearPower), "function")
  ccunit.eq(type(ccvault.getPlayerTemper), "function")
  ccunit.eq(type(vhcc.getUsage), "function")
  local chest = peripheral.wrap("chest")
  ccunit.eq(type(chest.identify), "function")
  ccunit.eq(type(chest.listContents), "function")
end)
`,
      on1182({
        vhcctweaks: "2.2.37",
        players: [{ name: "Steve", balance: 10 }],
        peripherals: [{ name: "chest", type: "minecraft:chest" }],
      }),
      "v37.test.lua",
    );
    expectAllPassed(result);
  }, 60000);
});
