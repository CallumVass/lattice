import { exec } from "node:child_process";
import type { Dirent, Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export type PostHookResult = { ok: true } | { ok: false; command: string; exitCode: number; output: string };

export interface RunPostHookOptions {
  commands: string[];
  cwd: string;
  /**
   * Optional callback invoked before each command runs. Used by the plugin
   * layer to surface progress to the user (otherwise the pipeline silently
   * blocks for the duration of the verify commands).
   */
  onCommandStart?: (command: string, index: number, total: number) => void | Promise<void>;
}

export type PostHookRunner = (options: RunPostHookOptions) => Promise<PostHookResult>;

interface WorkspaceSettleOptions {
  cwd: string;
  quietMs: number;
  pollMs?: number;
  timeoutMs?: number;
}

interface WorkspaceSettleResult {
  settled: boolean;
  latestMtimeMs: number;
}

const IGNORED_DIRS = new Set([".git", ".lattice", ".opencode", "bin", "coverage", "dist", "node_modules", "obj"]);

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function latestWorkspaceMtimeMs(dir: string): Promise<number> {
  let latest = 0;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return latest;
  }

  for (const entry of entries) {
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;

    const path = join(dir, entry.name);
    let stats: Stats;
    try {
      stats = await stat(path);
    } catch {
      continue;
    }

    latest = Math.max(latest, stats.mtimeMs);
    if (entry.isDirectory()) {
      latest = Math.max(latest, await latestWorkspaceMtimeMs(path));
    }
  }

  return latest;
}

/** Wait until source files have had no mtime changes for a quiet window. */
export async function waitForWorkspaceSettled(options: WorkspaceSettleOptions): Promise<WorkspaceSettleResult> {
  if (options.quietMs <= 0) {
    return { settled: true, latestMtimeMs: await latestWorkspaceMtimeMs(options.cwd) };
  }

  const startedAt = Date.now();
  const pollMs = options.pollMs ?? 1_000;
  const timeoutMs = options.timeoutMs ?? Math.max(options.quietMs * 6, options.quietMs + pollMs);

  while (Date.now() - startedAt < timeoutMs) {
    const latestMtimeMs = await latestWorkspaceMtimeMs(options.cwd);
    if (Date.now() - latestMtimeMs >= options.quietMs) {
      return { settled: true, latestMtimeMs };
    }
    await sleep(pollMs);
  }

  return { settled: false, latestMtimeMs: await latestWorkspaceMtimeMs(options.cwd) };
}

/**
 * Run post-hook commands sequentially. Stop at the first non-zero exit and
 * return its captured output (stdout + stderr). The lattice plugin owns this
 * side effect — the engine layer stays free of shell execution.
 */
export async function runPostHook(options: RunPostHookOptions): Promise<PostHookResult> {
  for (let i = 0; i < options.commands.length; i++) {
    const command = options.commands[i];
    if (!command) continue;
    if (options.onCommandStart) {
      await options.onCommandStart(command, i, options.commands.length);
    }
    try {
      await execAsync(command, { cwd: options.cwd });
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
      const stdout = (e.stdout ?? "").toString();
      const stderr = (e.stderr ?? "").toString();
      const output =
        [stdout, stderr]
          .filter((s) => s.length > 0)
          .join("\n")
          .trim() ||
        (e.message ?? "command failed");
      return {
        ok: false,
        command,
        exitCode: typeof e.code === "number" ? e.code : 1,
        output,
      };
    }
  }
  return { ok: true };
}
