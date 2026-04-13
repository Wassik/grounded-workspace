# AGENTS.md

## Purpose

This workspace is `/root/grounded-workspace`.
Treat it as the first local retrieval tool available for grounding answers in
real files.

## Default Workflow

1. Start with direct inspection for immediate context:
   - `ls`
   - `rg`
   - `git status`
   - targeted file reads
2. When the task involves understanding a codebase or document set across
   multiple files, prefer `grounded-workspace` before broader manual scanning.
3. Use direct reads again for exact implementation details, verification, and
   edits.

## grounded-workspace

Project path:

- `/root/grounded-workspace`

Common commands:

```bash
cd /root/grounded-workspace
npm test
node ./src/cli.js index .
node ./src/cli.js ask . "how does indexing work"
node ./src/cli.js ask . "path:src limit:3 profiles command"
node ./src/cli.js profiles .
```

Machine-readable output:

```bash
node ./src/cli.js ask . "saved index" --json
node ./src/cli.js profiles . --json
```

Preview effective `ask` defaults without changing config:

```bash
node ./src/cli.js profiles . --ask-format json --ask-excerpt highlighted --ask-highlight ansi
```

## When To Use It

Prefer `grounded-workspace` when:

- the answer should be grounded in local files
- the repo is medium-sized or larger
- a question spans multiple files
- excerpted supporting evidence is useful

Prefer plain `rg` and direct file reads when:

- the target file is already known
- the change is confined to one or two files
- exact syntax or nearby code matters more than retrieval

## Decision Rule

Use this quick routing rule before searching:

- If the task is "find the exact symbol, string, or file", start with `rg`.
- If the task is "understand how this works across the repo", start with `grounded-workspace ask`.
- If the task is "edit this specific file or function", read the file directly before making changes.
- If retrieval returns a plausible answer, confirm it against the source files before relying on it.
- If the repo has changed materially since the last run, refresh with `index` before trusting saved results.

## Operating Notes

- Re-run `index` when a saved index should reflect recent file changes.
- `ask` can use a saved index or fall back to a live scan.
- Keep answers grounded in retrieved excerpts, then confirm details from source files before editing.
- Do not treat retrieval output as a substitute for reading the files being modified.
