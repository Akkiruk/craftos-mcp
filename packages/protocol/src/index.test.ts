import { describe, expect, it } from "vitest";

import { protocolVersion } from "./index.js";

describe("protocol", () => {
  it("starts at a stable explicit version", () => {
    expect(protocolVersion).toBe(1);
  });
});
