import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export type PostHookResult = { ok: true } | { ok: false; command: string; exitCode: number; output: string };

export interface RunPostHookOptions {
  commands: string[];
  cwd: string;
}

export type PostHookRunner = (options: RunPostHookOptions) => Promise<PostHookResult>;

/**
 * Run post-hook commands sequentially. Stop at the first non-zero exit and
 * return its captured output (stdout + stderr). The lattice plugin owns this
 * side effect — the engine layer stays free of shell execution.
 */
export async function runPostHook(options: RunPostHookOptions): Promise<PostHookResult> {
  for (const command of options.commands) {
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
