// `craftos-mcp import craftos-pc`, against a small made-up CraftOS-PC folder.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import importCommand from "./commands/import.js";

const root = mkdtempSync(join(tmpdir(), "cli-import-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const put = (file: string, text: string): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const source = join(root, "CraftOS-PC");
put(join(source, "config", "global.json"), "{}");
put(
  join(source, "config", "1.json"),
  JSON.stringify({
    base64: true,
    label: Buffer.from("Gate").toString("base64"),
  }),
);
put(join(source, "computer", "0", "hello.lua"), 'print("hi")');
put(
  join(source, "computer", "1", "startup.lua"),
  'periphemu.create("top", "monitor")',
);

async function call(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi
    .spyOn(console, "log")
    .mockImplementation((...a) => void out.push(a.join(" ")));
  const error = vi
    .spyOn(console, "error")
    .mockImplementation((...a) => void err.push(a.join(" ")));
  try {
    const code = await importCommand.run(args);
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

describe("craftos-mcp import craftos-pc", () => {
  it("--list shows what would come over and writes nothing", async () => {
    const r = await call(
      "craftos-pc",
      source,
      "--list",
      "--out",
      join(root, "none"),
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("computer 0: 1 file");
    expect(r.out).toContain(
      'computer 1 "Gate": 1 file, attaches monitor on top',
    );
    expect(existsSync(join(root, "none"))).toBe(false);
  });

  it("writes the project and says what to do next", async () => {
    const out = join(root, "project");
    const r = await call("craftos-pc", source, "--out", out);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("Brought 2 computers over");
    expect(r.out).toContain("craftos-mcp window");
    expect(r.out).toContain(
      "note: computer 1 (Gate): its monitors are walls of 5x3 blocks",
    );
    expect(
      JSON.parse(readFileSync(join(out, "craftos.json"), "utf8")).workspace,
    ).toBe("computer/0");
    expect(
      JSON.parse(readFileSync(join(out, "computer-1.world.json"), "utf8")),
    ).toMatchObject({
      label: "Gate",
      monitors: [{ name: "top" }],
    });
    const again = await call("craftos-pc", source, "--out", out);
    expect(again.code).toBe(2);
    expect(again.err).toMatch(
      /is there already from an earlier import.*\(--force\)/,
    );
    expect(
      (await call("craftos-pc", source, "--out", out, "--force")).code,
    ).toBe(0);
  });

  it("--only picks computers", async () => {
    const out = join(root, "one");
    expect(
      (await call("craftos-pc", source, "--out", out, "--only", "1")).code,
    ).toBe(0);
    expect(existsSync(join(out, "computer", "1"))).toBe(true);
    expect(existsSync(join(out, "computer", "0"))).toBe(false);
    expect((await call("craftos-pc", source, "--only", "x")).code).toBe(2);
  });

  it("explains what it imports, and a folder that is not CraftOS-PC's", async () => {
    const what = await call("cc");
    expect(what.code).toBe(2);
    expect(what.err).toContain('craftos-mcp import knows craftos-pc, not "cc"');
    const none = await call(
      "craftos-pc",
      join(root, "empty"),
      "--out",
      join(root, "x"),
    );
    expect(none.code).toBe(2);
    expect(none.err).toContain("is not a CraftOS-PC data folder");
  });
});
