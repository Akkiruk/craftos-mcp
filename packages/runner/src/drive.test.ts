import { describe, expect, it } from "vitest";
import { diffJson } from "./drive.js";

describe("diffJson", () => {
  it("reports changed values, additions and removals by path", () => {
    const diff = diffJson(
      { balances: { Alice: 100, Bob: 5 }, host: "Alice" },
      { balances: { Alice: 250, Carol: 1 }, host: "Alice" },
    );
    expect(diff).toEqual({
      "balances.Alice": { from: 100, to: 250 },
      "balances.Bob": { removed: 5 },
      "balances.Carol": { added: 1 },
    });
  });

  it("reports only the appended items of a growing list", () => {
    expect(
      diffJson({ ledger: [{ a: 1 }] }, { ledger: [{ a: 1 }, { a: 2 }] }),
    ).toEqual({
      ledger: { appended: [{ a: 2 }] },
    });
  });

  it("is empty when nothing changed", () => {
    expect(
      diffJson({ a: [1, 2], b: { c: 1 } }, { a: [1, 2], b: { c: 1 } }),
    ).toEqual({});
  });
});
