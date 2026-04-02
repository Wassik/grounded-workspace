# investigate Command Spec

## Goal

Add a command that turns one-shot retrieval into a short investigation workflow.

Current `ask` behavior is useful for finding relevant excerpts. The new `investigate` command should help answer a broader question by running a small set of targeted retrieval passes and organizing the result into an action-oriented summary.

## Proposed CLI

```bash
node ./src/cli.js investigate [dir] <question>
```

Examples:

```bash
node ./src/cli.js investigate . "how do profile defaults work"
node ./src/cli.js investigate . "where is theme alias resolution implemented"
node ./src/cli.js investigate . "how does indexing interact with ignore rules"
node ./src/cli.js investigate . "how do profile defaults work" --refresh-if-stale
node ./src/cli.js investigate . "how do profile defaults work" --output-file ./report.md
node ./src/cli.js investigate . "how do profile defaults work" --output-file ./report.md --json
```

Current flags:

- `--json`
- `--max-files <n>`
- `--max-evidence <n>`
- `--include-raw`
- `--refresh-index`
- `--refresh-if-stale`
- `--live`
- `--output-file <path>`
- `--metadata-file <path>`
- `--manifest-json`

Constraints:

- `--live` cannot be combined with `--refresh-index`
- `--live` cannot be combined with `--refresh-if-stale`
- when `--json` is used with `--output-file`, the written path is normalized to a `.json` extension

## Primary Output

The command should return four sections:

1. `Summary`
   - A short grounded answer synthesized from the strongest matches.
2. `Key Files`
   - The most relevant files to read next, ordered by evidence strength.
3. `Evidence`
   - The strongest excerpts, grouped by file.
4. `Gaps`
   - Missing information, ambiguity, or conflicting evidence.

## Output Shape

Text output should be concise and scannable.

Example:

```text
Summary:
  Profile defaults are resolved in src/cli.js by layering user, env, and preview CLI defaults, then applying output-specific rewrites.

Key files:
  1. src/cli.js
  2. test/indexer.test.js
  3. README.md

Evidence:
  src/cli.js: resolveCommandDefaults merges cli over env over user.
  src/cli.js: resolveEffectiveAskOutputDefaults rewrites highlight mode by output format.
  test/indexer.test.js: coverage verifies preview flags and source attribution.

Gaps:
  No separate module isolates default-resolution logic yet.
```

JSON output should expose the same structure in machine-readable form:

```json
{
  "root": "/path/to/workspace",
  "question": "how do profile defaults work",
  "source": "index",
  "sourceReason": "loaded saved index",
  "sourceMode": "index",
  "summary": "Strongest grounded evidence for \"how do profile defaults work\" is in src/cli.js, then README.md.",
  "keyFiles": [
    { "path": "src/cli.js", "score": 42.1, "evidenceCount": 2 },
    { "path": "test/indexer.test.js", "score": 17.4, "evidenceCount": 1 }
  ],
  "evidence": [
    {
      "path": "src/cli.js",
      "chunk": { "startLine": 1087, "endLine": 1128 },
      "score": 42.1,
      "kind": "implementation",
      "reason": "implementation bias; matched terms: profile, defaults",
      "why": {
        "matchedTerms": ["profile", "defaults"],
        "phraseHits": [],
        "pathHits": []
      },
      "queries": ["how do profile defaults work"],
      "excerpt": "..."
    }
  ],
  "gaps": [
    "No dedicated defaults module exists."
  ]
}
```

## Retrieval Strategy

The first implementation should stay simple.

1. Accept the user question as the seed query.
2. Derive a small query set:
   - raw question
   - significant term query
   - path-biased query when obvious file hints exist
3. Run the existing retrieval pipeline for each query.
4. Merge duplicate or overlapping hits.
5. Score files by combined evidence.
6. Generate a compact summary from the top evidence only.

The command should not require embeddings, external services, or a new index format.

## Non-Goals

The first version should not:

- edit files
- generate a multi-step implementation plan
- claim certainty when evidence is weak
- replace direct file reading before code changes
- introduce semantic/vector search

## Implementation Notes

Likely placement in the current codebase:

- command handling in `src/cli.js`
- output formatter alongside `formatAskOutput` and `formatProfilesOutput`
- tests in `test/indexer.test.js`

Initial internal helpers could include:

- `deriveInvestigationQueries(question)`
- `mergeInvestigationHits(results)`
- `rankInvestigationFiles(hits)`
- `formatInvestigateOutput(payload, outputFormat)`

## Phased Rollout

Phase 1:

- text output only
- reuse existing retrieval logic
- group evidence by file
- emit a minimal grounded summary

Phase 2:

- improve gap detection when evidence is sparse or contradictory
- refine export behavior for downstream automation

Phase 3:

- add language-aware grouping or symbol hints
- support investigation presets for docs vs code questions

## Success Criteria

The command is successful when it helps answer:

- "Which files should I read first?"
- "What are the strongest grounded clues for this question?"
- "What is still unclear after retrieval?"

without forcing the user to manually stitch together multiple `ask` runs.
