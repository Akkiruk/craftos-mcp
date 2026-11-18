// Add Agent Instructions to Workspace: what it does to a file that is already there, and the files the build bundles
// from scripts/build-agent-docs.mjs.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { conflictChoices, planWrite } from "../../src/agentDocs.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(
  here,
  "..",
  "..",
  "..",
  "..",
  "scripts",
  "build-agent-docs.mjs",
);

const agents = { content: "# craftos-mcp\n\nRun it.\n", append: true };
const skill = {
  content: "---\nname: cc-tweaked-dev\n---\n\n# Loop\n",
  append: false,
};

test("a new file is written; one that already says it is left alone", () => {
  assert.deepEqual(planWrite(undefined, agents), {
    action: "create",
    text: agents.content,
  });
  assert.deepEqual(planWrite(agents.content, agents), { action: "same" });
  assert.deepEqual(planWrite(agents.content.replace(/\n/g, "\r\n"), agents), {
    action: "same",
  });
  // appended to the user's own AGENTS.md earlier
  assert.deepEqual(
    planWrite(`# Mine\n\nBe nice.\n\n${agents.content}`, agents),
    { action: "same" },
  );
});

test("a different file is only changed with an answer", () => {
  const mine = "# Mine\n\nBe nice.\n\n";
  assert.deepEqual(planWrite(mine, agents), { action: "ask" });
  assert.deepEqual(planWrite(mine, agents, "skip"), { action: "skip" });
  assert.deepEqual(planWrite(mine, agents, "append"), {
    action: "append",
    text: `# Mine\n\nBe nice.\n\n${agents.content}`,
  });
  assert.deepEqual(planWrite(mine, agents, "overwrite"), {
    action: "overwrite",
    text: agents.content,
  });
  assert.deepEqual(planWrite("", agents, "append"), {
    action: "append",
    text: agents.content,
  });
});

test("a file with its own frontmatter is never appended to", () => {
  assert.deepEqual(conflictChoices(agents), ["append", "overwrite", "skip"]);
  assert.deepEqual(conflictChoices(skill), ["overwrite", "skip"]);
  assert.deepEqual(planWrite("---\nname: other\n---\n", skill, "append"), {
    action: "skip",
  });
});

test(
  "the generated files are there, and their workspace copies lose the repo's own notes",
  { skip: !existsSync(SCRIPT) },
  async () => {
    const { TARGETS, defaultOutDir, forWorkspace, NOTE } = await import(
      pathToFileURL(SCRIPT).href
    );
    const dir = defaultOutDir();
    const ids = TARGETS.map((t) => t.id);
    assert.deepEqual(ids, [...new Set(ids)], "two targets with one id");
    for (const target of TARGETS) {
      const file = join(dir, target.path);
      assert.ok(
        existsSync(file),
        `${target.path} missing: run node scripts/build-agent-docs.mjs`,
      );
      const text = readFileSync(file, "utf8");
      assert.ok(text.includes(NOTE), `${target.path} has no generated-by note`);
      const mine = forWorkspace(text);
      assert.ok(!mine.includes(NOTE), target.path);
      assert.ok(
        !mine.includes("Working on craftos-mcp itself"),
        `${target.path} keeps the repo's own section`,
      );
      assert.ok(!mine.includes("repo-only"), target.path);
      assert.ok(
        mine.includes("craftos_test"),
        `${target.path} says nothing about testing`,
      );
      if (target.path.endsWith("SKILL.md"))
        assert.match(
          mine,
          /^---\nname: cc-tweaked-dev\ndescription: .+\n---\n/,
        );
      if (target.path.endsWith(".mdc"))
        assert.match(mine, /^---\ndescription: .+\nalwaysApply: false\n---\n/);
    }
  },
);
