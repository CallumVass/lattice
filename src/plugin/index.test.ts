import { describe, expect, it } from "vitest";
import { registerLatticeCommands } from "./index.js";

describe("registerLatticeCommands", () => {
  it("registers only /lattice and generated pipeline commands", () => {
    const config: { command?: Record<string, { description?: string; template: string }> } = {};

    registerLatticeCommands(config, ["quick-fix", "review"]);

    expect(Object.keys(config.command ?? {}).sort()).toEqual(["lattice", "quick-fix", "review"]);
    expect(config.command?.lattice?.template).toContain("lattice_control");
    expect(config.command?.["quick-fix"]?.template).toContain('action "run"');
    expect(config.command?.review?.template).toContain('pipeline "review"');

    for (const removed of [
      "lattice-status",
      "lattice-abort",
      "lattice-approve",
      "lattice-retry",
      "lattice-proceed",
      "lattice-reset",
    ]) {
      expect(config.command).not.toHaveProperty(removed);
    }
  });
});
