import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { loadConfig } from "./loader.js";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

const mockReadFile = readFile as Mock;

beforeEach(() => {
  vi.resetAllMocks();
});

describe("loadConfig", () => {
  it("returns empty config when no files exist", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    const config = await loadConfig("/project");

    expect(config).toEqual({
      agents: {},
      pipelines: {},
      skills: undefined,
    });
  });

  it("loads project config", async () => {
    mockReadFile.mockImplementation((path: string) => {
      if (path === join("/project", ".lattice", "config.jsonc")) {
        return Promise.resolve(
          JSON.stringify({
            agents: { implementor: { model: "anthropic/claude-sonnet-4-20250514" } },
          }),
        );
      }
      return Promise.reject(new Error("ENOENT"));
    });

    const config = await loadConfig("/project");

    expect(config.agents?.implementor).toEqual({ model: "anthropic/claude-sonnet-4-20250514" });
  });

  it("merges global and project config with project taking precedence", async () => {
    mockReadFile.mockImplementation((path: string) => {
      if (path.includes(".config/lattice")) {
        return Promise.resolve(
          JSON.stringify({
            agents: {
              planner: { model: "anthropic/claude-haiku-4-5-20251001" },
              implementor: { model: "anthropic/claude-haiku-4-5-20251001" },
            },
          }),
        );
      }
      if (path.includes(".lattice/config.jsonc")) {
        return Promise.resolve(
          JSON.stringify({
            agents: { implementor: { model: "anthropic/claude-sonnet-4-20250514" } },
          }),
        );
      }
      return Promise.reject(new Error("ENOENT"));
    });

    const config = await loadConfig("/project");

    expect(config.agents?.planner).toEqual({ model: "anthropic/claude-haiku-4-5-20251001" });
    expect(config.agents?.implementor).toEqual({ model: "anthropic/claude-sonnet-4-20250514" });
  });

  it("strips JSONC comments", async () => {
    mockReadFile.mockImplementation((path: string) => {
      if (path.includes(".lattice/config.jsonc")) {
        return Promise.resolve(`{
          // this is a comment
          "agents": {
            "planner": { "model": "anthropic/claude-sonnet-4-20250514" } /* inline */
          }
        }`);
      }
      return Promise.reject(new Error("ENOENT"));
    });

    const config = await loadConfig("/project");

    expect(config.agents?.planner).toEqual({ model: "anthropic/claude-sonnet-4-20250514" });
  });
});
