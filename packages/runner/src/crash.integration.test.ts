// An engine crash in a run's or a test's result (engine/src/crashreport.hpp): "engine crashed: <reason>" and the
// report's path, not a run that just stopped. CRAFTOS_TEST_CRASH=computer makes the engine crash as a computer starts.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { checkConfig, loadConfig, runProgram, runTests } from "./index.js";

const scratch = mkdtempSync(join(tmpdir(), "crash-ws-"));
const crashes = join(scratch, ".crashes");
const config = { ...loadConfig(), workspaceDir: scratch };
const ready = process.platform === "win32" && checkConfig(config).length === 0;

// the suite may run on shared engines (CRAFTOS_POOL in vitest.config.ts): each case sets its own and puts it back
const poolBefore = process.env["CRAFTOS_POOL"];
afterEach(() => {
  delete process.env["CRAFTOS_TEST_CRASH"];
  delete process.env["CRAFTOS_CRASH_DIR"];
  if (poolBefore === undefined) delete process.env["CRAFTOS_POOL"];
  else process.env["CRAFTOS_POOL"] = poolBefore;
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe.skipIf(!ready)("an engine crash in the results", () => {
  for (const pool of [false, true]) {
    it(`a run says the engine crashed and where its report is${pool ? " (shared engine)" : ""}`, async () => {
      writeFileSync(join(scratch, "hi.lua"), 'print("hi")');
      process.env["CRAFTOS_TEST_CRASH"] = "computer";
      process.env["CRAFTOS_CRASH_DIR"] = crashes;
      process.env["CRAFTOS_POOL"] = pool ? "4" : "0";
      {
        const result = await runProgram(config, {
          program: "hi.lua",
          timeoutMs: 20000,
        });
        expect(result.status).toBe("engine_error");
        expect(result.crash?.reason).toContain("access violation");
        expect(existsSync(result.crash!.report)).toBe(true);
      }
    }, 40000);
  }

  for (const pool of [false, true]) {
    it(`a test file says so too${pool ? ", every file the shared engine held" : ""}`, async () => {
      const paths = pool
        ? ["one.test.lua", "two.test.lua", "three.test.lua"]
        : ["one.test.lua"];
      for (const path of paths)
        writeFileSync(
          join(scratch, path),
          'ccunit.test("x", function() ccunit.eq(1, 1) end)',
        );
      process.env["CRAFTOS_TEST_CRASH"] = "computer";
      process.env["CRAFTOS_CRASH_DIR"] = crashes;
      process.env["CRAFTOS_POOL"] = pool ? "4" : "0";
      const result = await runTests(
        config,
        { paths, timeoutMs: 20000 },
        paths.length,
      );
      expect(result.files).toHaveLength(paths.length);
      for (const file of result.files) {
        expect(file.status, file.file).toBe("crashed");
        expect(existsSync(file.crash!.report), file.file).toBe(true);
        expect(
          file.tests.some((t) =>
            /^engine crashed: .*, report at .+/.test(t.error ?? ""),
          ),
          file.file,
        ).toBe(true);
      }
    }, 60000);
  }
});
