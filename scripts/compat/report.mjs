#!/usr/bin/env node
// Write the results table of docs/compatibility.md from the last runs of scripts/compat/run.mjs.
//
//   node scripts/compat/run.mjs                                            (CC:Tweaked 1.121.0)
//   node scripts/compat/run.mjs --mc 1.18.2 --out .cache/compat/out-1.18.2  (CC:Tweaked 1.101.3)
//   node scripts/compat/report.mjs
//
// The table sits between the two marker comments in the page and is replaced whole; the text around it is written
// by hand. What a row says besides the result comes from notes.mjs: `does` (what the check does), `note` (a caveat
// on a project that works), `why` (for one that does not) and `fixed` (what running it changed in the emulator).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO } from "./lib.mjs";
import { notes } from "./notes.mjs";
import { projects } from "./projects.mjs";

const meta = (project) => notes[project.id] ?? {};

const cache = resolve(REPO, ".cache", "compat");
const page = resolve(REPO, "docs", "compatibility.md");
const read = (dir) => {
  const file = join(cache, dir, "results.json");
  if (!existsSync(file)) return new Map();
  return new Map(JSON.parse(readFileSync(file, "utf8")).map((r) => [r.id, r]));
};
const newer = read("out");
const older = read("out-1.18.2");
if (newer.size === 0) {
  console.error("no results: run node scripts/compat/run.mjs first");
  process.exit(2);
}

const CATEGORY = {
  library: "Library",
  program: "Program",
  os: "Operating system",
};
const cell = (text) => String(text).replace(/\|/g, "\\|").replace(/\n/g, " ");

/** "works", "works with notes: ..." or "broken: ...", as the page's legend explains them. */
function verdict(project, result) {
  if (!result) return "not run";
  if (!result.ok)
    return `broken: ${meta(project).why ?? result.error.split("\n")[0]}`;
  return meta(project).note
    ? `works with notes: ${meta(project).note}`
    : "works";
}

/** The older version's result, short: it only says more when it differs. */
function olderVerdict(project, result) {
  if (!result) return "not run";
  if (result.ok) return "works";
  if (result.expected === "broken")
    return `needs CC:Tweaked ${project.minCC} or newer`;
  return `broken: ${result.error.split("\n")[0]}`;
}

const rows = [
  "| Project | Category | Tested | CC:Tweaked 1.121.0 | CC:Tweaked 1.101.3 | What the check does | What it fixed here |",
  "| --- | --- | --- | --- | --- | --- | --- |",
];
for (const project of projects) {
  const result = newer.get(project.id);
  const tested = result?.versions?.length
    ? result.versions.join(", ")
    : "what its installer fetched";
  rows.push(
    "| " +
      [
        `[${project.name}](${project.url})`,
        `${CATEGORY[project.category]}: ${project.section}`,
        tested,
        verdict(project, result),
        olderVerdict(project, older.get(project.id)),
        meta(project).does ?? "",
        meta(project).fixed ?? "",
      ]
        .map(cell)
        .join(" | ") +
      " |",
  );
}

const START = "<!-- compat-results:start -->";
const END = "<!-- compat-results:end -->";
const text = readFileSync(page, "utf8");
const from = text.indexOf(START);
const to = text.indexOf(END);
if (from < 0 || to < from) {
  console.error(`${page}: the ${START} and ${END} markers are missing`);
  process.exit(2);
}
const counts = { works: 0, notes: 0, broken: 0 };
for (const project of projects) {
  const result = newer.get(project.id);
  if (!result) continue;
  if (!result.ok) counts.broken++;
  else if (meta(project).note) counts.notes++;
  else counts.works++;
}
const summary =
  `${newer.size} projects on CC:Tweaked 1.121.0: ${counts.works} work, ${counts.notes} work with notes, ` +
  `${counts.broken} broken.`;
writeFileSync(
  page,
  text.slice(0, from + START.length) +
    "\n\n" +
    summary +
    "\n\n" +
    rows.join("\n") +
    "\n\n" +
    text.slice(to),
);
console.log(summary);
