// craftos.json under the settings (src/project.ts), and the agent viewer's address and page (src/viewerPage.ts).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  explicitValue,
  findProjectFile,
  projectSettings,
} from "../../src/project.ts";
import { readViewerLine, viewerHtml } from "../../src/viewerPage.ts";

const scratch = mkdtempSync(join(tmpdir(), "vscode-project-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

test("craftos.json is found upwards, not past a .git", () => {
  const root = join(scratch, "repo");
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  writeFileSync(
    join(root, "craftos.json"),
    JSON.stringify({
      workspace: "src",
      minecraft: "1.20.1",
      addons: ["create", "mekanism"],
    }),
  );
  assert.equal(
    findProjectFile(join(root, "src", "deep")),
    join(root, "craftos.json"),
  );
  assert.deepEqual(projectSettings(join(root, "src")), {
    file: join(root, "craftos.json"),
    workspace: join(root, "src"),
    minecraft: "1.20.1",
    addons: "create,mekanism",
  });
  mkdirSync(join(root, "inner", ".git"), { recursive: true });
  assert.equal(findProjectFile(join(root, "inner")), undefined);
});

test("a broken or odd craftos.json gives what it can, and nothing for the rest", () => {
  const dir = join(scratch, "broken");
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, "craftos.json"), "{ nope");
  assert.equal(projectSettings(dir), undefined);
  writeFileSync(
    join(dir, "craftos.json"),
    JSON.stringify({ minecraft: 5, addons: [] }),
  );
  assert.deepEqual(projectSettings(dir), {
    file: join(dir, "craftos.json"),
    addons: "none",
  });
});

test("a setting someone set wins; blank counts as unset", () => {
  assert.equal(explicitValue(undefined), undefined);
  assert.equal(explicitValue({ globalValue: "1.18.2" }), "1.18.2");
  assert.equal(
    explicitValue({ globalValue: "1.18.2", workspaceValue: "1.20.1" }),
    "1.20.1",
  );
  assert.equal(
    explicitValue({ workspaceValue: "1.20.1", workspaceFolderValue: "1.21.1" }),
    "1.21.1",
  );
  assert.equal(explicitValue({ workspaceValue: "  " }), undefined);
});

test("the viewer's line on the server's stderr", () => {
  assert.equal(
    readViewerLine("craftos viewer: http://127.0.0.1:7878/"),
    "http://127.0.0.1:7878/",
  );
  assert.equal(
    readViewerLine("craftos viewer: http://127.0.0.1:53211/\r"),
    "http://127.0.0.1:53211/",
  );
  assert.equal(
    readViewerLine("craftos app: port 7878 is taken, using a free one"),
    undefined,
  );
  // only loopback: a line that names another host is not followed
  assert.equal(
    readViewerLine("craftos viewer: http://example.com:7878/"),
    undefined,
  );
});

test("the panel frames the viewer and lets nothing else in", () => {
  const html = viewerHtml("http://127.0.0.1:7878/", "vscode-webview://abc");
  assert.match(html, /<iframe src="http:\/\/127\.0\.0\.1:7878\/"/);
  assert.match(
    html,
    /default-src 'none'; frame-src http:\/\/127\.0\.0\.1:7878;/,
  );
  assert.doesNotMatch(html, /<script/);
});
