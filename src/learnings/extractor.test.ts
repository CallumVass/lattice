import { describe, expect, it } from "vitest";
import { learningEntrySchema } from "../schema/index.js";
import { extractFromFindings } from "./extractor.js";

const COMPOSER_OUTPUT = `FINDINGS

## Blocking

### Finding: Null check missing on user.email
- **File**: \`src/auth/login.ts:42\`
- **Severity**: critical
- **Confidence**: 95
- **Code**: \`user.email.toLowerCase()\`
- **Issue**: user can be null when token verification fails
- **Fix**: guard with \`if (!user) return\` before dereferencing

### Finding: SQL injection in raw query
- **File**: \`src/db/users.ts:118\`
- **Severity**: high
- **Confidence**: 90
- **Code**: \`db.query(\\\`SELECT * FROM users WHERE id=\${id}\\\`)\`
- **Issue**: id is interpolated directly
- **Fix**: use a parameterised query

## Advisory

### Finding: Reuse existing slugify helper
- **File**: \`src/util/route.ts:14\`
- **Severity**: advisory
- **Confidence**: 85
- **Issue**: a slugify helper already lives in src/util/strings.ts
- **Fix**: import the existing helper instead of duplicating
`;

const ALT_FORMAT_OUTPUT = `FINDINGS

## Blocking

### Finding: Missing await on async call
File: src/api/handler.ts:88
Severity: medium
Confidence: 70%
Issue: the call returns a promise that is never awaited
Fix: add await
`;

describe("extractFromFindings", () => {
  it("parses the composer's standard format into one entry per finding", () => {
    const entries = extractFromFindings(COMPOSER_OUTPUT, {
      stageId: "propose-comments",
      goal: "https://github.com/acme/widgets/pull/472",
    });

    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      expect(() => learningEntrySchema.parse(entry)).not.toThrow();
      expect(entry.source.pr).toBe("acme/widgets#472");
      expect(entry.source.stageId).toBe("propose-comments");
    }

    const blocking = entries.filter((e) => e.severity === "blocking");
    const advisory = entries.filter((e) => e.severity === "advisory");
    expect(blocking).toHaveLength(2);
    expect(advisory).toHaveLength(1);

    const nullCheck = entries[0];
    expect(nullCheck?.pattern).toBe("Null check missing on user.email");
    expect(nullCheck?.category).toBe("auth");
    expect(nullCheck?.confidence).toBeCloseTo(0.95, 5);
    expect(nullCheck?.description).toContain("Fix:");
  });

  it("parses an alternate format without bold markers", () => {
    const entries = extractFromFindings(ALT_FORMAT_OUTPUT, {
      stageId: "propose-comments",
      goal: "Review PR #15",
    });

    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(() => learningEntrySchema.parse(entry)).not.toThrow();
    expect(entry?.pattern).toBe("Missing await on async call");
    expect(entry?.severity).toBe("blocking");
    expect(entry?.confidence).toBeCloseTo(0.7, 5);
    expect(entry?.source.pr).toBe("#15");
  });

  it("returns [] for NO_FINDINGS", () => {
    expect(extractFromFindings("NO_FINDINGS", { stageId: "propose-comments" })).toEqual([]);
    expect(extractFromFindings("  NO_FINDINGS\n", { stageId: "propose-comments" })).toEqual([]);
  });

  it("skips malformed findings without throwing", () => {
    const malformed = `FINDINGS

## Blocking

### Finding:
- nothing here

### Finding: real one
- **File**: \`src/x.ts:1\`
- **Severity**: critical
- **Confidence**: 90
- **Issue**: it's broken
`;
    const entries = extractFromFindings(malformed, { stageId: "propose-comments" });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries.some((e) => e.pattern === "real one")).toBe(true);
  });

  it("returns [] for unparseable junk", () => {
    expect(extractFromFindings("totally not a findings report", { stageId: "propose-comments" })).toEqual([]);
  });

  it("defaults blocking/advisory entries to agent '*' so all consumers see them", () => {
    const entries = extractFromFindings(COMPOSER_OUTPUT, { stageId: "propose-comments" });
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.agent).toBe("*");
    }
  });

  it("respects an explicit source.agent override", () => {
    const entries = extractFromFindings(ALT_FORMAT_OUTPUT, { stageId: "propose-comments", agent: "code-reviewer" });
    expect(entries[0]?.agent).toBe("code-reviewer");
  });
});
