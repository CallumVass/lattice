import { describe, expect, it } from "vitest";
import lattice, { pipeline } from "./index.js";

describe("package root exports", () => {
  it("exports the plugin as the default export", () => {
    expect(lattice).toMatchObject({ id: "lattice" });
    expect(typeof lattice.server).toBe("function");
  });

  it("preserves named library exports", () => {
    expect(typeof pipeline).toBe("function");
  });
});
