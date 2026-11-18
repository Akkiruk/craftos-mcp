import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TROUBLESHOOTING_URL, troubleshootingLink } from "./troubleshoot.js";

const page = readFileSync(
  join(import.meta.dirname, "../../../docs/guide/troubleshooting.md"),
  "utf8",
);
/** GitHub's anchor for a heading: lower case, punctuation gone, spaces to dashes. */
const anchors = new Set(
  [...page.matchAll(/^#{2,4} (.+)$/gm)].map((m) =>
    m[1]!
      .trim()
      .toLowerCase()
      .replace(/[^\w\- ]/g, "")
      .replace(/ /g, "-"),
  ),
);

// messages as the command line prints them (copied from real runs)
const MESSAGES: Array<[string, string]> = [
  [
    '--world off.world.json: peripheral "left" is a playerDetector from Advanced Peripherals (addon "advanced-peripherals"), which is switched off. Enabled addons: create.',
    "addon-switched-off",
  ],
  [
    '--world type.world.json: world.peripherals[0].type "playerDetecter" is not a peripheral the sim can build. Did you mean "playerDetector"?',
    "not-a-peripheral-the-sim-can-build",
  ],
  [
    '--world t.json: world.monitor is not a world field. Did you mean "monitors"?',
    "not-a-world-field",
  ],
  ['the world: unknown addon "mekanizm"; known: create', "unknown-addon"],
  [
    '--world norel.world.json: Bigger Reactors (addon "bigger-reactors") has no release for Minecraft 1.21.1; it has 1.18.2',
    "no-release-for-this-minecraft-version",
  ],
  [
    '--mc: unknown Minecraft version "1.16.5"; known: 1.18.2',
    "unknown-minecraft-version",
  ],
  [
    'C:\\p\\craftos.json: minecraft: unknown version "1.16.5"; known: 1.18.2, 1.20.1, 1.21.1',
    "craftosjson-problems",
  ],
  [
    "C:\\p\\broken.world.json: Unexpected end of JSON input",
    "world-file-not-found-or-not-json",
  ],
  [
    "no world file nofile.world.json (looked in C:\\p)",
    "world-file-not-found-or-not-json",
  ],
  [
    '--monitor top:9x9: monitor "top" is 9x9 blocks; a monitor wall is at most 8x6 blocks (wide x high)',
    "monitor-too-big",
  ],
  ['no program "missing.lua" in the workspace C:\\p.', "no-program"],
  ["no *.test.lua files found under C:\\p", "no-test-files"],
  [
    "port 7921 is taken (the MCP server's viewer uses 7878): try --port 0 for a free one",
    "port-is-taken",
  ],
  [
    "engine not found at C:\\p\\craftos.exe (run npm run setup)",
    "engine-or-rom-not-found",
  ],
];

describe("links from error messages to the troubleshooting page", () => {
  it.each(MESSAGES)("%s", (message, anchor) => {
    expect(troubleshootingLink(message)).toBe(
      `${TROUBLESHOOTING_URL}#${anchor}`,
    );
  });

  it("points only at headings the page has", () => {
    for (const [, anchor] of MESSAGES)
      expect(anchors, anchor).toContain(anchor);
    expect(anchors).toContain("setup-could-not-download");
  });

  it("has nothing for a message the page does not cover", () => {
    expect(troubleshootingLink("something else went wrong")).toBeUndefined();
  });
});
