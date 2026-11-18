import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  COPY_SKIP,
  type RunnerConfig,
  VERSIONS,
  checkProject,
  checkWorld,
  craftosHome,
  findProject,
  listWorkspace,
  loadConfig,
  loadNamedWorld,
  megabytes,
  packageVersion,
  projectWorld,
  resolveVersion,
  romDirFor,
  runProgram,
  withoutEditorKeys,
} from "@craftos-mcp/runner";
import type { Command } from "../command.js";
import { configFor, guarded, parse } from "../shared.js";

const USAGE = [
  "usage: craftos-mcp doctor [--dir folder] [--json] [--skip-boot]",
  "",
  "Checks what craftos-mcp needs: Node.js, the engine for this platform (there, runs, its version), every ROM, the",
  "cache folder and its free space, the macOS quarantine flag, the project's craftos.json and world files, and that",
  "a hello-world computer boots (--skip-boot leaves that out). Each failed check says how to fix it.",
  "Exits 1 when a check fails, 0 otherwise. --json prints the checks as JSON.",
].join("\n");

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface Check {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly fix?: string;
}

const SETUP_FIX = (): string =>
  packageVersion()
    ? "run: craftos-mcp setup --force"
    : "run: npm run setup (or build engine/ with engine/build.cmd or engine/build.sh)";

/** The engine's own --version line ("CraftOS-PC v2.8.4"), or why it did not run. */
function engineVersion(exe: string): { version?: string; error?: string } {
  const r = spawnSync(exe, ["--version"], {
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });
  if (r.error) return { error: r.error.message };
  const line = `${r.stdout ?? ""}`
    .split(/\r?\n/)
    .find((l) => /CraftOS/.test(l));
  if (r.status !== 0 || !line)
    return {
      error: `exit ${r.status ?? r.signal}${r.stderr ? `: ${r.stderr.trim().split("\n")[0]}` : ""}`,
    };
  return { version: line.trim() };
}

function nodeCheck(version = process.versions.node): Check {
  const major = Number(version.split(".")[0]);
  return major >= 22
    ? { name: "Node.js", status: "ok", detail: `v${version}` }
    : {
        name: "Node.js",
        status: "fail",
        detail: `v${version} is too old`,
        fix: "install Node.js 22 or newer (https://nodejs.org)",
      };
}

function engineChecks(config: RunnerConfig): Check[] {
  const where = `${process.platform}-${process.arch}`;
  if (!existsSync(config.engineExe))
    return [
      {
        name: "engine",
        status: "fail",
        detail: `no engine for ${where} at ${config.engineExe}`,
        fix: SETUP_FIX(),
      },
    ];
  const { version, error } = engineVersion(config.engineExe);
  return [
    { name: "engine", status: "ok", detail: `${config.engineExe} (${where})` },
    version
      ? { name: "engine runs", status: "ok", detail: version }
      : {
          name: "engine runs",
          status: "fail",
          detail: `it did not start: ${error}`,
          fix:
            process.platform === "darwin"
              ? `see the quarantine check; else ${SETUP_FIX()}`
              : process.platform === "win32"
                ? `install the Visual C++ Redistributable (x64), then ${SETUP_FIX()}`
                : SETUP_FIX(),
        },
  ];
}

function romChecks(config: RunnerConfig): Check[] {
  const seen = new Map<string, string[]>();
  for (const v of VERSIONS) {
    const dir = romDirFor(config, resolveVersion(v.mc));
    seen.set(dir, [...(seen.get(dir) ?? []), v.mc]);
  }
  return [...seen].map(([dir, mcs]) => {
    const name = `ROM ${mcs.join("/")}`;
    if (existsSync(join(dir, "bios.lua")))
      return { name, status: "ok", detail: dir };
    return {
      name,
      status: "fail",
      detail: `missing at ${dir}`,
      fix: packageVersion()
        ? "run: craftos-mcp setup --force"
        : `run: node scripts/build-rom.mjs --download ${mcs[0]}`,
    };
  });
}

function cacheCheck(config: RunnerConfig): Check {
  const dir = packageVersion() ? craftosHome() : config.runtimeDir;
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.doctor-${process.pid}`);
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
  } catch (error) {
    return {
      name: "cache",
      status: "fail",
      detail: `${dir} is not writable: ${(error as Error).message}`,
      fix: "set CRAFTOS_HOME (or CRAFTOS_RUNTIME_ROOT) to a folder you can write",
    };
  }
  let free: number | undefined;
  try {
    const s = statfsSync(dir);
    free = s.bavail * s.bsize;
  } catch {
    // no statfs here: the space goes unchecked
  }
  const detail = `${dir}${free === undefined ? "" : `, ${megabytes(free)} free`}`;
  if (free !== undefined && free < 200 * 1024 * 1024)
    return {
      name: "cache",
      status: "fail",
      detail,
      fix: "free some disk space (a setup needs about 150 MB); craftos-mcp cache prune removes old versions",
    };
  if (free !== undefined && free < 1024 * 1024 * 1024)
    return {
      name: "cache",
      status: "warn",
      detail,
      fix: "under 1 GB free: craftos-mcp cache prune removes old versions",
    };
  return { name: "cache", status: "ok", detail };
}

function quarantineCheck(config: RunnerConfig): Check {
  if (process.platform !== "darwin")
    return { name: "quarantine", status: "skip", detail: "not macOS" };
  if (!existsSync(config.engineExe))
    return { name: "quarantine", status: "skip", detail: "no engine" };
  const r = spawnSync(
    "xattr",
    ["-p", "com.apple.quarantine", config.engineExe],
    {
      encoding: "utf8",
    },
  );
  if (r.status === 0)
    return {
      name: "quarantine",
      status: "fail",
      detail: "the engine is quarantined: macOS refuses to run it",
      fix: `run: xattr -dr com.apple.quarantine "${dirname(dirname(config.engineExe))}"`,
    };
  return { name: "quarantine", status: "ok", detail: "not quarantined" };
}

/** A world file's problems, as checkWorld finds them. */
function worldProblems(file: string, load: () => unknown): string[] {
  try {
    const { errors } = checkWorld(withoutEditorKeys(load() as object));
    return errors;
  } catch (error) {
    return [`${file}: ${(error as Error).message}`];
  }
}

function projectChecks(start: string, config: RunnerConfig): Check[] {
  let found;
  try {
    found = findProject(start);
  } catch (error) {
    return [
      {
        name: "craftos.json",
        status: "fail",
        detail: (error as Error).message,
        fix: "make it valid JSON, or craftos-mcp init --force writes a new one",
      },
    ];
  }
  const checks: Check[] = [];
  if (!found)
    checks.push({
      name: "craftos.json",
      status: "skip",
      detail: "none here (craftos-mcp init writes one)",
    });
  else {
    const errors = checkProject(found.data, found.dir);
    checks.push(
      errors.length
        ? {
            name: "craftos.json",
            status: "fail",
            detail: `${found.file}: ${errors.join("; ")}`,
            fix: "fix those keys; schemas/craftos.schema.json lists what each takes",
          }
        : { name: "craftos.json", status: "ok", detail: found.file },
    );
    const world = projectWorld(found);
    if (world && !errors.length) {
      const problems = worldProblems(world, () =>
        /\.json$/i.test(world)
          ? JSON.parse(readFileSync(world, "utf8"))
          : loadNamedWorld(config.worldsDir, world),
      );
      checks.push(
        problems.length
          ? {
              name: "project world",
              status: "fail",
              detail: `${world}: ${problems.join("; ")}`,
              fix: "fix the world file (schemas/world.schema.json), or open it in the VS Code World Editor",
            }
          : { name: "project world", status: "ok", detail: world },
      );
    }
  }
  // the *.world.json files in the workspace
  let files: string[] = [];
  try {
    files = listWorkspace(config.workspaceDir, ".", COPY_SKIP)
      .filter((e) => e.kind === "file" && e.path.endsWith(".world.json"))
      .map((e) => e.path)
      .slice(0, 50);
  } catch {
    // an unreadable workspace shows up elsewhere
  }
  const bad: string[] = [];
  for (const f of files) {
    const full = join(config.workspaceDir, f);
    const problems = worldProblems(f, () =>
      JSON.parse(readFileSync(full, "utf8")),
    );
    if (problems.length) bad.push(`${f}: ${problems[0]}`);
  }
  if (files.length)
    checks.push(
      bad.length
        ? {
            name: "world files",
            status: "fail",
            detail: `${bad.length} of ${files.length} have problems: ${bad.slice(0, 3).join("; ")}`,
            fix: "fix them (schemas/world.schema.json), or open each in the VS Code World Editor",
          }
        : {
            name: "world files",
            status: "ok",
            detail: `${files.length} valid`,
          },
    );
  return checks;
}

async function bootCheck(config: RunnerConfig): Promise<Check> {
  // not in the runtime folder: a workspace in there is skipped when it is copied onto the computer
  const dir = mkdtempSync(join(tmpdir(), "craftos-doctor-"));
  try {
    writeFileSync(join(dir, "hello.lua"), 'print("hello from craftos-mcp")\n');
    const cfg = loadConfig({
      ...process.env,
      CRAFTOS_WORKSPACE: dir,
      CRAFTOS_RUNTIME_ROOT: config.runtimeDir,
    });
    const started = Date.now();
    // the default world: a broken craftos.json world or mod list is the project checks' job
    const result = await runProgram(cfg, {
      program: "hello.lua",
      timeoutMs: 60_000,
      world: { addons: "none" },
    });
    const said = result.screens[0]?.lines.some((l) =>
      l.includes("hello from craftos-mcp"),
    );
    if (result.status === "completed" && said)
      return {
        name: "boot",
        status: "ok",
        detail: `hello world ran in ${Date.now() - started} ms`,
      };
    return {
      name: "boot",
      status: "fail",
      detail: `hello world ${result.status}${said ? "" : " without printing hello"}${result.stderr ? `: ${result.stderr.trim().split("\n")[0]}` : ""}`,
      fix: "craftos-mcp info shows the setup; craftos-mcp setup --force sets it up again",
    };
  } catch (error) {
    return {
      name: "boot",
      status: "fail",
      detail: (error as Error).message,
      fix: SETUP_FIX(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every check, in the order a person fixes them. */
export async function runChecks(
  dir: string | undefined,
  { boot = true }: { boot?: boolean } = {},
): Promise<Check[]> {
  const checks: Check[] = [nodeCheck()];
  let config: RunnerConfig;
  try {
    config = configFor(dir);
  } catch {
    // a broken craftos.json: the project check says why; the rest goes on without it
    const before = process.env["CRAFTOS_PROJECT_FILE"];
    process.env["CRAFTOS_PROJECT_FILE"] = "off";
    try {
      config = configFor(dir);
    } finally {
      if (before === undefined) delete process.env["CRAFTOS_PROJECT_FILE"];
      else process.env["CRAFTOS_PROJECT_FILE"] = before;
    }
  }
  checks.push(...engineChecks(config));
  checks.push(...romChecks(config));
  checks.push(cacheCheck(config));
  checks.push(quarantineCheck(config));
  checks.push(...projectChecks(dir ?? process.cwd(), config));
  const blocked = checks.some(
    (c) =>
      c.status === "fail" &&
      (c.name.startsWith("engine") || c.name === "quarantine"),
  );
  let romOk = false;
  try {
    romOk = existsSync(
      join(romDirFor(config, resolveVersion(undefined)), "bios.lua"),
    );
  } catch {
    // CRAFTOS_VERSION names no version: the boot has no ROM to use
  }
  if (!boot)
    checks.push({ name: "boot", status: "skip", detail: "--skip-boot" });
  else if (blocked || !romOk)
    checks.push({
      name: "boot",
      status: "skip",
      detail: "the engine or the default ROM is missing",
    });
  else checks.push(await bootCheck(config));
  return checks;
}

export function formatChecks(checks: readonly Check[]): string {
  const width = Math.max(...checks.map((c) => c.name.length));
  const out: string[] = [];
  for (const c of checks) {
    const mark = { ok: "ok  ", warn: "warn", fail: "FAIL", skip: "skip" }[
      c.status
    ];
    out.push(`  ${mark}  ${c.name.padEnd(width)}  ${c.detail}`);
    if (c.fix && c.status !== "ok" && c.status !== "skip")
      out.push(`  ${" ".repeat(4)}  ${" ".repeat(width)}  fix: ${c.fix}`);
  }
  const failed = checks.filter((c) => c.status === "fail").length;
  out.push("");
  out.push(
    failed
      ? `${failed} check${failed === 1 ? "" : "s"} failed.`
      : "Everything is ready.",
  );
  return out.join("\n");
}

const doctor: Command = {
  name: "doctor",
  summary: "check the setup and say how to fix what is wrong",
  usage: USAGE,
  run: (args) =>
    guarded(USAGE, async () => {
      const { values } = parse(args, {
        json: { type: "boolean" },
        "skip-boot": { type: "boolean" },
      });
      if (values.help) {
        console.log(USAGE);
        return 0;
      }
      const v = values as { json?: boolean; "skip-boot"?: boolean };
      const checks = await runChecks(values.dir, { boot: !v["skip-boot"] });
      const ok = !checks.some((c) => c.status === "fail");
      if (v.json) console.log(JSON.stringify({ ok, checks }, null, 2));
      else {
        console.log(`craftos-mcp doctor (${packageVersion() ?? "clone"})`);
        console.log(formatChecks(checks));
      }
      return ok ? 0 : 1;
    }),
};
export default doctor;
