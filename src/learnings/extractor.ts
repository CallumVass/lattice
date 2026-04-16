import { randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";
import type { LearningEntry, LearningSeverity } from "../schema/index.js";

interface ExtractSource {
  stageId: string;
  goal?: string;
  agent?: string;
  now?: () => Date;
}

interface RawFinding {
  section: "blocking" | "advisory";
  title?: string;
  file?: string;
  line?: number;
  severity?: string;
  confidence?: number;
  code?: string;
  issue?: string;
  fix?: string;
}

const FINDING_HEADING = /^#{2,6}\s*Finding:\s*(.+?)\s*$/i;
const SECTION_BLOCKING = /^##\s+Blocking\s*$/i;
const SECTION_ADVISORY = /^##\s+Advisory\s*$/i;

const FIELD_PATTERNS: Array<{ key: keyof RawFinding; pattern: RegExp }> = [
  { key: "file", pattern: /^[-*]?\s*\**file\**\s*[:\-—]\s*(.+?)\s*$/i },
  { key: "severity", pattern: /^[-*]?\s*\**severity\**\s*[:\-—]\s*(.+?)\s*$/i },
  { key: "confidence", pattern: /^[-*]?\s*\**confidence\**\s*[:\-—]\s*(.+?)\s*$/i },
  { key: "code", pattern: /^[-*]?\s*\**code\**\s*[:\-—]\s*(.+?)\s*$/i },
  { key: "issue", pattern: /^[-*]?\s*\**issue\**\s*[:\-—]\s*(.+?)\s*$/i },
  { key: "fix", pattern: /^[-*]?\s*\**fix\**\s*[:\-—]\s*(.+?)\s*$/i },
];

function stripBackticks(value: string): string {
  return value.replace(/^`+|`+$/g, "").trim();
}

function parseFileAndLine(value: string): { file?: string; line?: number } {
  const cleaned = stripBackticks(value).replace(/[()]/g, "").trim();
  if (!cleaned) return {};
  const match = cleaned.match(/^([^\s:]+(?::[^\s:]+)*?):(\d+)/);
  if (match) {
    return { file: match[1], line: Number(match[2]) };
  }
  return { file: cleaned };
}

function parseConfidence(value: string): number | undefined {
  const cleaned = stripBackticks(value).replace(/[%]/g, "").trim();
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return undefined;
  if (num <= 1) return Math.max(0, Math.min(1, num));
  return Math.max(0, Math.min(1, num / 100));
}

function mapSeverity(raw: string | undefined, section: "blocking" | "advisory"): LearningSeverity {
  if (section === "advisory") return "advisory";
  const normalized = raw?.trim().toLowerCase();
  if (normalized === "advisory") return "advisory";
  return "blocking";
}

function deriveCategory(finding: RawFinding): string {
  if (finding.file) {
    const dir = dirname(finding.file);
    if (dir && dir !== "." && dir !== "/") {
      const segments = dir.split(/[/\\]/).filter((s) => s && s !== "src");
      const last = segments.at(-1);
      if (last) return last;
    }
    const base = basename(finding.file).split(".")[0];
    if (base) return base;
  }
  const titleWord = finding.title?.toLowerCase().match(/[a-z0-9]+/)?.[0];
  return titleWord ?? "general";
}

function extractPrFromGoal(goal: string | undefined): string | undefined {
  if (!goal) return undefined;
  const url = goal.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i);
  if (url) return `${url[1]}/${url[2]}#${url[3]}`;
  const hash = goal.match(/(?:^|\s)#?(\d{1,7})\b/);
  if (hash) return `#${hash[1]}`;
  return undefined;
}

function buildEntry(raw: RawFinding, source: ExtractSource): LearningEntry | undefined {
  const title = raw.title?.trim();
  const issue = raw.issue?.trim();
  if (!title && !issue) return undefined;

  const pattern = title ?? issue ?? "";
  const descriptionParts = [
    raw.code ? `Code: ${stripBackticks(raw.code)}` : undefined,
    raw.issue && raw.issue !== pattern ? `Issue: ${raw.issue}` : undefined,
    raw.fix ? `Fix: ${raw.fix}` : undefined,
  ].filter(Boolean) as string[];

  const now = (source.now ?? (() => new Date()))().toISOString();
  const severity = mapSeverity(raw.severity, raw.section);
  const confidence = raw.confidence ?? 0.8;
  const pr = extractPrFromGoal(source.goal);

  return {
    id: randomUUID(),
    agent: source.agent ?? "code-reviewer",
    pattern,
    description: descriptionParts.length ? descriptionParts.join("\n") : undefined,
    category: deriveCategory(raw),
    severity,
    source: {
      pr,
      stageId: source.stageId,
      date: now,
    },
    confidence,
    usageCount: 0,
    feedbackScore: 0,
    reinforcementCount: 0,
    createdAt: now,
    lastSeenAt: now,
  };
}

/**
 * Parse the composer's combined FINDINGS report into structured entries.
 * Tolerant of formatting drift: missing fields, alternate header levels,
 * `**bold**` or plain field labels, and stray punctuation are all accepted.
 * Returns `[]` for `NO_FINDINGS` or any input the parser cannot interpret.
 */
export function extractFromFindings(text: string, source: ExtractSource): LearningEntry[] {
  if (!text || /^\s*NO_FINDINGS\s*$/i.test(text)) return [];

  const lines = text.split("\n");
  let section: "blocking" | "advisory" = "blocking";
  let current: RawFinding | undefined;
  const findings: RawFinding[] = [];

  function commit() {
    if (current) findings.push(current);
    current = undefined;
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (SECTION_BLOCKING.test(line)) {
      commit();
      section = "blocking";
      continue;
    }
    if (SECTION_ADVISORY.test(line)) {
      commit();
      section = "advisory";
      continue;
    }
    const findingMatch = line.match(FINDING_HEADING);
    if (findingMatch) {
      commit();
      current = { section, title: findingMatch[1] };
      continue;
    }
    if (!current) continue;

    for (const { key, pattern } of FIELD_PATTERNS) {
      const match = line.match(pattern);
      if (!match) continue;
      const value = match[1] ?? "";
      if (key === "file") {
        const { file, line: lineNum } = parseFileAndLine(value);
        if (file) current.file = file;
        if (lineNum !== undefined) current.line = lineNum;
      } else if (key === "confidence") {
        const conf = parseConfidence(value);
        if (conf !== undefined) current.confidence = conf;
      } else if (key === "code") {
        current.code = stripBackticks(value);
      } else if (key === "severity") {
        current.severity = value;
      } else if (key === "issue") {
        current.issue = value;
      } else if (key === "fix") {
        current.fix = value;
      }
      break;
    }
  }
  commit();

  const entries: LearningEntry[] = [];
  for (const raw of findings) {
    const entry = buildEntry(raw, source);
    if (entry) entries.push(entry);
  }
  return entries;
}
