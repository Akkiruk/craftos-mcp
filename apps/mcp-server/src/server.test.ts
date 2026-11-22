// The MCP server as a client sees it, over stdio: what it costs in context, its instructions, resources and prompts,
// and the checks that turn a bad call into a clear error before a computer boots.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkConfig, loadConfig } from "@craftos-mcp/runner";

const SERVER = join(import.meta.dirname, "..", "dist", "index.js");
const scratch = mkdtempSync(join(tmpdir(), "mcp-ws-"));
const ready = checkConfig(loadConfig()).length === 0;

function put(name: string, content: string): void {
  const file = join(scratch, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

async function connect(env: Record<string, string> = {}): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: {
      ...(process.env as Record<string, string>),
      CRAFTOS_VIEWER_PORT: "off",
      CRAFTOS_WORKSPACE: scratch,
      ...env,
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport);
  return client;
}

type Result = {
  isError?: boolean;
  content: { type: string; text?: string }[];
};
const textOf = (r: unknown): string =>
  (r as Result).content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");

let client: Client;
beforeAll(async () => {
  client = await connect();
}, 30000);
afterAll(async () => {
  await client?.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe("what a client gets", () => {
  it("a tool list that does not repeat the world schema", async () => {
    const { tools } = await client.listTools();
    const size = JSON.stringify(tools).length;
    // 0.2.0 sent about 64k characters (85k with the private tools), most of it the world schema four times.
    // 50k leaves room for parameter descriptions (47k with them, private tools included)
    expect(size).toBeLessThan(50_000);
    for (const t of tools) expect(JSON.stringify(t).length).toBeLessThan(6_000);
    // none of the SDK's filler: $schema lines, ±2^53 integer bounds, the default taskSupport
    const raw = JSON.stringify(tools);
    expect(raw).not.toContain("$schema");
    expect(raw).not.toContain(String(Number.MAX_SAFE_INTEGER));
    expect(raw).not.toContain('"taskSupport":"forbidden"');
    const run = tools.find((t) => t.name === "craftos_run")!;
    expect(JSON.stringify(run.inputSchema)).toContain("craftos_help");
    // every tool that takes a world says what world.deploy is for
    const takesWorld = tools.filter((t) =>
      JSON.stringify(t.inputSchema).includes('"world":{'),
    );
    expect(takesWorld.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "craftos_run",
        "craftos_test",
        "craftos_session_create",
        "craftos_network_create",
      ]),
    );
    for (const t of takesWorld)
      expect(JSON.stringify(t), t.name).toMatch(/world\.deploy/);
    // annotations let a client skip asking before tools that only look
    expect(run.annotations).toMatchObject({ destructiveHint: false });
    expect(
      tools.find((t) => t.name === "craftos_info")!.annotations,
    ).toMatchObject({ readOnlyHint: true });
    expect(
      tools.find((t) => t.name === "craftos_write_file")!.annotations,
    ).toMatchObject({ destructiveHint: true });
  });

  it("instructions that say how to work", () => {
    const text = client.getInstructions() ?? "";
    expect(text).toMatch(/craftos_run/);
    expect(text).toMatch(/craftos_test/);
    expect(text).toMatch(/deploy/);
    expect(text).toMatch(/emulator extra/);
    expect(text.length).toBeLessThan(2_500);
  });

  it("the full world schema on request, as a tool and as a resource", async () => {
    const help = JSON.parse(
      textOf(
        await client.callTool({
          name: "craftos_help",
          arguments: { topic: "world" },
        }),
      ),
    ) as { properties: Record<string, unknown> };
    expect(Object.keys(help.properties)).toContain("peripherals");
    const res = await client.readResource({ uri: "craftos://schema/world" });
    expect(
      JSON.parse(String((res.contents[0] as { text: string }).text)),
    ).toEqual(help);
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain("craftos://guide");
    expect(uris.some((u) => u.startsWith("craftos://worlds/"))).toBe(true);
    expect(uris.some((u) => u.startsWith("craftos://docs/"))).toBe(true);
    expect(uris.some((u) => u.startsWith("craftos://examples/"))).toBe(true);
    const guide = await client.readResource({ uri: "craftos://guide" });
    expect(String((guide.contents[0] as { text: string }).text)).toMatch(
      /ccunit\.run/,
    );
  });

  it("prompts for the usual jobs", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual([
      "add-tests",
      "debug-ui",
      "new-program",
    ]);
    const p = await client.getPrompt({
      name: "new-program",
      arguments: { what: "a door", file: "door.lua" },
    });
    expect(JSON.stringify(p.messages)).toMatch(/door\.test\.lua/);
  });

  it("CRAFTOS_TOOLS=core: a lean list", async () => {
    const core = await connect({ CRAFTOS_TOOLS: "core" });
    try {
      const names = (await core.listTools()).tools.map((t) => t.name);
      expect(names).toContain("craftos_run");
      expect(names).toContain("craftos_help");
      expect(names).not.toContain("craftos_type");
      expect(names).not.toContain("craftos_wait_for_text");
      expect(names.length).toBeLessThanOrEqual(18);
    } finally {
      await core.close();
    }
  }, 30000);
});

describe("bad calls fail before a computer boots", () => {
  it("a misspelt world key or peripheral type, with suggestions", async () => {
    put("noop.lua", "");
    const r = (await client.callTool({
      name: "craftos_run",
      arguments: {
        program: "noop.lua",
        world: {
          peripheralz: [],
          peripherals: [{ name: "c", type: "minecraft:chets" }],
        },
      },
    })) as Result;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Did you mean "peripherals"/);
    expect(textOf(r)).toMatch(/Did you mean "minecraft:chest"/);
  });

  it("a wrongly typed field, with its path", async () => {
    const r = (await client.callTool({
      name: "craftos_run",
      arguments: {
        program: "noop.lua",
        world: {
          peripherals: [{ name: "c", type: "minecraft:chest", size: "big" }],
        },
      },
    })) as Result;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/world\.peripherals\[0\]\.size/);
  });

  it("a missing program, with the nearest one", async () => {
    put("hello.lua", 'print("hi")');
    const r = (await client.callTool({
      name: "craftos_run",
      arguments: { program: "helo.lua" },
    })) as Result;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Did you mean "hello.lua"/);
  });

  it("an unknown saved world, listing the ones there are", async () => {
    const r = (await client.callTool({
      name: "craftos_run",
      arguments: { program: "hello.lua", worldFile: "nope" },
    })) as Result;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Saved worlds: .*advanced-peripherals-demo/);
  });

  it("a missing test file, and an unknown session", async () => {
    const t = (await client.callTool({
      name: "craftos_test",
      arguments: { paths: ["nothere.test.lua"] },
    })) as Result;
    expect(t.isError).toBe(true);
    expect(textOf(t)).toMatch(/no file "nothere.test.lua"/);
    const s = (await client.callTool({
      name: "craftos_ui",
      arguments: { id: "gone" },
    })) as Result;
    expect(textOf(s)).toMatch(/No session is running.*server restarts/);
  });

  it("a wrong key name, with the right one", async () => {
    const r = (await client.callTool({
      name: "craftos_key",
      arguments: { id: "gone", key: "Enter" },
    })) as Result;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Did you mean "enter"/);
  });
});

describe("craftos_info", () => {
  it("lists the addons as id: version, on and off", async () => {
    const info = JSON.parse(
      textOf(await client.callTool({ name: "craftos_info", arguments: {} })),
    ) as {
      addons: { on: Record<string, string>; off: Record<string, string> };
    };
    expect(Object.keys(info.addons.on)).toContain("advanced-peripherals");
    expect(typeof info.addons.on["advanced-peripherals"]).toBe("string");
    expect(info.addons.off).toBeTypeOf("object");
    expect(JSON.stringify(info).length).toBeLessThan(3_000);
  });
});

describe.skipIf(!ready)("results", () => {
  it("a failed run carries error {file, line}, and screens stop at the last line", async () => {
    put("boom.lua", 'print("about to")\nerror("boom")\n');
    const r = await client.callTool({
      name: "craftos_run",
      arguments: { program: "boom.lua" },
    });
    const result = JSON.parse(textOf(r)) as {
      status: string;
      error: unknown;
      screens: { lines: string[]; height: number }[];
    };
    expect(result.status).toBe("program_failed");
    expect(result.error).toEqual({
      kind: "runtime",
      message: "boom",
      file: "boom.lua",
      line: 2,
    });
    const term = result.screens[0]!;
    expect(term.lines.length).toBeLessThan(term.height);
    expect(term.lines.at(-1)).not.toBe("");
    expect(term.lines[1]).toBe("about to"); // no motd under the banner
    const full = JSON.parse(
      textOf(
        await client.callTool({
          name: "craftos_run",
          arguments: { program: "boom.lua", fullScreens: true },
        }),
      ),
    ) as { screens: { lines: string[]; height: number }[] };
    expect(full.screens[0]!.lines).toHaveLength(full.screens[0]!.height);
  }, 60000);

  it("a world file from the workspace, with a warning for a stray key", async () => {
    put(
      "box.world.json",
      JSON.stringify({
        peripherals: [{ name: "chest_0", type: "minecraft:chest" }],
        extraStuff: 1,
      }),
    );
    put("box.lua", 'print(peripheral.getType("chest_0"))');
    const r = JSON.parse(
      textOf(
        await client.callTool({
          name: "craftos_run",
          arguments: { program: "box.lua", worldFile: "box.world.json" },
        }),
      ),
    ) as { status: string; warnings: string[]; sim: Record<string, unknown> };
    expect(r.status).toBe("completed");
    expect(r.warnings[0]).toMatch(/world\.extraStuff/);
    expect(r.sim).not.toHaveProperty("survives");
  }, 60000);

  it("craftos_test: failing tests in full, passing ones by count and name", async () => {
    put(
      "mix.test.lua",
      [
        'ccunit.test("adds", function() ccunit.eq(1 + 1, 2) end)',
        'ccunit.test("wrong", function() ccunit.eq(1 + 1, 3) end)',
        'ccunit.skip("later")',
      ].join("\n"),
    );
    const r = (await client.callTool({
      name: "craftos_test",
      arguments: { paths: ["mix.test.lua"] },
    })) as Result;
    expect(r.isError).toBe(true);
    const result = JSON.parse(textOf(r)) as {
      passed: number;
      failed: number;
      files: Record<string, unknown>[];
    };
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    const file = result.files[0]!;
    expect(file).toMatchObject({
      file: "mix.test.lua",
      status: "failed",
      passed: 1,
      passedTests: ["adds"],
      failed: [{ name: "wrong", line: 2 }],
    });
    expect(String((file["failed"] as { error: string }[])[0]!.error)).toMatch(
      /expected 3 but got 2/,
    );
    expect(file).not.toHaveProperty("tests");
    // the banner alone is no terminal worth showing
    expect(file["terminal"] ?? []).not.toContain("CraftOS 1.8");
  }, 60000);

  it("craftos_read_terminal delta: an unchanged screen is just a marker", async () => {
    const created = JSON.parse(
      textOf(
        await client.callTool({
          name: "craftos_session_create",
          arguments: {},
        }),
      ),
    ) as { id: string };
    try {
      const read = async (delta: boolean) =>
        JSON.parse(
          textOf(
            await client.callTool({
              name: "craftos_read_terminal",
              arguments: { id: created.id, delta },
            }),
          ),
        ) as Record<string, unknown>[];
      const first = await read(true);
      expect(first[0]!["lines"]).toBeDefined();
      expect(await read(true)).toEqual([{ window: 0, unchanged: true }]);
      // without delta the whole screen, as before
      expect((await read(false))[0]!["lines"]).toEqual(first[0]!["lines"]);
      await client.callTool({
        name: "craftos_type",
        arguments: { id: created.id, text: "x", enter: false },
      });
      await new Promise((r) => setTimeout(r, 300));
      expect((await read(true))[0]!["lines"]).toBeDefined();
    } finally {
      await client.callTool({
        name: "craftos_session_destroy",
        arguments: { id: created.id },
      });
    }
  }, 60000);
});

describe.skipIf(!ready)("sessions are per client", () => {
  it("lists a person's viewer computers apart, and does not stop them without force", async () => {
    const { createServer } = await import("node:net");
    const port = await new Promise<number>((done) => {
      const s = createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => done(p));
      });
    });
    const agent = await connect({ CRAFTOS_VIEWER_PORT: String(port) });
    const list = async () =>
      JSON.parse(
        textOf(
          await agent.callTool({ name: "craftos_session_list", arguments: {} }),
        ),
      ) as {
        sessions: { id: string }[];
        others?: { id: string; owner: string; running: boolean }[];
      };
    try {
      const mine = JSON.parse(
        textOf(
          await agent.callTool({
            name: "craftos_session_create",
            arguments: {},
          }),
        ),
      ) as { id: string };
      expect(await list()).toEqual({
        sessions: [expect.objectContaining({ id: mine.id })],
      });
      // a person makes a computer in the viewer
      let viewer = "";
      for (let i = 0; i < 50 && !viewer; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          });
          viewer = ((await res.json()) as { ids: string[] }).ids[0]!;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      const both = await list();
      expect(both.sessions.map((s) => s.id)).toEqual([mine.id]);
      expect(both.others).toEqual([
        { id: viewer, owner: "a person in the viewer", running: true },
      ]);
      const refused = (await agent.callTool({
        name: "craftos_session_destroy",
        arguments: { id: viewer },
      })) as Result;
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toMatch(
        /belongs to a person in the viewer.*force: true/,
      );
      expect((await list()).others).toHaveLength(1);
      const forced = (await agent.callTool({
        name: "craftos_session_destroy",
        arguments: { id: viewer, force: true },
      })) as Result;
      expect(forced.isError).toBeFalsy();
      // its own sessions it stops as before
      const own = (await agent.callTool({
        name: "craftos_session_destroy",
        arguments: { id: mine.id },
      })) as Result;
      expect(own.isError).toBeFalsy();
      expect(await list()).toEqual({ sessions: [] });
    } finally {
      await agent.close();
    }
  }, 60000);
});
