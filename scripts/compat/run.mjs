#!/usr/bin/env node
// Community compatibility checks: fetch real CC:Tweaked projects and run each in the emulator as a player would.
//
//   node scripts/compat/run.mjs                 every project in projects.mjs
//   node scripts/compat/run.mjs basalt opus     only these
//   node scripts/compat/run.mjs --list          the ids, categories and links
//   node scripts/compat/run.mjs --category os   one category (library, program, os)
//   node scripts/compat/run.mjs --jobs 4        how many computers at once (default 4)
//   node scripts/compat/run.mjs --mc 1.18.2     the Minecraft version: 1.21.1 (CC:Tweaked 1.121.0, the default here),
//                                               1.20.1, or 1.18.2 (CC:Tweaked 1.101.3)
//   node scripts/compat/run.mjs --out <dir>     where screenshots and results.json go (default .cache/compat/out)
//   node scripts/compat/run.mjs --child <id>    (internal) one project, result as JSON on the last line
//
// Needs the built runner (npm run build), the engine and the ROM, and the internet: nothing is vendored. Downloads
// and scratch computers live under .cache/compat. Exit code 1 when a project's result differs from the one
// projects.mjs expects, so this can gate a release.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO, runProject } from "./lib.mjs";
import { projects } from "./projects.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
};
const has = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};

const cacheDir = resolve(REPO, ".cache", "compat");
const outDir = resolve(flag("--out") ?? join(cacheDir, "out"));
const jobs = Number(flag("--jobs") ?? 4);
const category = flag("--category");
const mc = flag("--mc") ?? "1.21.1";
const child = flag("--child");
const list = has("--list");

if (child) {
  const project = projects.find((p) => p.id === child);
  if (!project) {
    console.error(`no project "${child}"`);
    process.exit(2);
  }
  const result = await runProject(project, {
    cacheDir,
    shotsDir: outDir,
    mc,
  });
  // `minCC`: the project needs a newer CC:Tweaked than this Minecraft version has, so it is expected not to run
  const cc = mc === "1.18.2" ? [1, 101, 3] : [1, 121, 0];
  const need = (project.minCC ?? "0.0.0").split(".").map(Number);
  const tooOld =
    need[0] > cc[0] ||
    (need[0] === cc[0] &&
      (need[1] > cc[1] || (need[1] === cc[1] && need[2] > cc[2])));
  if (tooOld) result.expected = "broken";
  console.log("\n@@RESULT@@" + JSON.stringify(result));
  process.exit(0);
}

if (list) {
  for (const p of projects)
    console.log(`${p.id.padEnd(22)} ${p.category.padEnd(9)} ${p.url}`);
  process.exit(0);
}

const unknown = args.filter((a) => !projects.some((p) => p.id === a));
if (unknown.length) {
  console.error(`unknown project or option: ${unknown.join(", ")}`);
  process.exit(2);
}
const chosen = projects.filter(
  (p) =>
    (args.length === 0 || args.includes(p.id)) &&
    (!category || p.category === category),
);
mkdirSync(outDir, { recursive: true });

/** Each project runs in a process of its own: a hang or a crash in one cannot take the others with it. */
function runChild(project) {
  return new Promise((done) => {
    const proc = spawn(
      process.execPath,
      [
        fileURLToPath(import.meta.url),
        "--child",
        project.id,
        "--out",
        outDir,
        "--mc",
        mc,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    const limit = setTimeout(
      () => proc.kill(),
      (project.timeoutS ?? 300) * 1000,
    );
    proc.on("exit", () => {
      clearTimeout(limit);
      const at = out.lastIndexOf("@@RESULT@@");
      if (at >= 0) return done(JSON.parse(out.slice(at + 10)));
      done({
        id: project.id,
        ok: false,
        crashed: true,
        expected: project.expect ?? "works",
        error: `the check itself died: ${err.trim().slice(-600) || "no output (timed out?)"}`,
        versions: [],
        notes: [],
        shots: [],
        ms: 0,
      });
    });
  });
}

const results = [];
const queue = [...chosen];
await Promise.all(
  Array.from(
    { length: Math.max(1, Math.min(jobs, queue.length)) },
    async () => {
      for (;;) {
        const project = queue.shift();
        if (!project) return;
        const r = await runChild(project);
        results.push(r);
        const verdict = r.ok ? "ok    " : "FAILED";
        console.log(
          `${verdict} ${r.id.padEnd(22)} ${(r.ms / 1000).toFixed(0).padStart(4)}s  ${r.versions.join(", ")}`,
        );
        if (!r.ok)
          console.log("       " + r.error.split("\n").join("\n       "));
        for (const n of r.notes) console.log("       note: " + n);
      }
    },
  ),
);

results.sort(
  (a, b) =>
    chosen.findIndex((p) => p.id === a.id) -
    chosen.findIndex((p) => p.id === b.id),
);
// results.json holds the last result of every project run into this folder: a run of a few replaces only theirs,
// so report.mjs has the whole table after one project is run again
const resultsFile = join(outDir, "results.json");
const kept = new Map();
if (existsSync(resultsFile)) {
  try {
    for (const r of JSON.parse(readFileSync(resultsFile, "utf8")))
      kept.set(r.id, r);
  } catch {
    // an unreadable file is replaced
  }
}
for (const r of results)
  kept.set(r.id, { ...r, ranAt: new Date().toISOString() });
writeFileSync(
  resultsFile,
  JSON.stringify(projects.map((p) => kept.get(p.id)).filter(Boolean), null, 2) +
    "\n",
);

// A project marked `expect: "broken"` is known not to work (docs/compatibility.md says why): its failing is no news,
// its passing is.
const surprises = results.filter((r) => r.ok !== (r.expected !== "broken"));
const passed = results.filter((r) => r.ok).length;
console.log(
  `\n${passed} of ${results.length} ran clean. Screenshots and results.json: ${outDir}`,
);
if (surprises.length) {
  console.log(
    "Not as expected: " +
      surprises
        .map((r) => `${r.id} (${r.ok ? "works now" : "failed"})`)
        .join(", "),
  );
  process.exit(1);
}
