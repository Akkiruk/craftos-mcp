import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type TestRunResult,
  type WorldConfig,
  checkConfig,
  loadConfig,
  runTests,
  worldJson,
} from "./index.js";

/**
 * Metaphysics 0.0.6 (Forge 1.20.1), checked against behaviour read from the released jar (decompiled) and crypto
 * vectors from the JDK 21 the mod runs on. docs/metaphysics.md has the source for every rule. The mod is not in the
 * pack: nothing here was measured in game.
 */
const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "metaphysics-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(config).length === 0;
const EXAMPLE = "examples/metaphysics";

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

cpSync(join(base.workspaceDir, EXAMPLE), join(scratch, EXAMPLE), {
  recursive: true,
});

const exampleWorld = JSON.parse(
  readFileSync(join(scratch, EXAMPLE, "watchtower.world.json"), "utf8"),
) as WorldConfig;

function expectAllPassed(result: TestRunResult): void {
  const failures = result.files.flatMap((f) =>
    f.tests.filter((t) => !t.passed).map((t) => `${t.name}: ${t.error}`),
  );
  expect(failures).toEqual([]);
  expect(result.files.map((f) => f.status)).toEqual(["passed"]);
}

describe.skipIf(!ready)("Metaphysics", () => {
  it("the example and every function of crypto and coord", async () => {
    const result = await runTests(
      config,
      {
        paths: [`${EXAMPLE}/watchtower.test.lua`],
        world: exampleWorld,
        timeScale: 10,
        timeoutMs: 120000,
      },
      1,
    );
    expectAllPassed(result);
  }, 180000);

  it("the APIs are globals only when the world has a metaphysics key", async () => {
    writeFileSync(
      join(scratch, "meta-off.test.lua"),
      `
ccunit.test("no key, no APIs", function()
  ccunit.eq({ crypto, cryptography, coord, coordinate }, {})
end)
`,
    );
    expectAllPassed(
      await runTests(
        config,
        {
          paths: ["meta-off.test.lua"],
          world: { version: "1.20.1", addons: ["metaphysics"] } as WorldConfig,
        },
        1,
      ),
    );
  }, 120000);

  it("exists only on 1.20.1", () => {
    for (const version of ["1.18.2", "1.21.1"]) {
      expect(() =>
        worldJson({ ...exampleWorld, version } as WorldConfig),
      ).toThrow(/no release for Minecraft/);
    }
  });
});
