import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildIndex,
  expandQueryTokens,
  loadDocuments,
  parseQuery,
  rankDocuments,
  saveIndex,
  synthesizeAnswer,
  tokenize,
} from "../src/indexer.js";
import {
  applyCliDefaultsToQuery,
  applyConfiguredThemeDefaults,
  applyOutputDefaultsToQuery,
  loadEnvDefaults,
  loadThemeConfig,
  loadUserDefaults,
  parseCliOptions,
  resolveThemeAliasesInQuery,
} from "../src/cli.js";

test("tokenize collects repeated normalized terms", () => {
  const tokens = tokenize("Hello hello README.md");
  assert.equal(tokens.get("hello"), 2);
  assert.equal(tokens.get("readme"), 1);
  assert.equal(tokens.get("md"), 1);
});

test("expandQueryTokens adds simple word variants", () => {
  const tokens = expandQueryTokens("indexing tests");
  assert.equal(tokens.get("index"), 1);
  assert.equal(tokens.get("test"), 1);
});

test("parseQuery extracts inline filters from the search text", () => {
  const parsed = parseQuery("ext:md path:src limit:3 minscore:7.5 explain:terse excerpt:highlighted highlight:ansi theme:cyan docs indexing");
  assert.equal(parsed.queryText, "docs indexing");
  assert.deepEqual(parsed.filters.extensions, [".md"]);
  assert.deepEqual(parsed.filters.pathPrefixes, ["src"]);
  assert.equal(parsed.filters.limit, 3);
  assert.equal(parsed.filters.minScore, 7.5);
  assert.equal(parsed.filters.explain, "terse");
  assert.equal(parsed.filters.excerpt, "highlighted");
  assert.equal(parsed.filters.highlight, "ansi");
  assert.equal(parsed.filters.theme, "cyan");
});

test("parseCliOptions extracts the json flag and positional args", () => {
  const parsed = parseCliOptions([
    "/tmp/workspace",
    "saved index",
    "--json",
    "--explain",
    "terse",
    "--excerpt",
    "highlighted",
    "--highlight",
    "tags",
    "--theme",
    "pill",
  ]);
  assert.equal(parsed.json, true);
  assert.deepEqual(parsed.positionalArgs, ["/tmp/workspace", "saved index"]);
  assert.deepEqual(parsed.defaults, {
    explain: "terse",
    excerpt: "highlighted",
    highlight: "tags",
    theme: "pill",
  });
});

test("applyCliDefaultsToQuery only fills missing query filters", () => {
  const defaults = {
    explain: "terse",
    excerpt: "highlighted",
    highlight: "tags",
    theme: "pill",
  };

  assert.equal(
    applyCliDefaultsToQuery("saved index", defaults),
    "saved index explain:terse excerpt:highlighted highlight:tags theme:pill",
  );
  assert.equal(
    applyCliDefaultsToQuery("saved index explain:verbose highlight:ansi", defaults),
    "saved index explain:verbose highlight:ansi excerpt:highlighted theme:pill",
  );
});

test("loadUserDefaults reads persistent defaults from the home directory", async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "grounded-workspace-home-"));
  await fs.writeFile(
    path.join(homeDir, ".grounded-workspace.json"),
    `${JSON.stringify(
      {
        defaults: {
          explain: "terse",
          excerpt: "highlighted",
          highlight: "tags",
          theme: "pill",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  assert.deepEqual(await loadUserDefaults(homeDir), {
    explain: "terse",
    excerpt: "highlighted",
    highlight: "tags",
    theme: "pill",
  });
});

test("loadEnvDefaults reads shell-provided defaults", () => {
  assert.deepEqual(
    loadEnvDefaults({
      GROUNDED_WORKSPACE_EXPLAIN: "verbose",
      GROUNDED_WORKSPACE_EXCERPT: "highlighted",
      GROUNDED_WORKSPACE_HIGHLIGHT: "ansi",
      GROUNDED_WORKSPACE_THEME: "Calm!",
    }),
    {
      explain: "verbose",
      excerpt: "highlighted",
      highlight: "ansi",
      theme: "calm",
    },
  );
  assert.deepEqual(
    loadEnvDefaults({
      GROUNDED_WORKSPACE_EXPLAIN: "bad",
      GROUNDED_WORKSPACE_EXCERPT: "nope",
      GROUNDED_WORKSPACE_HIGHLIGHT: "wrong",
      GROUNDED_WORKSPACE_THEME: "!!!",
    }),
    {
      explain: null,
      excerpt: null,
      highlight: null,
      theme: null,
    },
  );
});

test("default precedence keeps query strongest, then cli, env, user, output, and workspace theme defaults", () => {
  const themeConfig = {
    aliases: { md: "pill" },
    themes: {},
    wrappers: {
      pill: { before: "<mark>", after: "</mark>" },
    },
    defaults: {
      jsonTheme: "pill",
    },
  };
  const query = "saved index";
  const userQuery = applyCliDefaultsToQuery(query, {
    explain: "verbose",
    excerpt: "highlighted",
    highlight: null,
    theme: null,
  });
  const envQuery = applyCliDefaultsToQuery(userQuery, {
    explain: "terse",
    excerpt: null,
    highlight: "plain",
    theme: "md",
  });
  const cliQuery = applyCliDefaultsToQuery(envQuery, {
    explain: null,
    excerpt: null,
    highlight: "tags",
    theme: "cyan",
  });
  const outputQuery = applyOutputDefaultsToQuery(cliQuery, { json: true });
  const configuredThemeQuery = applyConfiguredThemeDefaults(outputQuery, { json: true }, themeConfig);
  const effectiveQuery = resolveThemeAliasesInQuery(configuredThemeQuery, themeConfig);

  assert.equal(effectiveQuery, "saved index explain:verbose excerpt:highlighted highlight:plain theme:pill");
  assert.equal(
    resolveThemeAliasesInQuery(
      applyConfiguredThemeDefaults(
        applyOutputDefaultsToQuery(
          applyCliDefaultsToQuery(
            applyCliDefaultsToQuery(
              applyCliDefaultsToQuery("saved index explain:terse highlight:brackets", {
                explain: "verbose",
                excerpt: "highlighted",
                highlight: null,
                theme: null,
              }),
              {
                explain: "verbose",
                excerpt: null,
                highlight: "plain",
                theme: "md",
              },
            ),
            {
              explain: null,
              excerpt: "raw",
              highlight: "ansi",
              theme: "cyan",
            },
          ),
          { json: true },
        ),
        { json: true },
        themeConfig,
      ),
      themeConfig,
    ),
    "saved index explain:terse highlight:brackets excerpt:highlighted theme:pill",
  );
});

test("applyOutputDefaultsToQuery adds output-specific highlight defaults", () => {
  assert.equal(
    applyOutputDefaultsToQuery("saved index excerpt:highlighted", { json: false, isTTY: true, noColor: false, term: "xterm-256color" }),
    "saved index excerpt:highlighted highlight:ansi",
  );
  assert.equal(
    applyOutputDefaultsToQuery("saved index excerpt:highlighted", { json: true }),
    "saved index excerpt:highlighted highlight:tags",
  );
  assert.equal(
    applyOutputDefaultsToQuery("saved index excerpt:highlighted", { json: false, isTTY: false, noColor: false, term: "xterm-256color" }),
    "saved index excerpt:highlighted highlight:plain",
  );
  assert.equal(
    applyOutputDefaultsToQuery("saved index excerpt:highlighted", { json: false, isTTY: true, noColor: true, term: "xterm-256color" }),
    "saved index excerpt:highlighted highlight:plain",
  );
  assert.equal(
    applyOutputDefaultsToQuery("saved index excerpt:highlighted highlight:brackets", { json: true }),
    "saved index excerpt:highlighted highlight:brackets",
  );
  assert.equal(
    applyOutputDefaultsToQuery("saved index excerpt:highlighted highlight:ansi", { json: true }),
    "saved index excerpt:highlighted highlight:tags",
  );
  assert.equal(
    applyOutputDefaultsToQuery("saved index excerpt:highlighted highlight:ansi", { json: false, isTTY: false, noColor: false, term: "xterm-256color" }),
    "saved index excerpt:highlighted highlight:plain",
  );
  assert.equal(applyOutputDefaultsToQuery("saved index", { json: false }), "saved index");
});

test("applyConfiguredThemeDefaults injects output and highlight defaults when theme is absent", () => {
  const themeConfig = {
    themes: { ocean: "\u001b[38;5;45m" },
    wrappers: { pill: { before: "<span class=\"pill\">", after: "</span>" } },
    defaults: {
      jsonTheme: "pill",
      plainTheme: "pill",
      ansiTheme: "ocean",
    },
  };

  assert.equal(
    applyConfiguredThemeDefaults("saved index excerpt:highlighted highlight:tags", { json: true }, themeConfig),
    "saved index excerpt:highlighted highlight:tags theme:pill",
  );
  assert.equal(
    applyConfiguredThemeDefaults("saved index excerpt:highlighted highlight:plain", { json: false }, themeConfig),
    "saved index excerpt:highlighted highlight:plain theme:pill",
  );
  assert.equal(
    applyConfiguredThemeDefaults("saved index excerpt:highlighted highlight:ansi", { json: false }, themeConfig),
    "saved index excerpt:highlighted highlight:ansi theme:ocean",
  );
  assert.equal(
    applyConfiguredThemeDefaults("saved index excerpt:highlighted highlight:tags theme:custom", { json: true }, themeConfig),
    "saved index excerpt:highlighted highlight:tags theme:custom",
  );
});

test("resolveThemeAliasesInQuery maps aliases and falls back cleanly", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "grounded-workspace-theme-"));
  await fs.writeFile(
    path.join(rootDir, ".grounded-workspace-theme.json"),
    `${JSON.stringify(
      {
        aliases: { alert: "magenta", calm: "ocean", broken: "missing", soft: "sunset", md: "pill" },
        themes: {
          ocean: "\u001b[38;5;45m",
          sunset: { start: "\u001b[38;5;208m", reset: "\u001b[39m" },
        },
        wrappers: {
          pill: { before: "<span class=\"pill\">", after: "</span>" },
        },
        defaults: {
          jsonTheme: "pill",
          ansiTheme: "ocean",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const themeConfig = await loadThemeConfig(rootDir);

  assert.equal(
    resolveThemeAliasesInQuery("saved index excerpt:highlighted highlight:ansi theme:alert", themeConfig),
    "saved index excerpt:highlighted highlight:ansi theme:magenta",
  );
  assert.equal(
    resolveThemeAliasesInQuery("saved index excerpt:highlighted highlight:ansi theme:unknown", themeConfig),
    "saved index excerpt:highlighted highlight:ansi theme:yellow",
  );
  assert.equal(
    resolveThemeAliasesInQuery("saved index excerpt:highlighted highlight:ansi theme:broken", themeConfig),
    "saved index excerpt:highlighted highlight:ansi theme:yellow",
  );
  assert.equal(
    resolveThemeAliasesInQuery("saved index excerpt:highlighted highlight:ansi theme:calm", themeConfig),
    "saved index excerpt:highlighted highlight:ansi theme:ocean",
  );
  assert.equal(
    resolveThemeAliasesInQuery("saved index excerpt:highlighted highlight:ansi theme:soft", themeConfig),
    "saved index excerpt:highlighted highlight:ansi theme:sunset",
  );
  assert.equal(
    resolveThemeAliasesInQuery("saved index excerpt:highlighted highlight:tags theme:md", themeConfig),
    "saved index excerpt:highlighted highlight:tags theme:pill",
  );
  assert.deepEqual(themeConfig.themes.sunset, {
    start: "\u001b[38;5;208m",
    reset: "\u001b[39m",
  });
  assert.deepEqual(themeConfig.wrappers.pill, {
    before: "<span class=\"pill\">",
    after: "</span>",
  });
  assert.deepEqual(themeConfig.defaults, {
    jsonTheme: "pill",
    ansiTheme: "ocean",
  });
});

test("rankDocuments prioritizes content and path hits", () => {
  const matches = rankDocuments(
    [
      {
        path: "src/api.js",
        chunk: { startLine: 1, endLine: 1 },
        content: "HTTP server and route handlers",
        tokens: tokenize("src/api.js HTTP server and route handlers"),
      },
      {
        path: "README.md",
        chunk: { startLine: 1, endLine: 1 },
        content: "Project setup instructions",
        tokens: tokenize("README.md Project setup instructions"),
      },
    ],
    "api server",
    2,
  );

  assert.equal(matches[0].path, "src/api.js");
  assert.equal(matches.length, 1);
});

test("rankDocuments prefers dense ordered matches over noisy chunks", () => {
  const matches = rankDocuments(
    [
      {
        path: "notes/a.txt",
        chunk: { startLine: 1, endLine: 4 },
        content: "database retrieval is handled here",
        tokens: tokenize("notes/a.txt database retrieval is handled here"),
      },
      {
        path: "notes/b.txt",
        chunk: { startLine: 1, endLine: 8 },
        content:
          "database appears once in a very long chunk with many unrelated words and retrieval appears much later after a lot of filler text",
        tokens: tokenize(
          "notes/b.txt database appears once in a very long chunk with many unrelated words and retrieval appears much later after a lot of filler text",
        ),
      },
    ],
    "database retrieval",
    2,
  );

  assert.equal(matches[0].path, "notes/a.txt");
  assert.ok(matches[0].score > matches[1].score);
});

test("saved index can be loaded without rescanning", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "grounded-workspace-"));
  await fs.writeFile(path.join(rootDir, "notes.txt"), "Caching keeps repeated queries fast.\n", "utf8");

  const index = await buildIndex(rootDir);
  await saveIndex(rootDir, index);
  await fs.unlink(path.join(rootDir, "notes.txt"));

  const loaded = await loadDocuments(rootDir);
  assert.equal(loaded.source, "index");
  assert.equal(loaded.documents[0].path, "notes.txt");
});

test("buildIndex chunks long files and ranks the matching section", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "grounded-workspace-"));
  const longFile = [
    "alpha",
    "bravo",
    "charlie",
    "delta",
    "echo",
    "foxtrot",
    "golf",
    "hotel",
    "india",
    "juliet",
    "kilo",
    "lima",
    "vector database retrieval chunk",
    "matching terms live here",
    "november",
    "oscar",
  ].join("\n");
  await fs.writeFile(path.join(rootDir, "guide.txt"), longFile, "utf8");

  const index = await buildIndex(rootDir);
  assert.equal(index.filesIndexed, 1);
  assert.ok(index.chunksIndexed > 1);

  const hydrated = index.documents.map((document) => ({
    path: document.path,
    chunk: document.chunk,
    content: document.content,
    tokens: new Map(Object.entries(document.tokens)),
  }));
  const matches = rankDocuments(hydrated, "database retrieval");

  assert.equal(matches[0].path, "guide.txt");
  assert.equal(matches[0].chunk.startLine, 9);
  assert.match(matches[0].excerpt, /vector database retrieval chunk/);
});

test("scanWorkspace respects .grounded-workspaceignore rules", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "grounded-workspace-"));
  await fs.mkdir(path.join(rootDir, "generated"), { recursive: true });
  await fs.mkdir(path.join(rootDir, "keep"), { recursive: true });
  await fs.writeFile(path.join(rootDir, ".grounded-workspaceignore"), "generated/\nskip.txt\n", "utf8");
  await fs.writeFile(path.join(rootDir, "generated", "ignored.txt"), "ignore me", "utf8");
  await fs.writeFile(path.join(rootDir, "skip.txt"), "ignore me too", "utf8");
  await fs.writeFile(path.join(rootDir, "keep", "use.txt"), "keep me", "utf8");

  const index = await buildIndex(rootDir);
  const paths = index.documents.map((document) => document.path);

  assert.deepEqual(paths, ["keep/use.txt"]);
});

test("rankDocuments applies extension and path filters", () => {
  const documents = [
    {
      path: "src/guide.md",
      chunk: { startLine: 1, endLine: 1 },
      content: "indexing docs",
      tokens: tokenize("src/guide.md indexing docs"),
    },
    {
      path: "test/guide.md",
      chunk: { startLine: 1, endLine: 1 },
      content: "indexing docs",
      tokens: tokenize("test/guide.md indexing docs"),
    },
    {
      path: "src/app.js",
      chunk: { startLine: 1, endLine: 1 },
      content: "indexing docs",
      tokens: tokenize("src/app.js indexing docs"),
    },
  ];

  const matches = rankDocuments(documents, "ext:md path:src indexing docs");
  assert.deepEqual(matches.map((match) => match.path), ["src/guide.md"]);
});

test("rankDocuments prefers docs and implementation files over tests for similar evidence", () => {
  const documents = [
    {
      path: "README.md",
      chunk: { startLine: 1, endLine: 2 },
      content: "saved index line ranges and retrieval details",
      tokens: tokenize("README.md saved index line ranges and retrieval details"),
    },
    {
      path: "test/indexer.test.js",
      chunk: { startLine: 1, endLine: 2 },
      content: "saved index line ranges and retrieval details",
      tokens: tokenize("test/indexer.test.js saved index line ranges and retrieval details"),
    },
  ];

  const matches = rankDocuments(documents, "saved index line ranges", 2);
  assert.equal(matches[0].path, "README.md");
});

test("rankDocuments applies minscore filter after ranking", () => {
  const documents = [
    {
      path: "README.md",
      chunk: { startLine: 1, endLine: 2 },
      content: "saved index line ranges and grounding docs",
      tokens: tokenize("README.md saved index line ranges and grounding docs"),
    },
    {
      path: "notes.txt",
      chunk: { startLine: 1, endLine: 2 },
      content: "saved index",
      tokens: tokenize("notes.txt saved index"),
    },
  ];

  const baseline = rankDocuments(documents, "saved index line ranges");
  const filtered = rankDocuments(documents, "saved index line ranges minscore:100");

  assert.equal(baseline.length, 2);
  assert.deepEqual(filtered, []);
});

test("rankDocuments merges overlapping chunks and respects limit filter", () => {
  const documents = [
    {
      path: "src/app.js",
      chunk: { startLine: 1, endLine: 12 },
      content: "saved index line ranges saved index line ranges first chunk",
      tokens: tokenize("src/app.js saved index line ranges saved index line ranges first chunk"),
    },
    {
      path: "src/app.js",
      chunk: { startLine: 9, endLine: 20 },
      content: "saved index line ranges saved index line ranges second chunk",
      tokens: tokenize("src/app.js saved index line ranges saved index line ranges second chunk"),
    },
    {
      path: "README.md",
      chunk: { startLine: 1, endLine: 4 },
      content: "saved index docs",
      tokens: tokenize("README.md saved index docs"),
    },
  ];

  const matches = rankDocuments(documents, "path:src saved index limit:1");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].path, "src/app.js");
  assert.equal(matches[0].chunk.startLine, 1);
  assert.equal(matches[0].chunk.endLine, 20);
  assert.match(matches[0].excerpt, /\.\.\./);
});

test("rankDocuments highlights matched query terms in excerpts", () => {
  const documents = [
    {
      path: "README.md",
      chunk: { startLine: 1, endLine: 2 },
      content: "The saved index stores chunked file sections.",
      tokens: tokenize("README.md The saved index stores chunked file sections."),
    },
  ];

  const matches = rankDocuments(documents, "saved index");
  assert.equal(matches[0].highlightedExcerpt, "The [saved] [index] stores chunked file sections.");
  assert.equal(matches[0].rawExcerpt, "The saved index stores chunked file sections.");
  assert.equal(matches[0].excerpt, "The saved index stores chunked file sections.");
});

test("rankDocuments supports highlighted excerpt mode without changing synthesis source", () => {
  const documents = [
    {
      path: "README.md",
      chunk: { startLine: 1, endLine: 2 },
      content: "The saved index stores chunked file sections. Ask reuses the saved index when present.",
      tokens: tokenize(
        "README.md The saved index stores chunked file sections. Ask reuses the saved index when present.",
      ),
    },
  ];

  const matches = rankDocuments(documents, "saved index excerpt:highlighted");
  assert.equal(
    matches[0].excerpt,
    "The [saved] [index] stores chunked file sections. Ask reuses the [saved] [index] when present.",
  );
  assert.equal(
    matches[0].rawExcerpt,
    "The saved index stores chunked file sections. Ask reuses the saved index when present.",
  );

  const answer = synthesizeAnswer(matches, "saved index excerpt:highlighted");
  assert.match(answer, /saved index/i);
  assert.doesNotMatch(answer, /\[saved\]/);
});

test("rankDocuments supports alternate highlight styles", () => {
  const documents = [
    {
      path: "README.md",
      chunk: { startLine: 1, endLine: 2 },
      content: "The saved index stores chunked file sections.",
      tokens: tokenize("README.md The saved index stores chunked file sections."),
    },
  ];

  const ansiMatches = rankDocuments(documents, "saved index excerpt:highlighted highlight:ansi");
  assert.match(ansiMatches[0].excerpt, /\u001B\[1;33msaved\u001B\[0m/);
  assert.match(ansiMatches[0].excerpt, /\u001B\[1;33mindex\u001B\[0m/);

  const cyanMatches = rankDocuments(documents, "saved index excerpt:highlighted highlight:ansi theme:cyan");
  assert.match(cyanMatches[0].excerpt, /\u001B\[1;36msaved\u001B\[0m/);
  assert.match(cyanMatches[0].excerpt, /\u001B\[1;36mindex\u001B\[0m/);

  const tagMatches = rankDocuments(documents, "saved index excerpt:highlighted highlight:tags");
  assert.equal(
    tagMatches[0].excerpt,
    "The <mark>saved</mark> <mark>index</mark> stores chunked file sections.",
  );

  const customThemeMatches = rankDocuments(
    documents,
    "saved index excerpt:highlighted highlight:ansi theme:ocean",
    5,
    { ansiThemes: { ocean: "\u001B[38;5;45m" } },
  );
  assert.match(customThemeMatches[0].excerpt, /\u001B\[38;5;45msaved\u001B\[0m/);
  assert.match(customThemeMatches[0].excerpt, /\u001B\[38;5;45mindex\u001B\[0m/);

  const pairedThemeMatches = rankDocuments(
    documents,
    "saved index excerpt:highlighted highlight:ansi theme:sunset",
    5,
    { ansiThemes: { sunset: { start: "\u001B[38;5;208m", reset: "\u001B[39m" } } },
  );
  assert.match(pairedThemeMatches[0].excerpt, /\u001B\[38;5;208msaved\u001B\[39m/);
  assert.match(pairedThemeMatches[0].excerpt, /\u001B\[38;5;208mindex\u001B\[39m/);

  const wrapperThemeMatches = rankDocuments(
    documents,
    "saved index excerpt:highlighted highlight:tags theme:pill",
    5,
    { wrapperThemes: { pill: { before: "<span class=\"pill\">", after: "</span>" } } },
  );
  assert.equal(
    wrapperThemeMatches[0].excerpt,
    "The <span class=\"pill\">saved</span> <span class=\"pill\">index</span> stores chunked file sections.",
  );
});

test("rankDocuments includes score explanations for each match", () => {
  const documents = [
    {
      path: "README.md",
      chunk: { startLine: 1, endLine: 2 },
      content: "saved index line ranges and retrieval details",
      tokens: tokenize("README.md saved index line ranges and retrieval details"),
    },
  ];

  const matches = rankDocuments(documents, "saved index line ranges");
  assert.deepEqual(Object.keys(matches[0].why), [
    "tokenScore",
    "pathScore",
    "coverageScore",
    "phraseScore",
    "densityScore",
    "retrievalBias",
    "matchedTerms",
    "phraseHits",
    "pathHits",
  ]);
  assert.ok(matches[0].why.coverageScore > 0);
  assert.ok(matches[0].why.matchedTerms.includes("saved"));
  assert.ok(matches[0].why.phraseHits.includes("saved index"));
});

test("rankDocuments supports terse explanations", () => {
  const documents = [
    {
      path: "README.md",
      chunk: { startLine: 1, endLine: 2 },
      content: "saved index line ranges and retrieval details",
      tokens: tokenize("README.md saved index line ranges and retrieval details"),
    },
  ];

  const matches = rankDocuments(documents, "saved index line ranges explain:terse");
  assert.deepEqual(Object.keys(matches[0].why), [
    "tokenScore",
    "pathScore",
    "coverageScore",
    "phraseScore",
    "densityScore",
    "retrievalBias",
    "matchedTerms",
  ]);
});

test("synthesizeAnswer returns a short grounded summary from top matches", () => {
  const answer = synthesizeAnswer(
    [
      {
        path: "src/indexer.js",
        chunk: { startLine: 1, endLine: 4 },
        score: 10,
        excerpt:
          "The CLI stores chunked file sections with line ranges. Ask reuses the saved index when present.",
      },
      {
        path: "README.md",
        chunk: { startLine: 1, endLine: 2 },
        score: 8,
        excerpt: "The project is local-first and grounded in workspace files.",
      },
    ],
    "saved index line ranges",
  );

  assert.match(answer, /line ranges/i);
  assert.match(answer, /saved index/i);
});

test("synthesizeAnswer prefers prose-heavy docs over test fixtures", () => {
  const answer = synthesizeAnswer(
    [
      {
        path: "test/indexer.test.js",
        chunk: { startLine: 1, endLine: 3 },
        score: 20,
        excerpt: "\"saved index line ranges\" \"saved index can be loaded without rescanning\"",
      },
      {
        path: "README.md",
        chunk: { startLine: 1, endLine: 2 },
        score: 18,
        excerpt: "It stores chunked file sections with line ranges. Ask reuses the saved index when present.",
      },
    ],
    "saved index line ranges",
  );

  assert.match(answer, /^It stores chunked file sections with line ranges\./);
});

test("synthesizeAnswer deduplicates near-identical summary sentences", () => {
  const answer = synthesizeAnswer(
    [
      {
        path: "README.md",
        chunk: { startLine: 1, endLine: 2 },
        score: 20,
        excerpt: "It stores chunked file sections with line ranges.",
      },
      {
        path: "docs/overview.md",
        chunk: { startLine: 1, endLine: 2 },
        score: 19,
        excerpt: "The system stores chunked file sections with line ranges.",
      },
    ],
    "chunked file sections line ranges",
  );

  assert.equal(answer, "It stores chunked file sections with line ranges.");
});
