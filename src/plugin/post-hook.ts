import { exec } from "node:child_process";
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
