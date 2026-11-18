// Long calls (progress notifications, the time budget and partial results), craftos.json, and the viewer's port
// fallback, as a client over stdio sees them.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Progress } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, describe, expect, it } from "vitest";
import { checkConfig, loadConfig } from "@craftos-mcp/runner";
import { progressFor, withBudget } from "./progress.js";

const SERVER = join(import.meta.dirname, "..", "dist", "index.js");
const ready = checkConfig(loadConfig()).length === 0;
const scratch = mkdtempSync(join(tmpdir(), "mcp-long-"));
const clients: Client[] = [];
afterAll(async () => {
  for (const c of clients) await c.close().catch(() => undefined);
  rmSync(scratch, { recursive: true, force: true });
});

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(scratch, "ws-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

async function connect(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: {
      ...(process.env as Record<string, string>),
      CRAFTOS_VIEWER_PORT: "off",
      ...env,
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

const json = (r: unknown): Record<string, unknown> =>
  JSON.parse(
    (r as { content: { type: string; text: string }[] }).content.find(
      (c) => c.type === "text",
    )!.text,
  ) as Record<string, unknown>;

describe("progress helpers", () => {
  it("send nothing without a progressToken, and only rising progress with one", async () => {
    const sent: unknown[] = [];
    const base = {
      signal: new AbortController().signal,
      sendNotification: async (n: unknown) => void sent.push(n),
    };
    progressFor(base)(1, 2);
    expect(sent).toEqual([]);
    const p = progressFor({ ...base, _meta: { progressToken: "t" } });
    p(1, 2, "a");
    p(1, 2, "again");
    p(2, 2);
    expect(sent).toEqual([
      {
        method: "notifications/progress",
        params: { progressToken: "t", progress: 1, total: 2, message: "a" },
      },
      {
        method: "notifications/progress",
        params: { progressToken: "t", progress: 2, total: 2 },
      },
    ]);
  });

  it("a budget fires on its own, and tells a client's cancel apart", async () => {
    const cancel = new AbortController();
    const b = withBudget(cancel.signal, 20);
    await new Promise((r) => setTimeout(r, 60));
    expect(b.signal.aborted).toBe(true);
    expect(b.expired()).toBe(true);
    const c = new AbortController();
    const b2 = withBudget(c.signal, 10_000);
    c.abort();
    expect(b2.signal.aborted).toBe(true);
    expect(b2.expired()).toBe(false);
    b2.dispose();
  });
});

describe.skipIf(!ready)("long calls", () => {
  it("craftos_test reports progress per file", async () => {
    const dir = folder({
      "a.test.lua": 'ccunit.test("a", function() ccunit.truthy(true) end)',
      "b.test.lua": 'ccunit.test("b", function() ccunit.truthy(true) end)',
    });
    const client = await connect({ CRAFTOS_WORKSPACE: dir });
    const seen: Progress[] = [];
    const r = await client.callTool(
      { name: "craftos_test", arguments: {} },
      undefined,
      { onprogress: (p) => void seen.push(p) },
    );
    expect(json(r)["passed"]).toBe(2);
    expect(seen[0]).toMatchObject({ progress: 0, total: 2 });
    expect(seen.at(-1)).toMatchObject({ progress: 2, total: 2 });
    expect(seen.at(-1)!.message).toMatch(/\.test\.lua passed$/);
  }, 60000);

  it("craftos_test stops at its budget and answers with what finished", async () => {
    const dir = folder({
      "1-quick.test.lua":
        'ccunit.test("quick", function() ccunit.truthy(true) end)',
      "2-hangs.test.lua":
        'ccunit.test("done first", function() end) ccunit.test("hangs", function() sleep(120) end)',
      "3-never.test.lua": 'ccunit.test("never", function() end)',
    });
    const client = await connect({
      CRAFTOS_WORKSPACE: dir,
      CRAFTOS_TEST_CONCURRENCY: "1",
    });
    const started = Date.now();
    const r = await client.callTool({
      name: "craftos_test",
      arguments: { budgetMs: 8000, timeoutMs: 120000 },
    });
    expect(Date.now() - started).toBeLessThan(30000);
    const reply = json(r);
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(reply["budget"]).toMatch(/ran out after 8 s/);
    expect(reply["notRun"]).toEqual(["3-never.test.lua"]);
    const files = reply["files"] as {
      file: string;
      status: string;
      passed: number;
    }[];
    expect(files.find((f) => f.file === "1-quick.test.lua")?.status).toBe(
      "passed",
    );
    const hung = files.find((f) => f.file === "2-hangs.test.lua");
    expect(hung?.status).toBe("timed_out");
    expect(hung?.passed).toBe(1);
  }, 60000);

  it("craftos_run ticks while it runs", async () => {
    const dir = folder({ "wait.lua": 'sleep(5) print("done")' });
    const client = await connect({ CRAFTOS_WORKSPACE: dir });
    const seen: Progress[] = [];
    const r = await client.callTool(
      {
        name: "craftos_run",
        arguments: { program: "wait.lua", timeoutMs: 20000 },
      },
      undefined,
      { onprogress: (p) => void seen.push(p) },
    );
    expect(json(r)["status"]).toBe("completed");
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]).toMatchObject({ progress: 0, total: 20 });
    expect(seen.at(-1)!.message).toMatch(/^wait\.lua, \d+ s$/);
  }, 60000);

  it("craftos.json gives the test globs and the world; craftos_info names it", async () => {
    const dir = folder({
      "craftos.json": JSON.stringify({
        tests: ["unit/*.test.lua"],
        world: "my.world.json",
        minecraft: "1.18.2",
      }),
      "my.world.json": JSON.stringify({ computerId: 9 }),
      "unit/id.test.lua":
        'ccunit.test("id", function() ccunit.eq(os.getComputerID(), 9) end)',
      "other/no.test.lua": 'ccunit.test("no", function() error("ran") end)',
    });
    const client = await connect({ CRAFTOS_WORKSPACE: dir });
    const info = json(
      await client.callTool({ name: "craftos_info", arguments: {} }),
    );
    expect(info["project"]).toBe(join(dir, "craftos.json"));
    const r = json(
      await client.callTool({ name: "craftos_test", arguments: {} }),
    );
    expect(r).toMatchObject({ passed: 1, failed: 0 });
    expect((r["files"] as { file: string }[]).map((f) => f.file)).toEqual([
      "unit/id.test.lua",
    ]);
    // a world given in the call wins over craftos.json's
    const run = json(
      await client.callTool({
        name: "craftos_test",
        arguments: { paths: ["unit"], world: { computerId: 3 } },
      }),
    );
    expect(run["failed"]).toBe(1);
  }, 60000);
});

describe("the viewer", () => {
  it("takes a free port when its own is taken", async () => {
    const taken: Server = createServer();
    const port = await new Promise<number>((done) =>
      taken.listen(0, "127.0.0.1", () =>
        done((taken.address() as { port: number }).port),
      ),
    );
    try {
      const dir = folder({});
      const client = await connect({
        CRAFTOS_WORKSPACE: dir,
        CRAFTOS_VIEWER_PORT: String(port),
      });
      let viewer: unknown;
      for (let i = 0; i < 50 && !viewer; i++) {
        viewer = json(
          await client.callTool({ name: "craftos_info", arguments: {} }),
        )["viewer"];
        if (!viewer) await new Promise((r) => setTimeout(r, 100));
      }
      expect(viewer).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      expect(viewer).not.toBe(`http://127.0.0.1:${port}/`);
      const res = await fetch(String(viewer));
      expect(res.status).toBe(200);
    } finally {
      taken.close();
    }
  }, 30000);
});
