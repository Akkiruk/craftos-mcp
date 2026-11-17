import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  SessionManager,
  checkConfig,
  loadConfig,
  settle,
  waitForBoot,
} from "./index.js";

const scratch = mkdtempSync(join(tmpdir(), "rs-boot-"));
const config = { ...loadConfig(), workspaceDir: scratch };
const ready = checkConfig(config).length === 0;
const manager = new SessionManager(config);

afterEach(async () => {
  await manager.destroyAll();
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe.skipIf(!ready)("redstone in the sim state", () => {
  it("shows the outputs a program set, per side, and bundled masks", async () => {
    writeFileSync(
      join(scratch, "startup.lua"),
      `redstone.setOutput("back", true)
rs.setAnalogOutput("left", 7)
redstone.setBundledOutput("top", colors.red + colors.blue)
print("set")
`,
    );
    const { handle, id } = manager.create();
    expect(id).toBeTruthy();
    await waitForBoot(handle.session);
    await settle(handle);
    const rsState = (handle.readState() as { redstone?: any }).redstone;
    expect(rsState.outputs.back).toBe(15);
    expect(rsState.outputs.left).toBe(7);
    expect(rsState.outputs.front).toBe(0);
    expect(rsState.bundledOutputs.top).toBe(
      /* red 2^14 + blue 2^11 */ 16384 + 2048,
    );
    expect(Object.keys(rsState.inputs).sort()).toEqual([
      "back",
      "bottom",
      "front",
      "left",
      "right",
      "top",
    ]);
  }, 60000);
});

describe.skipIf(!ready)("boot with a program from startup.lua", () => {
  it("reports a forever-loop program in front instead of timing out", async () => {
    writeFileSync(
      join(scratch, "startup.lua"),
      `print("door controller running")
while true do sleep(1) end
`,
    );
    const s = manager.create();
    const front = await waitForBoot(s.handle.session);
    expect(front).toBe("program");
    expect(s.handle.session.running).toBe(true);
  }, 60000);

  it("still reports the shell for a plain computer", async () => {
    writeFileSync(join(scratch, "startup.lua"), `print("booted")\n`);
    const s = manager.create();
    expect(await waitForBoot(s.handle.session)).toBe("shell");
  }, 60000);
});
