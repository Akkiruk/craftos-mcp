#!/usr/bin/env node
// Makes the agent demo video: a real Claude Code session writing a ComputerCraft door controller, testing it in this
// emulator through the MCP tools, finding two problems by testing and fixing them.
//
//   npm run build && node scripts/make-agent-demo.mjs [--out dir] [--keep]
//   node scripts/make-agent-demo.mjs --scrub <raw stream-json> --request "<the -p prompt>"   (once, after a session)
//
// Output (default docs/media/showcase/): agent-demo.mp4, agent-demo.gif and agent-demo-*.png stills.
//
// The session. Claude Code ran headless in an empty folder with only this repository's MCP server (CRAFTOS_WORKSPACE =
// that folder, CRAFTOS_ADDONS=advanced-peripherals) and the cc-tweaked-dev skill in the folder's .claude/skills:
//
//   claude -p "Write a door controller for my base: ..." --output-format stream-json --verbose --model opus
//     --mcp-config mcp.json --strict-mcp-config --setting-sources project
//     --allowedTools mcp__craftos Write Read Edit Skill Glob Grep --disallowedTools Bash PowerShell WebFetch ...
//
// Its stream-json transcript, scrubbed of local paths (--scrub), is docs/media/showcase/agent-demo-transcript.jsonl,
// with a readable copy next to it (.md). Every word, file and result in the video is read from that transcript.
//
// The pictures of the monitor. The agent read the screens as text (craftos_ui and craftos_script results); the
// screenshot files the tools saved as evidence went away with each session. So this script replays the agent's own
// calls: it rebuilds the agent's files as they were at each moment (its writes and edits, in order), starts the MCP
// server, sends the same craftos_session_create and craftos_script calls with the same arguments (a long script is
// split where the video wants a picture), checks that each replayed result says what the original said, and takes a
// craftos_screenshot. Then each beat of the story is drawn as an HTML page in Chromium (Playwright), and ffmpeg makes
// the MP4 and GIF.
//
// Needs ffmpeg (FFMPEG, the PATH, or winget's Gyan.FFmpeg), Playwright (PLAYWRIGHT_MODULE names its index.mjs, default
// the "playwright" package) and Chromium (CHROMIUM_PATH, default Playwright's own).

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const OUT = resolve(option("out") ?? join(ROOT, "docs", "media", "showcase"));
const TRANSCRIPT = join(
  ROOT,
  "docs",
  "media",
  "showcase",
  "agent-demo-transcript.jsonl",
);

// ---------------------------------------------------------------------------------------------------------------
// --scrub: the raw stream-json of a session becomes the published transcript

/** What the published transcript calls the session's folder and this repository. */
const PROJECT_AS = "C:\\work\\door";
const REPO_AS = "C:\\craftos-mcp";
/** Fields of the sim state that belong to a private addon, not to anything the session used. */
const PRIVATE_SIM_KEYS = [
  "balances",
  "rejections",
  "terminalLocked",
  "survives",
  "ledger",
  "pendingApprovals",
];

function scrub(rawFile, request) {
  if (!request) throw new Error("--scrub needs --request <the -p prompt>");
  const lines = readFileSync(rawFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const init = lines.find((m) => m.type === "system" && m.subtype === "init");
  const project = init.cwd;
  const repo = ROOT;
  /** Every spelling of a Windows path in the transcript: \, \\ (inside JSON text) and /, any case. */
  const spellings = (path, as) =>
    ["\\", "\\\\", "/"].map((sep) => {
      const parts = path.split(/[\\/]/);
      const pattern = parts
        .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(sep.replace(/\\/g, "\\\\"));
      return [new RegExp(pattern, "gi"), as.split("\\").join(sep)];
    });
  const rules = [
    ...spellings(project, PROJECT_AS),
    ...spellings(repo, REPO_AS),
  ];
  const user = basename(homedir());
  const clean = (s) => {
    for (const [re, as] of rules) s = s.replace(re, as);
    return s.replace(
      new RegExp(user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
      "user",
    );
  };
  const walk = (v) =>
    typeof v === "string"
      ? clean(v)
      : Array.isArray(v)
        ? v.map(walk)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
          : v;

  // tool calls whose results are trimmed: reads of this repository's docs (outside the session's folder) and the sim
  // state, which carries a private addon's fields
  const omit = new Set();
  const simState = new Set();
  for (const m of lines)
    if (m.type === "assistant")
      for (const c of m.message.content)
        if (c.type === "tool_use") {
          const path = c.input?.path ?? c.input?.file_path ?? "";
          if (
            (c.name === "Read" || c.name === "Grep") &&
            path &&
            !path.toLowerCase().startsWith(project.toLowerCase())
          )
            omit.add(c.id);
          if (/craftos_sim_(state|command)$/.test(c.name)) simState.add(c.id);
        }
  const trimSim = (text) => {
    try {
      const state = JSON.parse(text);
      const sim = state.sim ?? state;
      for (const k of PRIVATE_SIM_KEYS) delete sim[k];
      return JSON.stringify(state, null, 2);
    } catch {
      return text;
    }
  };

  const out = [];
  for (const m of lines) {
    if (
      m.type === "rate_limit_event" ||
      (m.type === "system" && m.subtype !== "init")
    )
      continue;
    if (m.type === "system") {
      out.push(
        walk({
          type: "system",
          subtype: "init",
          cwd: m.cwd,
          session_id: m.session_id,
          model: m.model,
          claude_code_version: m.claude_code_version,
          permissionMode: m.permissionMode,
          mcp_servers: m.mcp_servers,
          tools: m.tools.filter((t) => !/minecraft_/.test(t)),
        }),
      );
      // stream-json does not echo the -p prompt, so it goes in as the first user message
      out.push({ type: "user", message: { role: "user", content: request } });
      continue;
    }
    const copy = structuredClone(m);
    if (copy.type === "user" && Array.isArray(copy.message?.content)) {
      for (const c of copy.message.content) {
        if (c.type !== "tool_result") continue;
        if (omit.has(c.tool_use_id)) {
          c.content =
            "[left out of the published transcript: lines of the craftos-mcp repository's own docs]";
          delete copy.tool_use_result;
        } else if (simState.has(c.tool_use_id)) {
          if (typeof c.content === "string") c.content = trimSim(c.content);
          else
            for (const p of c.content)
              if (p.type === "text") p.text = trimSim(p.text);
          delete copy.tool_use_result;
        }
      }
    }
    if (copy.type === "result") delete copy.modelUsage;
    out.push(walk(copy));
  }
  mkdirSync(dirname(TRANSCRIPT), { recursive: true });
  writeFileSync(
    TRANSCRIPT,
    out.map((m) => JSON.stringify(m)).join("\n") + "\n",
  );
  writeFileSync(TRANSCRIPT.replace(/\.jsonl$/, ".md"), readable(out));
  const leftover = out
    .map((m) => JSON.stringify(m))
    .join("\n")
    .match(new RegExp(user, "i"));
  console.log(
    `wrote ${TRANSCRIPT} (${out.length} messages)${leftover ? " - WARNING: user name still in it" : ""}`,
  );
}

/** The transcript as Markdown: the request, what the agent said, every tool call and its result. */
function readable(messages) {
  const init = messages[0];
  const result = messages.find((m) => m.type === "result");
  const md = [
    "# Agent demo: the whole session",
    "",
    `A real, unedited Claude Code ${init.claude_code_version} session (model ${init.model}), run headless with only the`,
    "craftos-mcp MCP server and the cc-tweaked-dev skill, in an empty folder. It is what",
    "[agent-demo.mp4](agent-demo.mp4) shows. Local paths are replaced (`C:\\work\\door` is the session's folder), reads",
    "of the craftos-mcp repository's own docs are left out, and so are a private addon's fields in the sim state. The",
    "raw messages are in [agent-demo-transcript.jsonl](agent-demo-transcript.jsonl).",
    "",
    `Took ${Math.round(result.duration_ms / 1000)} s and ${result.num_turns} turns.`,
    "",
  ];
  const fence = (s, lang = "") => {
    const ticks = s.includes("```") ? "````" : "```";
    return [`${ticks}${lang}`, s.replace(/\r/g, ""), ticks, ""];
  };
  for (const m of messages) {
    if (m.type === "user" && typeof m.message?.content === "string")
      md.push("## Request", "", `> ${m.message.content}`, "");
    if (m.type === "user" && Array.isArray(m.message?.content))
      for (const c of m.message.content) {
        if (c.type === "text") md.push("## Request", "", `> ${c.text}`, "");
        if (c.type !== "tool_result") continue;
        const parts =
          typeof c.content === "string"
            ? [{ type: "text", text: c.content }]
            : c.content;
        md.push(`Result${c.is_error ? " (error)" : ""}:`, "");
        for (const p of parts) {
          if (p.type === "text")
            md.push(
              ...fence(
                p.text.length > 6000
                  ? p.text.slice(0, 6000) + "\n[...]"
                  : p.text,
              ),
            );
          else md.push("_(an image)_", "");
        }
      }
    if (m.type === "assistant")
      for (const c of m.message.content) {
        if (c.type === "text")
          md.push(
            ...c.text.split("\n").map((l) => (l ? `**Claude:** ${l}` : "")),
            "",
          );
        if (c.type === "tool_use") {
          const { content, new_string, old_string, ...rest } = c.input ?? {};
          md.push(
            `### ${c.name.replace("mcp__craftos__", "")}`,
            "",
            ...fence(JSON.stringify(rest, null, 2), "json"),
          );
          if (old_string !== undefined)
            md.push(
              "Replaces:",
              "",
              ...fence(old_string, "lua"),
              "With:",
              "",
              ...fence(new_string, "lua"),
            );
          if (content !== undefined)
            md.push(
              ...fence(content, c.input.path?.endsWith(".lua") ? "lua" : ""),
            );
        }
      }
    if (m.type === "result") md.push("## Final answer", "", m.result ?? "", "");
  }
  return md.join("\n").replace(/\r?\n/g, "\r\n");
}

if (flag("scrub")) {
  scrub(resolve(option("scrub")), option("request"));
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------------------------
// The transcript: calls by id, and the files as they were at any moment

const messages = readFileSync(TRANSCRIPT, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const request = (() => {
  const m = messages.find((x) => x.type === "user");
  return typeof m.message.content === "string"
    ? m.message.content
    : m.message.content.find((c) => c.type === "text").text;
})();
/** Tool calls in order: { id, name, input, result (text), error }; looked up by the last 6 characters of the id. */
const calls = [];
const texts = []; // what the agent said, in order
for (const m of messages) {
  if (m.type === "assistant")
    for (const c of m.message.content) {
      if (c.type === "tool_use")
        calls.push({
          id: c.id,
          name: c.name.replace("mcp__craftos__", ""),
          input: c.input,
        });
      if (c.type === "text") texts.push(c.text);
    }
  if (m.type === "user" && Array.isArray(m.message.content))
    for (const c of m.message.content) {
      if (c.type !== "tool_result") continue;
      const call = calls.find((x) => x.id === c.tool_use_id);
      const parts =
        typeof c.content === "string"
          ? [{ type: "text", text: c.content }]
          : c.content;
      call.result = parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");
      call.error = !!c.is_error;
    }
}
const call = (short) => {
  const found = calls.find((c) => c.id.endsWith(short));
  if (!found) throw new Error(`no call ${short} in the transcript`);
  return found;
};
const json = (short) => JSON.parse(call(short).result);
const said = (start) => {
  const t = texts.find((x) => x.startsWith(start));
  if (!t) throw new Error(`the agent never said "${start}"`);
  return t;
};

/** The session's files after every write and edit up to and including call `short`. */
function filesAt(short) {
  const files = {};
  for (const c of calls) {
    const rel = (p) => basename(p.replace(/\\/g, "/"));
    if (c.name === "craftos_write_file") files[c.input.path] = c.input.content;
    if (c.name === "Write") files[rel(c.input.file_path)] = c.input.content;
    if (c.name === "Edit") {
      const name = rel(c.input.file_path);
      const before = files[name];
      if (!before?.includes(c.input.old_string))
        throw new Error(`edit ${c.id} does not apply to ${name}`);
      files[name] = c.input.replace_all
        ? before.split(c.input.old_string).join(c.input.new_string)
        : before.replace(c.input.old_string, () => c.input.new_string);
    }
    if (c.id.endsWith(short)) return files;
  }
  throw new Error(`no call ${short}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Replaying the agent's calls for pictures of its monitor

const { Client } = await import(
  pathToFileURL(
    join(
      ROOT,
      "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js",
    ),
  ).href
);
const { StdioClientTransport } = await import(
  pathToFileURL(
    join(
      ROOT,
      "node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js",
    ),
  ).href
);

const work = mkdtempSync(join(tmpdir(), "agent-demo-"));
const workspace = join(work, "door");
mkdirSync(workspace);
const client = new Client({ name: "make-agent-demo", version: "1" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, "apps", "mcp-server", "dist", "index.js")],
    env: {
      ...process.env,
      CRAFTOS_WORKSPACE: workspace,
      CRAFTOS_ADDONS: "advanced-peripherals",
    },
    stderr: "ignore",
  }),
);
const tool = async (name, input) => {
  const r = await client.callTool({ name, arguments: input }, undefined, {
    timeout: 120000,
  });
  const text = r.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  return {
    text,
    error: !!r.isError,
    images: r.content
      .filter((c) => c.type === "image")
      .map((c) => Buffer.from(c.data, "base64")),
  };
};
const parse = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};

/** Puts the agent's files as they were after call `short` in the replay's workspace. */
function useFiles(short) {
  for (const f of readdirSync(workspace))
    rmSync(join(workspace, f), { recursive: true, force: true });
  for (const [name, content] of Object.entries(filesAt(short)))
    writeFileSync(join(workspace, name), content);
}

/** craftos_session_create with the agent's arguments; a create that times out (startup.lua runs the door at boot)
 * still makes the session, as it did for the agent, so then the newest session is used. */
async function createLike(short) {
  const r = await tool("craftos_session_create", call(short).input);
  if (!r.error) return parse(r.text).id;
  const list = parse((await tool("craftos_session_list", {})).text);
  if (!list.length) throw new Error(`session_create ${short}: ${r.text}`);
  return list[list.length - 1].id;
}

/** Steps `from`..`to` of the agent's craftos_script `short`, on session `id`, with its other options. */
async function scriptLike(id, short, from, to, extra = {}) {
  const { steps, id: _id, ...options } = call(short).input;
  const r = await tool("craftos_script", {
    ...options,
    ...extra,
    id,
    steps: steps.slice(from, to + 1),
  });
  return parse(r.text);
}

const shots = {}; // name -> { terminal, monitor } PNG buffers
async function shoot(id, name) {
  const r = await tool("craftos_screenshot", { id, scale: 3 });
  const screens = parse(r.text);
  const at = (pred) => r.images[screens.findIndex(pred)];
  shots[name] = {
    terminal: at((s) => !s.peripheral),
    monitor: at((s) => s.peripheral === "top"),
  };
}
const check = (what, ok, detail) => {
  if (!ok)
    throw new Error(
      `replay differs from the session at ${what}: ${JSON.stringify(detail).slice(0, 400)}`,
    );
  console.log(`  replay matches: ${what}`);
};

console.log("replaying the agent's calls...");
{
  // first live run: the program never settles (it redraws every half second)
  useFiles("a2jDud");
  const id = await createLike("iJ7YhH");
  const r = await scriptLike(id, "a2jDud", 0, 1);
  check(
    "first run does not settle",
    r.failures?.[0]?.reason === json("a2jDud").failures[0].reason,
    r,
  );
  await shoot(id, "unsettled");
  await tool("craftos_session_destroy", { id });
}
{
  // after the flicker fix: the scripted world, then the range edge
  useFiles("wGvjhC");
  const id = await createLike("PqkcpH");
  let r = await scriptLike(id, "wGvjhC", 0, 4);
  check("stranger alone", r.ok, r);
  await shoot(id, "stranger");
  r = await scriptLike(id, "wGvjhC", 5, 7);
  check("friend arrives", r.ok, r);
  await shoot(id, "friend");
  r = await scriptLike(id, "wGvjhC", 8, 9);
  check("press LOCK", r.ok, r);
  await shoot(id, "locked");
  r = await scriptLike(id, "wGvjhC", 10, 22);
  check("rest of the 23 steps", r.ok, r);
  r = await scriptLike(id, "pGavnv", 0, 2);
  const original = json("pGavnv").failures[0].failures[0];
  check(
    "Steve at +5 keeps the door shut",
    r.failures?.[0]?.failures?.[0]?.reason === original.reason,
    r,
  );
  await shoot(id, "edge");
  await tool("craftos_session_destroy", { id });
}
{
  // after the range fix: the last live check at the edge that failed before
  useFiles("icQHA3");
  const id = await createLike("645GcC");
  const r = await scriptLike(id, "icQHA3", 0, 3);
  check("Steve at +5.5 opens the door", r.ok, r);
  await shoot(id, "fixed");
  await tool("craftos_session_destroy", { id });
}
await client.close();

// ---------------------------------------------------------------------------------------------------------------
// The story: beats drawn as pages

const W = 1280;
const H = 720;
const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const dataUrl = (png) => `data:image/png;base64,${png.toString("base64")}`;
const kb = (s) => `${(Buffer.byteLength(s) / 1024).toFixed(1)} KB`;

/** Lines of a file, numbered, with `[from, to]` ranges; a gap between ranges is shown as "...". */
function codeView(name, content, ranges, mark = []) {
  const lines = content.replace(/\r/g, "").split("\n");
  const rows = [];
  ranges.forEach(([from, to], i) => {
    if (i > 0) rows.push(`<div class="ln gap"><i></i>...</div>`);
    for (let n = from; n <= to; n++)
      rows.push(
        `<div class="ln${mark.includes(n) ? " add" : ""}"><i>${n}</i>${esc(lines[n - 1] ?? "") || " "}</div>`,
      );
  });
  return `<div class="file"><div class="fname">${esc(name)}</div><div class="code">${rows.join("")}</div></div>`;
}

/** An Edit as a diff: removed lines red, added lines green. */
function diffView(short, label) {
  const { old_string, new_string, file_path } = call(short).input;
  const del = old_string
    .split("\n")
    .filter((l) => !new_string.split("\n").includes(l));
  const rows = [
    ...del.map((l) => `<div class="ln del"><i>-</i>${esc(l)}</div>`),
    ...new_string
      .split("\n")
      .map((l) =>
        old_string.split("\n").includes(l)
          ? `<div class="ln"><i> </i>${esc(l) || " "}</div>`
          : `<div class="ln add"><i>+</i>${esc(l) || " "}</div>`,
      ),
  ];
  return `<div class="file"><div class="fname">Edit ${esc(basename(file_path.replace(/\\/g, "/")))} <span>${esc(label)}</span></div><div class="code">${rows.join("")}</div></div>`;
}

/** A craftos_test result as a test runner's output. */
function testView(short) {
  const r = json(short);
  const rows = [];
  for (const f of r.files) {
    rows.push(`<div class="tf">${esc(f.file)}</div>`);
    for (const t of f.tests)
      rows.push(
        `<div class="tt ${t.passed ? "ok" : "bad"}">${t.passed ? "✓" : "✗"} ${esc(t.name)}</div>`,
      );
  }
  return `<div class="tests"><div class="fname">craftos_test</div><div class="tbody">${rows.join("")}<div class="tsum ${r.failed ? "bad" : "ok"}">${r.passed} passed, ${r.failed} failed</div></div></div>`;
}

/** The monitor (big) and the top rows of the terminal, from a replayed screenshot. */
function screenView(name, { label, ring, terminalRows = 3 } = {}) {
  const { monitor, terminal } = shots[name];
  const ringHtml = ring
    ? `<div class="ring" style="left:${((ring.x - 0.5) / 18) * 100}%;top:${((ring.y - 0.5) / 5) * 100}%"></div>`
    : "";
  const termH = Math.round(((terminalRows + 0.6) / 19) * 100);
  return `<div class="screens">
    <div class="slabel">monitor "top" (2x1)${label ? ` <b>${esc(label)}</b>` : ""}</div>
    <div class="mon"><img src="${dataUrl(monitor)}">${ringHtml}</div>
    <div class="slabel">terminal</div>
    <div class="term" style="--rows:${termH}"><img src="${dataUrl(terminal)}"></div>
  </div>`;
}

const failBox = (title, lines) =>
  `<div class="fail"><div class="ftitle">✗ ${esc(title)}</div>${lines.map((l) => `<div>${esc(l)}</div>`).join("")}</div>`;
const quote = (text) =>
  `<div class="quote"><span>Claude</span>${esc(text)}</div>`;

// the log on the left: one line per tool call the video talks about
const LOG = {
  skill: { tool: "Skill", text: "cc-tweaked-dev" },
  write1: {
    tool: "craftos_write_file",
    text: `door.lua (${kb(call("Ze8cR5").input.content)})`,
  },
  write2: {
    tool: "craftos_write_file",
    text: `door.test.lua (${kb(call("7KFopb").input.content)})`,
  },
  test1: {
    tool: "craftos_test",
    text: `${json("QJpM2X").passed} passed`,
    ok: true,
  },
  create: { tool: "craftos_session_create", text: "monitor + detector" },
  script1: {
    tool: "craftos_script",
    text: "run door: did not settle",
    bad: true,
  },
  edit1: { tool: "Edit", text: "door.lua: redraw only on change" },
  script2: {
    tool: "craftos_script",
    text: `${json("wGvjhC").steps} steps pass`,
    ok: true,
  },
  script3: { tool: "craftos_script", text: "+5 blocks: shut", bad: true },
  edit2: { tool: "Edit", text: "door.lua: scan range + 1" },
  write3: { tool: "craftos_write_file", text: "door_run.test.lua" },
  test2: {
    tool: "craftos_test",
    text: `${json("crvxtB").passed} passed`,
    ok: true,
  },
  script4: { tool: "craftos_script", text: "+5 blocks: opens", ok: true },
};

const v0 = filesAt("Ze8cR5")["door.lua"];
const edgeFail = json("pGavnv").failures[0].failures[0];
const finalAnswer = messages.find((m) => m.type === "result").result;
const lopsided = said("Box edges are lopsided");

/** seconds, caption, log lines so far (the last is current), the right-hand panel, still name. */
const BEATS = [
  {
    s: 4.5,
    caption: "You ask Claude Code for a door controller",
    log: [],
    panel: `<div class="ask"><div class="who">You</div><div class="bubble">${esc(request)}</div></div>`,
    still: "request",
  },
  {
    s: 5,
    caption: "It writes the program and its tests",
    log: ["skill", "write1", "write2"],
    panel: codeView("door.lua", v0, [
      [8, 14],
      [24, 38],
    ]),
  },
  {
    s: 3.5,
    caption: "Runs the tests in the emulator: all pass",
    log: ["skill", "write1", "write2", "test1"],
    panel: testView("QJpM2X"),
  },
  {
    s: 6.5,
    caption:
      "Runs it on an emulated computer: the monitor never stops redrawing",
    log: ["skill", "write1", "write2", "test1", "create", "script1"],
    panel:
      screenView("unsettled") +
      failBox('craftos_script, step 0: text "door"', [
        json("a2jDud").failures[0].reason,
      ]) +
      quote(said("It works, but it redraws").replace(/ Changing it.*$/s, "")),
  },
  {
    s: 4.5,
    caption: "It fixes the flicker",
    log: ["skill", "write1", "write2", "test1", "create", "script1", "edit1"],
    panel: diffView("C1fi6A", "redraw only when something changes"),
  },
  ...[
    [
      "stranger",
      "a stranger walks up",
      "Mallory, not on the list: the door stays shut",
    ],
    ["friend", "Steve walks up", "Steve is on the list: OPEN, redstone ON"],
    [
      "locked",
      "tap [ LOCK ]",
      "Locked: shut even with Steve there",
      { x: 9, y: 5 },
    ],
  ].map(([shot, label, caption, ring], i) => ({
    s: i === 2 ? 3.5 : 2.8,
    caption,
    log: ["write1", "write2", "test1", "create", "script1", "edit1", "script2"],
    panel: screenView(shot, { label, ring }),
    still: i === 1 ? "open" : undefined,
  })),
  {
    s: 6.5,
    caption: "A friend 5 blocks east: the door stays shut. Its check caught it",
    log: ["test1", "create", "script1", "edit1", "script2", "script3"],
    panel:
      screenView("edge", { label: "Steve at x = 5" }) +
      failBox("craftos_script, step 2: expect", [
        `${edgeFail.reason}`,
        `nearest: ${edgeFail.nearest.join(", ")}`,
      ]) +
      quote(lopsided.replace(/ Real players.*$/s, "")),
    still: "caught",
  },
  {
    s: 6,
    caption: "It works out why and fixes it",
    log: ["test1", "create", "script1", "edit1", "script2", "script3", "edit2"],
    panel:
      diffView("pz2ZGV", "Advanced Peripherals' range box") +
      quote(
        /A player standing 5 blocks east was not detected\./.test(finalAnswer)
          ? "A player standing 5 blocks east was not detected. The program now asks for range 6, so nobody within 5 blocks is missed."
          : "",
      ),
  },
  {
    s: 6.5,
    caption: "Adds tests, runs everything again: all pass",
    log: [
      "script1",
      "edit1",
      "script2",
      "script3",
      "edit2",
      "write3",
      "test2",
      "script4",
    ],
    panel: `<div class="pair">${testView("crvxtB")}${screenView("fixed", { label: "Steve at x = 5.5" })}</div>`,
    still: "pass",
  },
];
const END = 5.5;

const CSS = `
* { box-sizing: border-box; margin: 0; }
body { width: ${W}px; height: ${H}px; background: #0d0f14; color: #e6e6e6; font: 16px "Segoe UI", system-ui, sans-serif; overflow: hidden; }
.top { height: 46px; display: flex; align-items: center; gap: 12px; padding: 0 22px; border-bottom: 1px solid #222838; font-size: 15px; color: #9aa3b5; }
.top b { color: #e6e6e6; font-weight: 600; }
.pill { background: #d97757; color: #fff; border-radius: 4px; padding: 2px 8px; font-weight: 600; font-size: 13px; }
.top .grow { flex: 1; }
.main { display: flex; height: ${H - 46 - 78}px; }
.log { width: 430px; padding: 18px 16px 18px 22px; border-right: 1px solid #222838; font: 14.5px "Cascadia Mono", Consolas, monospace; }
.log h4 { font: 600 12px "Segoe UI", sans-serif; color: #6c7488; letter-spacing: .08em; margin-bottom: 10px; }
.row { padding: 6px 8px; border-radius: 5px; margin-bottom: 4px; color: #7d8598; display: flex; gap: 8px; }
.row .t { color: #8fb3ff; white-space: nowrap; }
.row .x { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row.cur { background: #1a2030; color: #e6e6e6; }
.row.cur .t { color: #a9c4ff; }
.row.ok .x { color: #6fd38a; } .row.bad .x { color: #ff7b72; }
.row:not(.cur) { opacity: .75; }
.panel { flex: 1; padding: 18px 22px; display: flex; flex-direction: column; gap: 12px; overflow: hidden; }
.caption { height: 78px; display: flex; align-items: center; justify-content: center; font-size: 28px; font-weight: 600; background: #141823; border-top: 1px solid #222838; padding: 0 30px; text-align: center; }
.ask { margin-top: 40px; } .who { color: #9aa3b5; font-size: 14px; margin-bottom: 8px; }
.bubble { background: #1d2333; border: 1px solid #2c3450; border-radius: 12px; padding: 22px 26px; font-size: 22px; line-height: 1.45; }
.file, .tests { background: #11141c; border: 1px solid #222838; border-radius: 8px; overflow: hidden; }
.fname { background: #181c27; padding: 7px 12px; font: 13px "Cascadia Mono", Consolas, monospace; color: #9aa3b5; }
.fname span { color: #6c7488; margin-left: 10px; font-family: "Segoe UI", sans-serif; }
.code { padding: 8px 0; font: 14px/1.42 "Cascadia Mono", Consolas, monospace; white-space: pre; }
.ln { padding: 0 12px; } .ln i { display: inline-block; width: 34px; color: #4b5266; font-style: normal; }
.ln.add { background: #12301d; color: #b6f0c4; } .ln.del { background: #3a1517; color: #ffb4ae; }
.ln.gap { color: #4b5266; }
.tbody { padding: 10px 14px; font: 14.5px/1.55 "Cascadia Mono", Consolas, monospace; }
.tf { color: #9aa3b5; margin-top: 4px; } .tt { padding-left: 14px; } .ok { color: #6fd38a; } .bad { color: #ff7b72; }
.tsum { margin-top: 8px; font-weight: 700; }
.screens { display: flex; flex-direction: column; gap: 6px; }
.slabel { font-size: 13px; color: #6c7488; } .slabel b { color: #e6e6e6; margin-left: 8px; font-weight: 600; background: #1d2333; padding: 1px 8px; border-radius: 4px; }
.mon { position: relative; width: 440px; border: 6px solid #3a3f4e; border-radius: 4px; background: #111; }
.mon img { display: block; width: 100%; image-rendering: pixelated; }
.ring { position: absolute; width: 54px; height: 54px; margin: -27px 0 0 -27px; border: 4px solid #ffd84d; border-radius: 50%; box-shadow: 0 0 12px #ffd84d; }
.term { width: 520px; height: calc(520px * 0.5596 * var(--rows) / 100); overflow: hidden; border: 4px solid #2a2f3c; border-radius: 4px; background: #111; }
.term img { display: block; width: 100%; image-rendering: pixelated; }
.fail { border: 1px solid #6b2a2a; background: #2a1415; border-radius: 8px; padding: 10px 14px; font: 14.5px/1.5 "Cascadia Mono", Consolas, monospace; color: #ffb4ae; }
.ftitle { color: #ff7b72; font-weight: 700; }
.quote { border-left: 3px solid #d97757; padding: 4px 12px; color: #d8d8d8; font-size: 17px; line-height: 1.4; }
.quote span { display: block; font-size: 12px; color: #d97757; font-weight: 600; margin-bottom: 2px; }
.pair { display: flex; gap: 18px; align-items: flex-start; } .pair .tests { width: 410px; flex: none; } .pair .tt { white-space: nowrap; } .pair .mon { width: 370px; } .pair .term { width: 370px; }
.end { height: ${H}px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px; text-align: center; }
.end h1 { font-size: 42px; font-weight: 700; } .end h1 span { color: #d97757; }
.end .url { font: 26px "Cascadia Mono", Consolas, monospace; color: #8fb3ff; }
.end .cmd { font: 24px "Cascadia Mono", Consolas, monospace; background: #141823; border: 1px solid #2c3450; padding: 12px 22px; border-radius: 8px; }
.end .note { font-size: 15px; color: #6c7488; margin-top: 18px; }
`;

const result = messages.find((m) => m.type === "result");
const header = (i) =>
  `<div class="top"><span class="pill">Claude Code</span><b>a real session</b> testing its own ComputerCraft code in craftos-mcp<span class="grow"></span>${i + 1} / ${BEATS.length}</div>`;
const page = (body) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${body}</body></html>`;
function beatPage(beat, i) {
  const rows = beat.log
    .map((k, j) => {
      const e = LOG[k];
      const cls = [
        j === beat.log.length - 1 ? "cur" : "",
        e.ok ? "ok" : "",
        e.bad ? "bad" : "",
      ].join(" ");
      return `<div class="row ${cls}"><span class="t">${esc(e.tool)}</span><span class="x">${esc(e.text)}</span></div>`;
    })
    .join("");
  return page(
    `${header(i)}<div class="main"><div class="log"><h4>TOOL CALLS</h4>${rows}</div><div class="panel">${beat.panel}</div></div><div class="caption">${esc(beat.caption)}</div>`,
  );
}
const endPage = page(`<div class="end">
  <h1><span>craftos-mcp</span>: your coding agent can test<br>its own ComputerCraft code</h1>
  <div class="url">github.com/Akkiruk/craftos-mcp</div>
  <div class="cmd">npx -y craftos-mcp serve</div>
  <div class="note">One unedited session (Claude Code, ${esc(messages[0].model)}, ${Math.round((result.duration_ms / 60000) * 10) / 10} min, ${result.num_turns} turns). Monitor pictures: the session's own tool calls, replayed.<br>Transcript: docs/media/showcase/agent-demo-transcript.md</div>
</div>`);

// ---------------------------------------------------------------------------------------------------------------
// Pages to PNGs, PNGs to video

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE
    ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : "playwright"
);
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {},
);
const tab = await browser.newPage({ viewport: { width: W, height: H } });
const frames = join(work, "frames");
mkdirSync(frames);
const list = [];
const render = async (html, name, seconds) => {
  await tab.setContent(html, { waitUntil: "load" });
  const file = join(frames, `${name}.png`);
  await tab.screenshot({ path: file });
  list.push({ file, seconds });
  return file;
};
mkdirSync(OUT, { recursive: true });
for (const [i, beat] of BEATS.entries()) {
  const file = await render(
    beatPage(beat, i),
    `beat-${String(i).padStart(2, "0")}`,
    beat.s,
  );
  if (beat.still)
    writeFileSync(
      join(OUT, `agent-demo-${beat.still}.png`),
      readFileSync(file),
    );
}
await render(endPage, "end", END);
await browser.close();

function findFfmpeg() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  const probe = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  if (!probe.error && probe.status === 0) return "ffmpeg";
  const winget = join(
    process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
    "Microsoft",
    "WinGet",
    "Packages",
  );
  if (existsSync(winget))
    for (const dir of readdirSync(winget).filter((d) => d.includes("FFmpeg")))
      for (const sub of readdirSync(join(winget, dir))) {
        const exe = join(winget, dir, sub, "bin", "ffmpeg.exe");
        if (existsSync(exe)) return exe;
      }
  throw new Error("ffmpeg not found: set FFMPEG to its path");
}
const FFMPEG = findFfmpeg();
function ffmpeg(argv) {
  return new Promise((done, fail) => {
    const p = spawn(
      FFMPEG,
      ["-hide_banner", "-loglevel", "error", "-y", ...argv],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) =>
      code === 0 ? done() : fail(new Error(`ffmpeg: ${err}`)),
    );
  });
}

// each beat fades in from the one before (0.3 s), built as one xfade chain
const FADE = 0.3;
const inputs = list.flatMap(({ file, seconds }) => [
  "-loop",
  "1",
  "-t",
  String(seconds + FADE),
  "-framerate",
  "30",
  "-i",
  file,
]);
let chain = "";
let last = "[0:v]";
let offset = 0;
for (let i = 1; i < list.length; i++) {
  offset += list[i - 1].seconds;
  const out = i === list.length - 1 ? "[v]" : `[x${i}]`;
  chain += `${last}[${i}:v]xfade=transition=fade:duration=${FADE}:offset=${offset.toFixed(2)}${out};`;
  last = out;
}
const total = list.reduce((a, b) => a + b.seconds, 0);
const mp4 = join(OUT, "agent-demo.mp4");
await ffmpeg([
  ...inputs,
  "-filter_complex",
  `${chain.slice(0, -1)};[v]format=yuv420p[o]`,
  "-map",
  "[o]",
  "-t",
  total.toFixed(2),
  "-r",
  "30",
  "-c:v",
  "libx264",
  "-preset",
  "slow",
  "-crf",
  "20",
  "-tune",
  "stillimage",
  "-movflags",
  "+faststart",
  mp4,
]);
const gif = join(OUT, "agent-demo.gif");
await ffmpeg([
  "-i",
  mp4,
  "-vf",
  "fps=8,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
  gif,
]);
for (const f of [mp4, gif])
  console.log(`${f}: ${(statSync(f).size / 1e6).toFixed(2)} MB`);
console.log(`${total.toFixed(1)} s`);
if (!flag("keep")) rmSync(work, { recursive: true, force: true });
else console.log(`frames kept in ${frames}`);
