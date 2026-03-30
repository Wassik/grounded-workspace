# grounded-workspace

`grounded-workspace` is a local-first CLI that scans a directory, chunks text files, and returns the most relevant snippets for a question.

## Why this exists

This is the smallest useful core of an AI workspace assistant:

- It stays grounded in real files.
- It works without external services.
- It gives us a clean base for adding embeddings, summaries, or a web UI later.
- It retrieves file sections, not just whole-file matches.

## Usage

```bash
npm test
node ./src/cli.js index .
node ./src/cli.js ask . "how does indexing work"
node ./src/cli.js ask . "ext:md path:src indexing"
node ./src/cli.js ask . "path:src limit:2 saved index"
node ./src/cli.js ask . "path:src limit:2 minscore:12 saved index"
node ./src/cli.js ask . "saved index excerpt:highlighted"
node ./src/cli.js ask . "saved index excerpt:highlighted highlight:ansi"
node ./src/cli.js ask . "saved index excerpt:highlighted highlight:ansi theme:cyan"
node ./src/cli.js ask . "saved index excerpt:highlighted highlight:plain"
node ./src/cli.js ask . "saved index excerpt:highlighted" --json
node ./src/cli.js ask . "saved index" --excerpt highlighted --highlight tags --theme pill --explain terse --json
node ./src/cli.js ask . "saved index" --json
```

`index` writes `.grounded-workspace-index.json` into the target directory. It stores chunked file sections with line ranges. `ask` reuses that file when present and falls back to a live scan when it is missing.

`ask` now prints a short grounded answer first, followed by the supporting chunk matches.

Add `--json` to `index` or `ask` for machine-readable output.
`ask` also accepts `--explain`, `--excerpt`, `--highlight`, and `--theme` as command-level defaults.
Persistent user-level defaults can be defined in `~/.grounded-workspace.json`.
Shell-level defaults can be defined with `GROUNDED_WORKSPACE_EXPLAIN`, `GROUNDED_WORKSPACE_EXCERPT`, `GROUNDED_WORKSPACE_HIGHLIGHT`, and `GROUNDED_WORKSPACE_THEME`.

Returned snippets can highlight matched query terms in several styles.

Terminal results now also include a compact `why:` line showing the main score components for each match.
They also include a `details:` line with matched terms, phrase hits, and path hits when available.

You can exclude noise with `.grounded-workspaceignore`:

```text
# Ignore generated folders
dist/
coverage/

# Ignore specific files
package-lock.json
```

Query-time filters:

- `ext:md` restricts matches to Markdown files.
- `path:src` restricts matches to paths under `src/`.
- `limit:2` restricts how many merged matches are returned.
- `minscore:12` drops weaker matches below a threshold.
- `explain:terse` keeps score explanations compact.
- `excerpt:highlighted` returns highlighted snippets.
- `highlight:plain`, `highlight:ansi`, or `highlight:tags` changes how highlighted matches are rendered.
- `theme:cyan`, `theme:green`, `theme:magenta`, `theme:inverse`, or `theme:bold` changes ANSI highlight styling.

Default highlight behavior:

- Terminal `ask` output uses `highlight:ansi` in color-capable terminals when you request `excerpt:highlighted` without an explicit `highlight:` mode.
- Non-color terminals fall back to `highlight:plain`, which renders matches as `<<term>>`.
- JSON `ask --json` output uses `highlight:tags` in the same situation.
- Explicit `highlight:ansi` is downgraded to `plain` in non-color terminal output and to `tags` in JSON output.
- Other explicit highlight modes are preserved as requested.
- `theme:` only affects `highlight:ansi`; other highlight modes ignore it.

Theme aliases:

- Add `.grounded-workspace-theme.json` in the workspace root to map short names onto built-in themes, custom ANSI theme names, or wrapper themes.
- Custom ANSI themes can be defined as raw prefix escape sequences or as `{ "start": "...", "reset": "..." }` pairs.
- Wrapper themes can be defined as `{ "before": "...", "after": "..." }` pairs for `tags`, `brackets`, or `plain` highlighting.
- Theme defaults can be defined with `jsonTheme`, `ansiTheme`, `plainTheme`, `bracketsTheme`, or `tagsTheme`.
- Unknown aliases fall back to `theme:yellow` instead of leaking into the search text.

Example theme alias file:

```json
{
  "aliases": {
    "alert": "magenta",
    "calm": "ocean",
    "md": "pill",
    "soft": "sunset",
    "success": "green"
  },
  "themes": {
    "ocean": "\u001b[38;5;45m",
    "sunset": {
      "start": "\u001b[38;5;208m",
      "reset": "\u001b[39m"
    }
  },
  "wrappers": {
    "pill": {
      "before": "<span class=\"pill\">",
      "after": "</span>"
    }
  },
  "defaults": {
    "jsonTheme": "pill",
    "ansiTheme": "ocean"
  }
}
```

Example user defaults file:

```json
{
  "defaults": {
    "explain": "terse",
    "excerpt": "highlighted",
    "highlight": "tags",
    "theme": "pill"
  }
}
```

Example shell defaults:

```bash
export GROUNDED_WORKSPACE_EXPLAIN=terse
export GROUNDED_WORKSPACE_EXCERPT=highlighted
export GROUNDED_WORKSPACE_HIGHLIGHT=tags
export GROUNDED_WORKSPACE_THEME=pill
```

Default theme behavior:

- Configured defaults only apply when the query does not already include `theme:<mode>`.
- `jsonTheme` wins for JSON output.
- Otherwise the tool falls back to a per-highlight default such as `ansiTheme` or `tagsTheme`.

Default precedence:

- Query filters win over everything else.
- CLI flags win over environment and user-level defaults.
- Environment defaults win over user-level defaults.
- User-level defaults win over automatic output defaults.
- Workspace theme defaults apply last, and only when no `theme:` is already present.

## Next steps

1. Add markdown- and HTML-specific wrapper defaults beyond the current single `jsonTheme`.
2. Layer an LLM answer generator on top of the retrieved snippets.
3. Add a small local web UI on top of the existing JSON output.
