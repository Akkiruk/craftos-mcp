import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunnerConfig } from "./config.js";
import { RUN_OWNER_FILE, cleanStaleRuntime, stageEngine } from "./engine.js";
import { runProgram } from "./run.js";
import { runTests } from "./tests.js";
import { WorkspaceError } from "./workspace.js";
import {
  copyWorkspace,
  copyWorkspaceAsync,
  ignoredBy,
  measureWorkspace,
  parseGitignore,
} from "./copy.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function folder(): string {
  const d = mkdtempSync(join(tmpdir(), "ws-copy-"));
  dirs.push(d);
  return d;
}

function put(root: string, path: string, content: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** A workspace shaped like this repo's root: programs, plus everything that is not a computer's files. */
function repoLike(): string {
  const ws = folder();
  put(ws, "prog.lua", "print(1)");
  put(ws, "lib/a.lua", "return 1");
  put(ws, ".runtime/run-old/computer/0/junk.lua", "old run");
  put(ws, "node_modules/x/index.js", "");
  put(ws, ".git/HEAD", "ref");
  put(ws, ".claude/worktrees/w/prog.lua", "");
  put(ws, ".cache/big.jar", "");
  put(ws, "engine/build/craftos.exe", "");
  put(ws, "engine/src/main.cpp", "int main(){}");
  put(ws, ".gitignore", "dist/\n*.log\n/out\n!keep.log\n");
  put(ws, "dist/bundle.js", "");
  put(ws, "sub/dist/x.js", "");
  put(ws, "a.log", "");
  put(ws, "keep.log", "kept");
  put(ws, "out/o.txt", "");
  put(ws, "sub/out/o.txt", "nested out stays: /out is anchored");
  put(ws, "sub/.gitignore", "secret.lua\n");
  put(ws, "sub/secret.lua", "");
  put(ws, "secret.lua", "only sub/.gitignore names it");
  return ws;
}

function expectRepoLikeCopy(target: string): void {
  const has = (p: string): boolean => existsSync(join(target, p));
  expect(readFileSync(join(target, "prog.lua"), "utf8")).toBe("print(1)");
  expect(has("lib/a.lua")).toBe(true);
  for (const gone of [
    ".runtime",
    "node_modules",
    ".git",
    ".claude",
    ".cache",
    "engine/build",
    "dist",
    "sub/dist",
    "a.log",
    "out",
    "sub/secret.lua",
  ])
    expect(has(gone), gone).toBe(false);
  for (const kept of [
    "engine/src/main.cpp",
    "keep.log",
    "sub/out/o.txt",
    "secret.lua",
    ".gitignore",
  ])
    expect(has(kept), kept).toBe(true);
}

describe("copyWorkspace", () => {
  it("skips .runtime, node_modules, .git, .claude, .cache, engine/build and what .gitignore ignores", () => {
    const ws = repoLike();
    const target = join(folder(), "computer");
    copyWorkspace(ws, target);
    expectRepoLikeCopy(target);
  });

  it("the async copy skips the same", async () => {
    const ws = repoLike();
    const target = join(folder(), "computer");
    await copyWorkspaceAsync(ws, target);
    expectRepoLikeCopy(target);
  });

  it("a deploy entry (gitignore off) copies an ignored folder it names", () => {
    const ws = repoLike();
    const target = join(folder(), "computer");
    copyWorkspace(join(ws, "dist"), target, { gitignore: false });
    expect(existsSync(join(target, "bundle.js"))).toBe(true);
  });

  it("skips the runtime folder inside the workspace when the copy's target is in it", () => {
    // the CLI run from a clone's root: the workspace holds .runtime, and the computer is inside it
    const ws = folder();
    put(ws, "prog.lua", "print(1)");
    put(ws, "scratch/run-old/junk.lua", "old run");
    const target = join(ws, "scratch", "run-new", "computer", "0");
    copyWorkspace(ws, target, { exclude: [join(ws, "scratch")] });
    expect(existsSync(join(target, "prog.lua"))).toBe(true);
    expect(existsSync(join(target, "scratch"))).toBe(false);
  });

  it("never copies into itself even without an exclude list", () => {
    const ws = folder();
    put(ws, "prog.lua", "x");
    const target = join(ws, "inner", "computer");
    copyWorkspace(ws, target);
    expect(existsSync(join(target, "prog.lua"))).toBe(true);
    expect(existsSync(join(target, "inner", "computer"))).toBe(false);
  });

  it.runIf(process.platform === "win32")(
    "sees through a drive letter in the other case (the hang: cwd C:\\ against import.meta.url c:\\)",
    () => {
      const ws = folder();
      put(ws, "prog.lua", "x");
      const flip = (p: string): string =>
        p[0] === p[0]!.toUpperCase()
          ? p[0]!.toLowerCase() + p.slice(1)
          : p[0]!.toUpperCase() + p.slice(1);
      const target = join(flip(ws), "scratch", "run-x", "computer", "0");
      copyWorkspace(ws, target, { exclude: [join(flip(ws), "scratch")] });
      expect(existsSync(join(target, "prog.lua"))).toBe(true);
      expect(existsSync(join(target, "scratch"))).toBe(false);
    },
  );

  it("stops with an error that names the folder and world.deploy, past the byte or file limit", async () => {
    const ws = folder();
    put(ws, "a.bin", "x".repeat(600));
    put(ws, "b.bin", "x".repeat(600));
    const target = join(folder(), "c");
    expect(() => copyWorkspace(ws, target, { maxBytes: 1000 })).toThrow(
      WorkspaceError,
    );
    expect(() => copyWorkspace(ws, target, { maxFiles: 1 })).toThrow(/deploy/);
    await expect(
      copyWorkspaceAsync(ws, target, { maxBytes: 1000 }),
    ).rejects.toThrow(ws);
    expect(existsSync(target)).toBe(false);
  });

  it("the async copy stops on its signal and removes what it copied", async () => {
    const ws = folder();
    for (let i = 0; i < 50; i++) put(ws, `f${i}.lua`, "x");
    const target = join(folder(), "c");
    const stop = new AbortController();
    stop.abort();
    await expect(
      copyWorkspaceAsync(ws, target, { signal: stop.signal }),
    ).rejects.toThrow();
    expect(existsSync(target)).toBe(false);
  });

  it("copies a single file (a world deploy entry)", () => {
    const ws = folder();
    put(ws, "one.lua", "1");
    const target = join(folder(), "deep", "startup.lua");
    copyWorkspace(join(ws, "one.lua"), target);
    expect(readFileSync(target, "utf8")).toBe("1");
  });
});

/** A runner config on a scratch workspace: enough for staging, which never starts an engine. */
function scratchConfig(ws: string): RunnerConfig {
  const runtimeDir = folder();
  return {
    engineExe: "missing-engine",
    romDir: runtimeDir,
    workspaceDir: ws,
    worldsDir: runtimeDir,
    runtimeDir,
    luaLibDir: runtimeDir,
  };
}

function manyFiles(count: number): string {
  const ws = folder();
  for (let i = 0; i < count; i++)
    put(ws, `d${i % 20}/f${i}.lua`, "print('x')\n".repeat(20));
  return ws;
}

// each test writes and copies thousands of files: on a busy disk that alone outlasts vitest's 5 s default
describe(
  "a run whose workspace copy outlasts its timeout",
  { timeout: 60000 },
  () => {
    it("comes back as a structured timed_out result, with nothing left behind", async () => {
      const config = scratchConfig(manyFiles(3000));
      const result = await runProgram(config, {
        program: "d0/f0.lua",
        timeoutMs: 1,
      });
      expect(result.status).toBe("timed_out");
      expect(result.exitCode).toBeNull();
      expect(result.messages[0]?.message).toMatch(/deploy/);
      expect(readdirSync(config.runtimeDir)).toEqual([]);
    });

    it("a test file too", async () => {
      const config = scratchConfig(manyFiles(3000));
      const result = await runTests(config, {
        paths: ["d0/f0.lua"],
        timeoutMs: 1,
      });
      expect(result.files[0]?.status).toBe("timed_out");
      expect(result.failed).toBe(1);
      expect(readdirSync(config.runtimeDir)).toEqual([]);
    });

    it("a cancelled request stops the copy and says so", async () => {
      const config = scratchConfig(manyFiles(500));
      const stop = new AbortController();
      stop.abort();
      const result = await runProgram(config, {
        program: "d0/f0.lua",
        signal: stop.signal,
      });
      expect(result.status).toBe("timed_out");
      expect(result.messages[0]?.title).toBe("cancelled");
      expect(readdirSync(config.runtimeDir)).toEqual([]);
    });

    it("staging leaves the event loop free (other clients of the server get answers)", async () => {
      const config = scratchConfig(manyFiles(3000));
      let last = Date.now();
      let worst = 0;
      const tick = setInterval(() => {
        const now = Date.now();
        worst = Math.max(worst, now - last);
        last = now;
      }, 5);
      try {
        const staged = await stageEngine(config, {});
        expect(
          existsSync(join(staged.dir, "computer", "0", "d0", "f0.lua")),
        ).toBe(true);
        expect(existsSync(join(staged.dir, RUN_OWNER_FILE))).toBe(true);
      } finally {
        clearInterval(tick);
      }
      expect(worst).toBeLessThan(250);
    });
  },
);

describe("cleanStaleRuntime", () => {
  it("removes folders of dead processes and old ones from before owner files, never a live one's", async () => {
    const config = scratchConfig(folder());
    const make = (name: string, owner?: number, ageHours = 0): string => {
      const dir = join(config.runtimeDir, name);
      mkdirSync(join(dir, "computer"), { recursive: true });
      if (owner !== undefined)
        writeFileSync(
          join(dir, RUN_OWNER_FILE),
          JSON.stringify({ pid: owner }),
        );
      const when = new Date(Date.now() - ageHours * 3_600_000);
      utimesSync(dir, when, when);
      return dir;
    };
    // a process that has certainly exited
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
    make("run-dead01", dead);
    make("session-live01", process.pid, 1000);
    make("test-oldold", undefined, 48);
    make("run-newnew", undefined, 1);
    make("session-oldold", undefined, 48);
    make("session-older1", undefined, 24 * 8);
    make("arcade-scn-ws", undefined, 24 * 30); // not the runner's: left alone
    const removed = await cleanStaleRuntime(config);
    expect(removed.sort()).toEqual(
      ["run-dead01", "session-older1", "test-oldold"].sort(),
    );
    expect(readdirSync(config.runtimeDir).sort()).toEqual(
      [
        "arcade-scn-ws",
        "run-newnew",
        "session-live01",
        "session-oldold",
      ].sort(),
    );
  });
});

describe("measureWorkspace", () => {
  it("counts what a copy would hold and names the heavy folders it skips", async () => {
    const size = await measureWorkspace(repoLike());
    expect(size.tooBig).toBe(false);
    expect(size.skippedHeavy).toEqual(
      expect.arrayContaining([".runtime", "node_modules", ".git"]),
    );
    // prog, lib/a, engine/src/main.cpp, .gitignore, keep.log, sub/out/o.txt, sub/.gitignore, secret.lua
    expect(size.files).toBe(8);
  });

  it("says tooBig past the limits", async () => {
    const ws = folder();
    put(ws, "a", "1");
    put(ws, "b", "2");
    expect((await measureWorkspace(ws, { maxFiles: 1 })).tooBig).toBe(true);
  });
});

describe(".gitignore rules", () => {
  const rules = parseGitignore(
    "# comment\n\n*.tmp\nbuild/\n/root-only\ndocs/**/*.md\n!docs/keep.md\na?c\n[xy].lua\n",
  );
  const cases: [string, boolean, boolean][] = [
    ["x.tmp", false, true],
    ["deep/x.tmp", false, true],
    ["build", true, true],
    ["build", false, false], // dir-only pattern, a file named build
    ["src/build", true, true],
    ["root-only", false, true],
    ["src/root-only", false, false],
    ["docs/a/b/c.md", false, true],
    ["docs/c.md", false, true],
    ["docs/keep.md", false, false],
    ["abc", false, true],
    ["abbc", false, false],
    ["x.lua", false, true],
    ["z.lua", false, false],
  ];
  for (const [path, isDir, ignored] of cases)
    it(`${path}${isDir ? "/" : ""} ${ignored ? "is" : "is not"} ignored`, () =>
      expect(ignoredBy(rules, path, isDir)).toBe(ignored));
});
