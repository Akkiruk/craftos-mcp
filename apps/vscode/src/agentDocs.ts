// The instruction files other coding agents read (AGENTS.md, Codex and Copilot skills, Copilot's instructions, a Cursor
// rule, GEMINI.md, the Claude Code skill), as esbuild.mjs bundled them from scripts/build-agent-docs.mjs's output, and
// what writing one into a folder that may already have that file does. No vscode import, so the unit tests load it in
// plain Node; agentDocsCommand.ts asks the questions.

export interface AgentDoc {
  readonly id: string;
  /** Shown in the picker: "AGENTS.md", "Cursor rule". */
  readonly label: string;
  readonly detail: string;
  /** Relative to the workspace folder, with forward slashes. */
  readonly path: string;
  /** Whether adding it to the end of someone's own file makes sense (not for a file with its own frontmatter). */
  readonly append: boolean;
  readonly content: string;
}

declare const __CRAFTOS_AGENT_DOCS__: AgentDoc[] | undefined;

export const AGENT_DOCS: readonly AgentDoc[] =
  typeof __CRAFTOS_AGENT_DOCS__ !== "undefined" ? __CRAFTOS_AGENT_DOCS__ : [];

/** What to do with a file that is already there and says something else. */
export type Conflict = "append" | "overwrite" | "skip";

export type WritePlan =
  | { action: "create" | "append" | "overwrite"; text: string }
  | { action: "same" }
  | { action: "skip" }
  /** The file is there and differs: ask, then plan again with the answer. */
  | { action: "ask" };

const norm = (text: string) => text.replace(/\r\n/g, "\n");

/**
 * What writing `doc` over `existing` (undefined: no file yet) comes to. A file that already has the text, whole or
 * appended earlier, is left as it is; anything else is only changed with an answer.
 */
export function planWrite(
  existing: string | undefined,
  doc: Pick<AgentDoc, "content" | "append">,
  answer?: Conflict,
): WritePlan {
  if (existing === undefined) return { action: "create", text: doc.content };
  const have = norm(existing);
  const want = norm(doc.content);
  if (have === want || have.includes(want.trim())) return { action: "same" };
  if (!answer) return { action: "ask" };
  if (answer === "skip") return { action: "skip" };
  if (answer === "append" && doc.append) {
    const base = have.trimEnd();
    return { action: "append", text: base ? `${base}\n\n${want}` : want };
  }
  if (answer === "append") return { action: "skip" };
  return { action: "overwrite", text: want };
}

/** The answers a conflict offers for this file. */
export function conflictChoices(doc: Pick<AgentDoc, "append">): Conflict[] {
  return doc.append ? ["append", "overwrite", "skip"] : ["overwrite", "skip"];
}
