import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPostHook } from "./post-hook.js";

let cwd: string;

beforeEach(async () => {
  cwd = join(tmpdir(), `lattice-post-hook-${Date.now()}-${Math.random()}`);
  await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("runPostHook", () => {
  it("returns ok when all commands succeed", async () => {
    const result = await runPostHook({ commands: ["true", "echo hi"], cwd });
    expect(result).toEqual({ ok: true });
  });

  it("stops at the first failing command and reports output", async () => {
    const result = await runPostHook({
      commands: ["true", "echo boom && exit 2", "echo unreached"],
      cwd,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.command).toBe("echo boom && exit 2");
      expect(result.exitCode).toBe(2);
      expect(result.output).toContain("boom");
    }
  });

  it("captures stderr output on failure", async () => {
    const result = await runPostHook({
      commands: ["node -e \"console.error('stderr-marker'); process.exit(1)\""],
      cwd,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.output).toContain("stderr-marker");
    }
  });

  it("runs commands in the provided cwd", async () => {
    const result = await runPostHook({ commands: ["pwd"], cwd });
    expect(result).toEqual({ ok: true });
  });
});
