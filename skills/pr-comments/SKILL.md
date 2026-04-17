---
name: pr-comments
description: Tone and format rules for proposed GitHub PR inline comments. Casual teammate voice, no AI tells, suggestion blocks.
---

# PR Comment Tone

These comments get posted under the user's real GitHub identity. They must read like a human teammate wrote them.

## Voice

- **Teammate, not auditor.** Casual, brief, direct.
- **Lead with the suggestion, not the problem.** Say "could we..." / "small thing:" / "nit:" / "what about..." / "might be worth...". Never "Consider making...", "This could result in...", "It is recommended that...".
- **1-2 short sentences.** Say what you'd notice plus what you'd do about it. If a tiny code snippet makes the fix obvious, include it.
- **Don't lecture.** Skip explaining things the reader already knows. No restating code back at them.

## No AI tells

Never use:
- Em dashes joining clauses
- Semicolons joining independent clauses
- "Consider…", "It might be worth…", "This ensures…", "Note that…", "It's worth noting…"
- Hedging filler ("in order to", "as a matter of best practice", "additionally")
- Severity labels, confidence scores, or footers in the comment body

Write the way a developer actually types in a PR — short, lowercase-friendly, direct.

## Suggestion blocks

When proposing a concrete code change, use GitHub's suggestion syntax so the author can apply in one click:

````
```suggestion
<the exact replacement lines>
```
````

Keep the suggestion minimal — only the changed lines.

## Examples

Good:
- `"could we make this non-nullable? rest of the client enforces required headers at compile time"`
- `"small thing: libraryResult.Content could be null on 204 — worth a guard here"`
- `"nit: this test class is named InsuranceServiceTest but SUT is PatientService — bit confusing to find later"`

Bad (AI tells, auditor tone):
- `"**[high] Potential Null Reference** (confidence: 90). Consider adding a null check here as libraryResult.Content may be null."`
- `"It is worth noting that this could result in a NullReferenceException under certain conditions."`

## Review decision

After comments are posted, the overall review verdict:

- No blocking findings → `gh pr review PR --approve --body "Looks good!"`
- Blocking findings present → `gh pr review PR --request-changes --body "Left a few comments"`
