import type { LearningEntry } from "../schema/index.js";

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "if",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "was",
  "with",
  "you",
  "this",
  "these",
  "those",
]);

const FILE_TOKEN = /\b([\w./-]+\.[a-z]{1,5})(?::(\d+))?\b/i;

function extractFileHint(pattern: string): string | undefined {
  const match = pattern.match(FILE_TOKEN);
  return match?.[1];
}

function normalizeTokens(pattern: string): Set<string> {
  const tokens = pattern
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
  return new Set(tokens);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function groupKey(entry: LearningEntry): string {
  const fileHint = extractFileHint(entry.pattern) ?? "";
  return `${entry.category}::${fileHint}`;
}

function mergeSources(a: LearningEntry["source"], b: LearningEntry["source"]): LearningEntry["source"] {
  const prs = [a.pr, b.pr].filter((p): p is string => Boolean(p));
  const dedupedPrs = Array.from(new Set(prs));
  return {
    stageId: a.stageId,
    date: a.date < b.date ? a.date : b.date,
    pr: dedupedPrs.length === 0 ? undefined : dedupedPrs.join(", "),
  };
}

function mergeInto(existing: LearningEntry, incoming: LearningEntry): LearningEntry {
  return {
    ...existing,
    confidence: Math.max(existing.confidence, incoming.confidence),
    usageCount: existing.usageCount + incoming.usageCount,
    reinforcementCount: existing.reinforcementCount + incoming.reinforcementCount,
    feedbackScore: Math.max(existing.feedbackScore, incoming.feedbackScore),
    createdAt: existing.createdAt < incoming.createdAt ? existing.createdAt : incoming.createdAt,
    lastSeenAt: existing.lastSeenAt > incoming.lastSeenAt ? existing.lastSeenAt : incoming.lastSeenAt,
    source: mergeSources(existing.source, incoming.source),
    description: existing.description ?? incoming.description,
    expiresAt:
      existing.expiresAt && incoming.expiresAt
        ? existing.expiresAt > incoming.expiresAt
          ? existing.expiresAt
          : incoming.expiresAt
        : undefined,
  };
}

interface CompactOptions {
  similarityThreshold?: number;
}

/**
 * Heuristic dedup: group by `(category, fileHint)` then within each group
 * merge entries whose normalized-token Jaccard similarity meets the threshold.
 * Preserves ordering of first-seen entries to keep `compact(compact(xs))`
 * stable (idempotency guarantee called out in the phase spec).
 */
export function compact(
  entries: LearningEntry[],
  options: CompactOptions = {},
): { kept: LearningEntry[]; merged: number } {
  const threshold = options.similarityThreshold ?? 0.7;
  const kept: LearningEntry[] = [];
  const tokenCache = new Map<string, Set<string>>();
  let merged = 0;

  const tokensFor = (entry: LearningEntry): Set<string> => {
    let tokens = tokenCache.get(entry.id);
    if (!tokens) {
      tokens = normalizeTokens(entry.pattern);
      tokenCache.set(entry.id, tokens);
    }
    return tokens;
  };

  for (const entry of entries) {
    const key = groupKey(entry);
    const entryTokens = tokensFor(entry);
    const groupMember = kept.find((k) => {
      if (groupKey(k) !== key) return false;
      if (k.severity !== entry.severity) return false;
      if (k.agent !== entry.agent) return false;
      return jaccard(tokensFor(k), entryTokens) >= threshold;
    });

    if (groupMember) {
      const index = kept.indexOf(groupMember);
      kept[index] = mergeInto(groupMember, entry);
      tokenCache.set(kept[index]?.id ?? groupMember.id, tokensFor(groupMember));
      merged += 1;
    } else {
      kept.push(entry);
    }
  }

  return { kept, merged };
}

/**
 * Locate an existing entry whose pattern matches `candidate` closely enough
 * to reinforce rather than duplicate. Mirrors `compact()`'s grouping rules so
 * the extractor's live reinforcement path and the on-start compaction pass
 * agree on which entries are "the same finding".
 */
export function findReinforcementTarget(
  entries: LearningEntry[],
  candidate: LearningEntry,
  options: CompactOptions = {},
): LearningEntry | undefined {
  const threshold = options.similarityThreshold ?? 0.7;
  const candidateKey = groupKey(candidate);
  const candidateTokens = normalizeTokens(candidate.pattern);
  return entries.find((existing) => {
    if (existing.id === candidate.id) return false;
    if (groupKey(existing) !== candidateKey) return false;
    if (existing.severity !== candidate.severity) return false;
    if (existing.agent !== candidate.agent) return false;
    return jaccard(normalizeTokens(existing.pattern), candidateTokens) >= threshold;
  });
}
