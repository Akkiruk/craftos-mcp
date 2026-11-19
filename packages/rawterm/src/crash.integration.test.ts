import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { EnginePool } from "./pool.js";
import { RawSession, parseEngineCrash } from "./session.js";

// The engine's own crash report (engine/src/crashreport.hpp): CRAFTOS_TEST_CRASH=computer makes a computer's thread
// crash as it starts. Headless, the engine must not show a dialog (the run would wait for someone to close it): it
// writes a report and a minidump, says where on stderr, and exits nonzero, at once.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const executable =
  process.env["CRAFTOS_EXE"] ?? join(root, "engine/build/craftos.exe");
const rom = process.env["CRAFTOS_ROM"] ?? join(root, "rom/cc-1.101.3");
const available =
  process.platform === "win32" &&
  existsSync(executable) &&
  existsSync(join(rom, "bios.lua"));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "craftos-crash-"));
  dirs.push(dir);
  return dir;
}

describe.skipIf(!available)("the engine's crash report", () => {
  it("writes a report and a minidump, says so on stderr, and exits nonzero without a dialog", async () => {
    const dir = scratch();
    const crashes = join(dir, "crashes");
    const session = new RawSession({
      executable,
      args: ["--directory", dir, "--rom", rom],
      env: {
        ...process.env,
        CRAFTOS_TEST_CRASH: "computer",
        CRAFTOS_CRASH_DIR: crashes,
      },
    });
    let stderr = "";
    session.on("stderr", (t) => (stderr += t));
    const started = Date.now();
    const info = await session.waitForExit(15000);
    expect(Date.now() - started).toBeLessThan(15000);
    expect(info.code).not.toBe(0);
    const crash = parseEngineCrash(stderr);
    expect(crash?.reason).toContain("access violation");
    expect(existsSync(crash!.report)).toBe(true);
    const report = readFileSync(crash!.report, "utf8");
    expect(report).toContain("github.com/Akkiruk/craftos-mcp/issues");
    expect(report).toContain("computer:        id 0");
    expect(report).toContain("computerThread");
    expect(readdirSync(crashes).some((f) => f.endsWith(".dmp"))).toBe(true);
  }, 30000);

  it("tells every computer of a shared engine that it crashed, with the report", async () => {
    const dir = scratch();
    const crashes = join(dir, "crashes");
    const pool = new EnginePool({
      executable,
      args: ["--directory", dir, "--rom", rom],
      env: {
        ...process.env,
        CRAFTOS_TEST_CRASH: "computer",
        CRAFTOS_CRASH_DIR: crashes,
      },
      idleMs: 0,
    });
    mkdirSync(join(dir, "c", "computer"), { recursive: true });
    const session = pool.start({ id: 0, base: join(dir, "c") });
    let stderr = "";
    session.on("stderr", (t) => (stderr += t));
    const info = await session.waitForExit(15000);
    expect(info.code).not.toBe(0);
    expect(parseEngineCrash(stderr)?.report).toBeDefined();
    pool.close();
  }, 30000);
});
