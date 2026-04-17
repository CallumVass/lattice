import type { LearningEntry } from "../schema/index.js";
import { applyVerdict, type DecayConfig, type FeedbackVerdict } from "./decay.js";
import { readAll, type StorageOptions, writeAll } from "./storage.js";

function shortId(entry: LearningEntry): string {
  return entry.id.length > 8 ? entry.id.slice(0, 8) : entry.id;
}

function idMatches(entry: LearningEntry, id: string): boolean {
  return entry.id === id || shortId(entry) === id;
}

interface ApplyFeedbackOptions {
  now?: () => Date;
  decay: DecayConfig;
}

/**
 * Locate the target entry (by full uuid or short 8-char id), apply the
 * verdict transform, and rewrite the store. Returns the updated entry so
 * the caller can surface a concrete confirmation in chat.
 */
export async function applyFeedback(
  id: string,
  verdict: FeedbackVerdict,
  storage: StorageOptions,
  options: ApplyFeedbackOptions,
): Promise<LearningEntry | undefined> {
  const entries = await readAll(storage);
  const index = entries.findIndex((e) => idMatches(e, id));
  if (index === -1) return undefined;

  const now = (options.now ?? (() => new Date()))();
  const existing = entries[index];
  if (!existing) return undefined;
  const updated = applyVerdict(existing, verdict, now, options.decay);
  entries[index] = updated;
  await writeAll(entries, storage);
  return updated;
}
