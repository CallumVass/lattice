import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { type LearningEntry, learningEntrySchema } from "../schema/index.js";

export interface StorageOptions {
  projectDir: string;
  storePath: string;
}

function resolveStorePath(opts: StorageOptions): string {
  return isAbsolute(opts.storePath) ? opts.storePath : join(opts.projectDir, opts.storePath);
}

export async function append(entry: LearningEntry, opts: StorageOptions): Promise<void> {
  const path = resolveStorePath(opts);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`);
}

/**
 * Replace the entire store with `entries`. Used by compaction and feedback
 * updates where an in-place rewrite is simpler than reconstructing delta
 * semantics across an append-only log.
 */
export async function writeAll(entries: LearningEntry[], opts: StorageOptions): Promise<void> {
  const path = resolveStorePath(opts);
  await mkdir(dirname(path), { recursive: true });
  const body = entries.map((e) => JSON.stringify(e)).join("\n");
  await writeFile(path, entries.length === 0 ? "" : `${body}\n`);
}

export async function readAll(opts: StorageOptions): Promise<LearningEntry[]> {
  const path = resolveStorePath(opts);
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return [];
  }
  const entries: LearningEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const parsed = learningEntrySchema.safeParse(json);
    if (parsed.success) entries.push(parsed.data);
  }
  return entries;
}

export async function count(opts: StorageOptions): Promise<{ entries: number; lastCapturedAt?: string }> {
  const entries = await readAll(opts);
  const last = entries.at(-1);
  return last ? { entries: entries.length, lastCapturedAt: last.lastSeenAt } : { entries: entries.length };
}

export async function exists(opts: StorageOptions): Promise<boolean> {
  try {
    await stat(resolveStorePath(opts));
    return true;
  } catch {
    return false;
  }
}

/**
 * Append `relPath` to `.gitignore` if not already present. Idempotent.
 * Matches whole lines so substring matches don't suppress the append.
 */
export async function ensureGitignored(projectDir: string, relPath: string): Promise<void> {
  const gitignorePath = join(projectDir, ".gitignore");
  let current = "";
  try {
    current = await readFile(gitignorePath, "utf-8");
  } catch {
    // gitignore doesn't exist yet — create it
  }

  const lines = current.split("\n").map((l) => l.trim());
  if (lines.includes(relPath)) return;

  const needsNewline = current.length > 0 && !current.endsWith("\n");
  const addition = `${needsNewline ? "\n" : ""}${relPath}\n`;
  await writeFile(gitignorePath, current + addition);
}
