// Where a common error message is explained: the troubleshooting page of the guide (docs/guide/troubleshooting.md).

export const TROUBLESHOOTING_URL =
  "https://github.com/Akkiruk/craftos-mcp/blob/main/docs/guide/troubleshooting.md";

/** Message pattern to the page's heading anchor. The first match wins, so the narrower ones come first. */
const ENTRIES: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /^(engine not found|ROM (for Minecraft \S+ )?not found)/,
    "engine-or-rom-not-found",
  ],
  [/craftos\.json(:| is not valid JSON)/, "craftosjson-problems"],
  [/a monitor wall is at most/, "monitor-too-big"],
  [/is not a world field/, "not-a-world-field"],
  [
    /is not a peripheral the sim can build/,
    "not-a-peripheral-the-sim-can-build",
  ],
  [/which is switched off/, "addon-switched-off"],
  [/unknown addon "/, "unknown-addon"],
  [/has no release for Minecraft/, "no-release-for-this-minecraft-version"],
  [/unknown Minecraft version|unknown version "/, "unknown-minecraft-version"],
  [
    /^no world file |no world named |\.json: .*JSON/,
    "world-file-not-found-or-not-json",
  ],
  [/^no program "/, "no-program"],
  [/no \*\.test\.lua files/, "no-test-files"],
  [/^port \d+ is taken/, "port-is-taken"],
  [/could not reach |setup failed/, "setup-could-not-download"],
];

/** The guide's entry for an error message, as a link, or undefined when the page has none for it. */
export function troubleshootingLink(message: string): string | undefined {
  const hit = ENTRIES.find(([re]) => re.test(message));
  return hit && `${TROUBLESHOOTING_URL}#${hit[1]}`;
}
