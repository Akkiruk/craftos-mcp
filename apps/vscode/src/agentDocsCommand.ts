// Add Agent Instructions to Workspace: pick which agents' instruction files to write (agentDocs.ts), write them into a
// workspace folder, and ask before changing any file that is already there.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as vscode from "vscode";
import {
  AGENT_DOCS,
  type Conflict,
  conflictChoices,
  planWrite,
} from "./agentDocs";

const ANSWER_LABELS: Record<Conflict, string> = {
  append: "Append",
  overwrite: "Overwrite",
  skip: "Skip",
};

async function pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter(
    (f) => f.uri.scheme === "file",
  );
  if (folders.length <= 1) return folders[0];
  return vscode.window.showWorkspaceFolderPick({
    placeHolder: "Which folder gets the agent instructions?",
  });
}

export async function addAgentInstructions(
  output: vscode.OutputChannel,
): Promise<void> {
  if (!AGENT_DOCS.length) {
    void vscode.window.showErrorMessage(
      "This build of craftos-mcp has no agent instructions to add.",
    );
    return;
  }
  const folder = await pickFolder();
  if (!folder) {
    void vscode.window.showErrorMessage(
      "Add Agent Instructions needs a folder open.",
    );
    return;
  }
  const picked = await vscode.window.showQuickPick(
    AGENT_DOCS.map((doc) => ({
      label: doc.label,
      description: doc.path,
      detail: doc.detail === doc.path ? undefined : doc.detail,
      picked: true,
      doc,
    })),
    {
      canPickMany: true,
      title: "Add Agent Instructions to Workspace",
      placeHolder:
        "Which agents should learn how to use the CC:Tweaked emulator?",
    },
  );
  if (!picked?.length) return;
  const written: string[] = [];
  for (const { doc } of picked) {
    const file = join(folder.uri.fsPath, ...doc.path.split("/"));
    const existing = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    let plan = planWrite(existing, doc);
    if (plan.action === "ask") {
      const choices = conflictChoices(doc);
      const answer = await vscode.window.showWarningMessage(
        `${doc.path} is already there and says something else.`,
        {
          modal: true,
          detail: doc.append
            ? "Append adds the craftos-mcp instructions at its end; Overwrite replaces the whole file."
            : "Overwrite replaces the whole file.",
        },
        ...choices.map((c) => ANSWER_LABELS[c]),
      );
      const chosen = choices.find((c) => ANSWER_LABELS[c] === answer) ?? "skip";
      plan = planWrite(existing, doc, chosen);
    }
    if (
      plan.action === "same" ||
      plan.action === "skip" ||
      plan.action === "ask"
    ) {
      output.appendLine(
        `agent instructions: ${doc.path}: ${plan.action === "same" ? "already up to date" : "skipped"}`,
      );
      continue;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, plan.text);
    output.appendLine(
      `agent instructions: ${doc.path}: ${plan.action === "create" ? "written" : plan.action}`,
    );
    written.push(doc.path);
  }
  if (!written.length) {
    void vscode.window.showInformationMessage(
      "No agent instruction files changed.",
    );
    return;
  }
  const open = "Open";
  const pick = await vscode.window.showInformationMessage(
    `Wrote ${written.join(", ")} in ${folder.name}.`,
    open,
  );
  if (pick === open)
    await vscode.window.showTextDocument(
      vscode.Uri.file(join(folder.uri.fsPath, ...written[0]!.split("/"))),
    );
}
