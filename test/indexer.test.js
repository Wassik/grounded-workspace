import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import {
  buildIndex,
  expandQueryTokens,
  getIndexFreshness,
  loadDocuments,
  parseQuery,
  rankDocuments,
  saveIndex,
  synthesizeAnswer,
  tokenize,
} from "../src/indexer.js";
import {
  main,
  applyCliDefaultsToQuery,
  applyConfiguredThemeDefaults,
  applyProfileDefaults,
  applyOutputDefaultsToQuery,
  deriveInvestigationGaps,
  deriveInvestigationQueries,
  detectInvestigationIntent,
  formatAskOutput,
  formatIndexOutput,
  formatJsonOutput,
  formatInvestigateOutput,
  formatProfilesOutput,
  loadEnvDefaults,
  loadThemeConfig,
  loadUserDefaults,
  listProfiles,
  mergeInvestigationHits,
  parseCliOptions,
  resolveColorMode,
  resolveCommandDefaults,
  resolveCommandDefaultSources,
  resolveEffectiveAskOutputDefaults,
  resolveEffectiveAskOutputSources,
  resolveInvestigateOutputPath,
  resolveOutputFormat,
  rankInvestigationFiles,
  serializeInvestigatePayload,
  selectInvestigationEvidence,
  selectCommandDefaults,
  resolveThemeAliasesInQuery,
  validateInvestigateOptions,
} from "../src/cli.js";

const execFile = promisify(execFileCallback);

async function invokeCli(args, { cwd = process.cwd() } = {}) {
  const originalArgv = process.argv;
  const originalCwd = process.cwd();
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  let stdout = "";
  let stderr = "";

  process.argv = [process.execPath, path.join(cwd, "src/cli.js"), ...args];
  process.stdout.write = ((chunk, encoding, callback) => {
    stdout += typeof chunk === "string" ? chunk : chunk.toString(encoding);
    if (typeof callback === "function") {
      callback();
    }
    return true;
  });
  process.stderr.write = ((chunk, encoding, callback) => {
    stderr += typeof chunk === "string" ? chunk : chunk.toString(encoding);
    if (typeof callback === "function") {
      callback();
    }
    return true;
  });

  if (cwd !== originalCwd) {
    process.chdir(cwd);
  }

  try {
    await main();
    return { stdout, stderr };
  } finally {
    process.argv = originalArgv;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    if (process.cwd() !== originalCwd) {
      process.chdir(originalCwd);
    }
  }
}

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
    "--profile",
    "docs_bundle",
    "--format",
    "json",
    "--color",
    "always",
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
  assert.equal(parsed.format, "json");
  assert.deepEqual(parsed.positionalArgs, ["/tmp/workspace", "saved index"]);
  assert.deepEqual(parsed.defaults, {
    profile: "docs_bundle",
    format: "json",
    color: "always",
    explain: "terse",
    excerpt: "highlighted",
    highlight: "tags",
    theme: "pill",
  });
});

test("parseCliOptions accepts markdown and html output formats", () => {
  assert.equal(parseCliOptions(["--format", "markdown"]).format, "markdown");
  assert.equal(parseCliOptions(["--format", "html"]).format, "html");
  assert.equal(parseCliOptions(["--format", "text"]).format, "text");
  assert.equal(parseCliOptions(["--format", "markdown"]).defaults.format, "markdown");
});

test("parseCliOptions extracts profiles preview flags without treating them as positional args", () => {
  const parsed = parseCliOptions([
    "/tmp/workspace",
    "--ask-format",
    "json",
    "--ask-highlight",
    "ansi",
    "--ask-excerpt",
    "highlighted",
    "--index-format",
    "json",
  ]);

  assert.deepEqual(parsed.positionalArgs, ["/tmp/workspace"]);
  assert.deepEqual(parsed.previewDefaults, {
    ask: {
      profile: null,
      extends: null,
      format: "json",
      color: null,
      explain: null,
      excerpt: "highlighted",
      highlight: "ansi",
      theme: null,
    },
    index: {
      profile: null,
      extends: null,
      format: "json",
      color: null,
      explain: null,
      excerpt: null,
      highlight: null,
      theme: null,
    },
  });
});

test("parseCliOptions extracts investigate limit flags", () => {
  const parsed = parseCliOptions([
    "/tmp/workspace",
    "profile defaults",
    "--max-files",
    "2",
    "--max-evidence",
    "5",
    "--include-raw",
    "--refresh-index",
    "--refresh-if-stale",
    "--live",
    "--output-file",
    "/tmp/report.html",
    "--metadata-file",
    "/tmp/report.meta.json",
    "--manifest-json",
    "--json",
  ]);

  assert.deepEqual(parsed.positionalArgs, ["/tmp/workspace", "profile defaults"]);
  assert.equal(parsed.json, true);
  assert.deepEqual(parsed.investigateOptions, {
    maxFiles: 2,
    maxEvidence: 5,
    includeRaw: true,
    refreshIndex: true,
    refreshIfStale: true,
    live: true,
    outputFile: "/tmp/report.html",
    metadataFile: "/tmp/report.meta.json",
    manifestJson: true,
  });
});

test("parseCliOptions extracts index incremental flag", () => {
  const parsed = parseCliOptions(["/tmp/workspace", "--incremental", "--watch", "--watch-interval", "3", "--watch-debounce", "2", "--json"]);

  assert.deepEqual(parsed.positionalArgs, ["/tmp/workspace"]);
  assert.equal(parsed.json, true);
  assert.deepEqual(parsed.indexOptions, {
    incremental: true,
    watch: true,
    watchIntervalSeconds: 3,
    watchDebounceSeconds: 2,
  });
});

test("parseCliOptions does not silently clamp watch intervals", () => {
  const parsed = parseCliOptions(["/tmp/workspace", "--watch-interval", "60", "--watch-debounce", "90"]);

  assert.equal(parsed.indexOptions.watchIntervalSeconds, 60);
  assert.equal(parsed.indexOptions.watchDebounceSeconds, 90);
});

test("parseCliOptions still caps investigate evidence limits", () => {
  const parsed = parseCliOptions(["/tmp/workspace", "profile defaults", "--max-files", "50", "--max-evidence", "99"]);

  assert.equal(parsed.investigateOptions.maxFiles, 20);
  assert.equal(parsed.investigateOptions.maxEvidence, 20);
});

test("investigate output format can be inferred from the output file path", () => {
  const htmlParsed = parseCliOptions(["/tmp/workspace", "profile defaults", "--output-file", "/tmp/report.html"]);
  const markdownParsed = parseCliOptions(["/tmp/workspace", "profile defaults", "--output-file", "/tmp/report.md"]);
  const jsonParsed = parseCliOptions(["/tmp/workspace", "profile defaults", "--output-file", "/tmp/report.json"]);
  const explicitParsed = parseCliOptions(["/tmp/workspace", "profile defaults", "--output-file", "/tmp/report.html", "--format", "markdown"]);

  assert.equal(htmlParsed.format, null);
  assert.equal(markdownParsed.format, null);
  assert.equal(jsonParsed.format, null);
  assert.equal(explicitParsed.format, "markdown");
});

test("resolveInvestigateOutputPath appends a default extension or filename when needed", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "grounded-investigate-output-"));

  assert.equal(
    await resolveInvestigateOutputPath(path.join(tmpDir, "report"), "html"),
    path.join(tmpDir, "report.html"),
  );

  assert.equal(
    await resolveInvestigateOutputPath(tmpDir, "markdown"),
    path.join(tmpDir, "investigate-report.md"),
  );

  assert.equal(
    await resolveInvestigateOutputPath(path.join(tmpDir, "report.json"), "html"),
    path.join(tmpDir, "report.html"),
  );
});

test("validateInvestigateOptions rejects live refresh combinations", () => {
  assert.throws(
    () => validateInvestigateOptions({ live: true, refreshIndex: true }),
    /--live cannot be combined with --refresh-index/,
  );
  assert.throws(
    () => validateInvestigateOptions({ live: true, refreshIfStale: true }),
    /--live cannot be combined with --refresh-if-stale/,
  );
});

test("formatJsonOutput supports pretty and stream-safe json rendering", () => {
  const payload = { command: "refresh", filesIndexed: 1 };

  assert.equal(formatJsonOutput(payload), '{\n  "command": "refresh",\n  "filesIndexed": 1\n}\n');
  assert.equal(formatJsonOutput(payload, { pretty: false }), '{"command":"refresh","filesIndexed":1}\n');
});

test("investigate json output files use a matching json extension", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "grounded-investigate-json-"));
  await fs.writeFile(path.join(rootDir, "notes.txt"), "profile defaults live in the cli\n", "utf8");

  const requestedPath = path.join(rootDir, "report.md");
  await execFile(
    process.execPath,
    ["./src/cli.js", "investigate", rootDir, "profile defaults", "--output-file", requestedPath, "--json"],
    { cwd: process.cwd() },
  );

  const writtenJson = await fs.readFile(path.join(rootDir, "report.json"), "utf8");
  assert.doesNotMatch(writtenJson, /^Using /);
  await assert.rejects(fs.readFile(requestedPath, "utf8"), { code: "ENOENT" });
});

test("investigate refresh-if-stale rebuilds a stale saved index before returning json", { concurrency: false }, async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "grounded-investigate-stale-"));
  const notesPath = path.join(rootDir, "notes.txt");
  await fs.writeFile(notesPath, "profile defaults live in the cli\n", "utf8");
  const initialIndex = await buildIndex(rootDir);
  await saveIndex(rootDir, initialIndex);

  await fs.writeFile(notesPath, "profile defaults moved into the refreshed cli flow\n", "utf8");

  const { stdout } = await invokeCli(["investigate", rootDir, "profile defaults", "--refresh-if-stale", "--json"], {
    cwd: process.cwd(),
  });

  const payload = JSON.parse(stdout);
  assert.equal(payload.source, "index");
  assert.equal(payload.sourceMode, "index");
  assert.equal(payload.refresh.requested, true);
  assert.equal(payload.refresh.performed, true);
  assert.equal(payload.refresh.mode, "if-stale");
  assert.equal(payload.refresh.indexMode, "incremental");
  assert.equal(payload.refresh.reason, "saved index was stale");
  assert.equal(payload.freshness.status, "fresh");
  assert.equal(payload.freshness.changedFiles, 0);
  assert.equal(payload.freshness.deletedFiles, 0);
  assert.equal(payload.freshness.newFiles, 0);
});

test("investigate live mode bypasses the saved index and reports live scan metadata", { concurrency: false }, async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "grounded-investigate-live-"));
  const notesPath = path.join(rootDir, "notes.txt");
  await fs.writeFile(notesPath, "profile defaults only exist in the live scan\n", "utf8");
  const initialIndex = await buildIndex(rootDir);
  await saveIndex(rootDir, initialIndex);
  await fs.writeFile(notesPath, "profile defaults were updated after the saved index\n", "utf8");

  const { stdout } = await invokeCli(["investigate", rootDir, "profile defaults", "--live", "--json"], {
    cwd: process.cwd(),
  });

  const payload = JSON.parse(stdout);
  assert.equal(payload.source, "scan");
  assert.equal(payload.sourceMode, "live-forced");
  assert.equal(payload.sourceReason, "forced live scan");
  assert.equal(payload.freshness.status, "live");
  assert.equal(payload.freshness.reason, "using a live scan");
});

test("investigate export manifest reports normalized report and metadata paths", { concurrency: false }, async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "grounded-investigate-export-"));
  await fs.writeFile(path.join(rootDir, "notes.txt"), "profile defaults live in the cli\n", "utf8");

  const reportPath = path.join(rootDir, "report");
  const metadataPath = path.join(rootDir, "meta");
  const { stdout } = await invokeCli(
    [
      "investigate",
      rootDir,
      "profile defaults",
      "--output-file",
      reportPath,
      "--metadata-file",
      metadataPath,
      "--manifest-json",
    ],
    { cwd: process.cwd() },
  );

  const manifest = JSON.parse(stdout);
  assert.deepEqual(manifest, {
    report: path.join(rootDir, "report.txt"),
    metadata: path.join(rootDir, "meta.json"),
  });

  const writtenReport = await fs.readFile(manifest.report, "utf8");
  const writtenMetadata = JSON.parse(await fs.readFile(manifest.metadata, "utf8"));
  assert.match(writtenReport, /^Using /);
  assert.equal(writtenMetadata.question, "profile defaults");
});

test("deriveInvestigationQueries expands a question into focused follow-up searches", () => {
  assert.deepEqual(
    deriveInvestigationQueries("how do profile defaults work"),
    [
      "how do profile defaults work",
      "profile defaults default",
      "profile defaults default path:src",
    ],
  );

  assert.deepEqual(
    deriveInvestigationQueries("theme aliases ext:md docs"),
    [
      "theme aliases ext:md docs",
      "theme aliases docs ext:md",
    ],
  );

  assert.deepEqual(
    deriveInvestigationQueries("where is this documented in the README"),
    [
      "where is this documented in the README",
      "readme",
      "readme ext:md",
    ],
  );

  assert.deepEqual(
    deriveInvestigationQueries("which tests cover profile defaults"),
    [
      "which tests cover profile defaults",
      "tests profile defaults",
      "tests profile defaults path:test",
    ],
  );
});

test("detectInvestigationIntent distinguishes code, docs, tests, and general questions", () => {
  assert.equal(detectInvestigationIntent("how do profile defaults work"), "code");
  assert.equal(detectInvestigationIntent("where is this documented in the README"), "docs");
  assert.equal(detectInvestigationIntent("which tests cover profile defaults"), "tests");
  assert.equal(detectInvestigationIntent("what matters here"), "general");
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
          profile: "ci",
          color: "auto",
          explain: "terse",
          excerpt: "highlighted",
          highlight: "tags",
          theme: "pill",
        },
        profiles: {
          docs_bundle: {
            format: "markdown",
            color: "never",
            excerpt: "highlighted",
            highlight: "tags",
            theme: "pill",
          },
        },
        ask: {
          profile: "html-report",
          format: "markdown",
          color: "never",
          explain: "verbose",
          excerpt: "raw",
          highlight: "plain",
          theme: "cyan",
        },
        index: {
          defaults: {
            format: "json",
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  assert.deepEqual(await loadUserDefaults(homeDir), {
    profile: "ci",
    extends: null,
    format: null,
    color: "auto",
    explain: "terse",
    excerpt: "highlighted",
    highlight: "tags",
    theme: "pill",
    profiles: {
      docs_bundle: {
        profile: null,
        extends: null,
        format: "markdown",
        color: "never",
        explain: null,
        excerpt: "highlighted",
        highlight: "tags",
        theme: "pill",
      },
    },
    commands: {
      ask: {
        profile: "html-report",
        extends: null,
        format: "markdown",
        color: "never",
        explain: "verbose",
        excerpt: "raw",
        highlight: "plain",
        theme: "cyan",
      },
      index: {
        profile: null,
        extends: null,
        format: "json",
        color: null,
        explain: null,
        excerpt: null,
        highlight: null,
        theme: null,
      },
    },
  });
});

test("loadEnvDefaults reads shell-provided defaults", () => {
  assert.deepEqual(
    loadEnvDefaults({
      GROUNDED_WORKSPACE_PROFILE: "terminal",
      GROUNDED_WORKSPACE_FORMAT: "markdown",
      GROUNDED_WORKSPACE_ASK_PROFILE: "markdown-doc",
      GROUNDED_WORKSPACE_ASK_FORMAT: "html",
      GROUNDED_WORKSPACE_INDEX_FORMAT: "json",
      GROUNDED_WORKSPACE_COLOR: "auto",
      GROUNDED_WORKSPACE_ASK_COLOR: "never",
      GROUNDED_WORKSPACE_EXPLAIN: "verbose",
      GROUNDED_WORKSPACE_ASK_EXPLAIN: "terse",
      GROUNDED_WORKSPACE_EXCERPT: "highlighted",
      GROUNDED_WORKSPACE_ASK_EXCERPT: "raw",
      GROUNDED_WORKSPACE_HIGHLIGHT: "ansi",
      GROUNDED_WORKSPACE_ASK_HIGHLIGHT: "tags",
      GROUNDED_WORKSPACE_THEME: "Calm!",
      GROUNDED_WORKSPACE_ASK_THEME: "pill",
    }),
    {
      profile: "terminal",
      extends: null,
      format: "markdown",
      color: "auto",
      explain: "verbose",
      excerpt: "highlighted",
      highlight: "ansi",
      theme: "calm",
      commands: {
        ask: {
          profile: "markdown-doc",
          extends: null,
          format: "html",
          color: "never",
          explain: "terse",
          excerpt: "raw",
          highlight: "tags",
          theme: "pill",
        },
        index: {
          profile: null,
          extends: null,
          format: "json",
          color: null,
          explain: null,
          excerpt: null,
          highlight: null,
          theme: null,
        },
      },
      profiles: {},
    },
  );
  assert.deepEqual(
    loadEnvDefaults({
      GROUNDED_WORKSPACE_FORMAT: "bad",
      GROUNDED_WORKSPACE_EXPLAIN: "bad",
      GROUNDED_WORKSPACE_EXCERPT: "nope",
      GROUNDED_WORKSPACE_HIGHLIGHT: "wrong",
      GROUNDED_WORKSPACE_THEME: "!!!",
    }),
    {
      profile: null,
      extends: null,
      format: null,
      color: null,
      explain: null,
      excerpt: null,
      highlight: null,
      theme: null,
      commands: {
        ask: {
          profile: null,
          extends: null,
          format: null,
          color: null,
          explain: null,
          excerpt: null,
          highlight: null,
          theme: null,
        },
        index: {
          profile: null,
          extends: null,
          format: null,
          color: null,
          explain: null,
          excerpt: null,
          highlight: null,
          theme: null,
        },
      },
      profiles: {},
    },
  );
});

test("loadThemeConfig reads workspace-scoped profiles", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "grounded-workspace-theme-"));
  await fs.writeFile(
    path.join(rootDir, ".grounded-workspace-theme.json"),
    `${JSON.stringify(
      {
        profiles: {
          repo_docs: {
            format: "markdown",
            color: "never",
            excerpt: "highlighted",
            highlight: "tags",
            theme: "pill",
          },
        },
        wrappers: {
          pill: { before: "<span class=\"pill\">", after: "</span>" },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const themeConfig = await loadThemeConfig(rootDir);
  assert.deepEqual(themeConfig.profiles, {
    repo_docs: {
      profile: null,
      extends: null,
      format: "markdown",
      color: "never",
      explain: null,
      excerpt: "highlighted",
      highlight: "tags",
      theme: "pill",
    },
  });
});

test("selectCommandDefaults lets per-command format override the global one", () => {
  const defaults = {
    profile: "terminal",
    extends: null,
    format: "markdown",
    color: "auto",
    explain: "terse",
    excerpt: "highlighted",
    highlight: "tags",
    theme: "pill",
    commands: {
      ask: {
        profile: "html-report",
        extends: null,
        format: "html",
        color: "never",
        explain: "verbose",
        excerpt: "raw",
        highlight: "plain",
        theme: "cyan",
      },
      index: {
        profile: null,
        extends: null,
        format: "json",
        color: null,
        explain: null,
        excerpt: null,
        highlight: null,
        theme: null,
      },
    },
  };

  assert.deepEqual(selectCommandDefaults(defaults, "ask"), {
    profile: "html-report",
    extends: null,
    format: "html",
    color: "never",
    explain: "verbose",
    excerpt: "raw",
    highlight: "plain",
    theme: "cyan",
  });
  assert.deepEqual(selectCommandDefaults(defaults, "index"), {
    profile: "terminal",
    extends: null,
    format: "json",
    color: "auto",
    explain: "terse",
    excerpt: "highlighted",
    highlight: "tags",
    theme: "pill",
  });
});

test("applyProfileDefaults fills missing fields from built-in profiles", () => {
  assert.deepEqual(
    applyProfileDefaults({
      profile: "terminal",
      format: null,
      color: null,
      explain: null,
      excerpt: null,
      highlight: null,
      theme: null,
    }),
    {
      profile: "terminal",
      extends: null,
      format: "text",
      color: "auto",
      explain: null,
      excerpt: "highlighted",
      highlight: "ansi",
      theme: "yellow",
    },
  );
  assert.deepEqual(
    applyProfileDefaults({
      profile: "html-report",
      format: null,
      color: null,
      explain: "terse",
      excerpt: null,
      highlight: "plain",
      theme: null,
    }),
    {
      profile: "html-report",
      extends: null,
      format: "html",
      color: "never",
      explain: "terse",
      excerpt: "highlighted",
      highlight: "plain",
      theme: null,
    },
  );
  assert.deepEqual(
    applyProfileDefaults(
      {
        profile: "docs_bundle",
        format: null,
        color: null,
        explain: null,
        excerpt: null,
        highlight: null,
        theme: null,
      },
      {
        docs_bundle: {
          profile: null,
          extends: null,
          format: "markdown",
          color: "never",
          explain: null,
          excerpt: "highlighted",
          highlight: "tags",
          theme: "pill",
        },
      },
    ),
    {
      profile: "docs_bundle",
      extends: null,
      format: "markdown",
      color: "never",
      explain: null,
      excerpt: "highlighted",
      highlight: "tags",
      theme: "pill",
    },
  );
});

test("user profiles override workspace profiles with the same name", () => {
  const workspaceProfiles = {
    docs_bundle: {
      profile: null,
      extends: null,
      format: "markdown",
      color: "never",
      explain: null,
      excerpt: "highlighted",
      highlight: "tags",
      theme: "pill",
    },
  };
  const userProfiles = {
    docs_bundle: {
      profile: null,
      extends: null,
      format: "html",
      color: "never",
      explain: null,
      excerpt: "highlighted",
      highlight: "tags",
      theme: "pill",
    },
  };

  assert.deepEqual(
    applyProfileDefaults(
      {
        profile: "docs_bundle",
        format: null,
        color: null,
        explain: null,
        excerpt: null,
        highlight: null,
        theme: null,
      },
      { ...workspaceProfiles, ...userProfiles },
    ),
    {
      profile: "docs_bundle",
      extends: null,
      format: "html",
      color: "never",
      explain: null,
      excerpt: "highlighted",
      highlight: "tags",
      theme: "pill",
    },
  );
});

test("applyProfileDefaults resolves inherited custom profiles", () => {
  assert.deepEqual(
    applyProfileDefaults(
      {
        profile: "docs_report",
        extends: null,
        format: null,
        color: null,
        explain: null,
        excerpt: null,
        highlight: null,
        theme: null,
      },
      {
        docs_base: {
          profile: null,
          extends: null,
          format: "markdown",
          color: "never",
          explain: null,
          excerpt: "highlighted",
          highlight: "tags",
          theme: null,
        },
        docs_report: {
          profile: null,
          extends: "docs_base",
          format: null,
          color: null,
          explain: "terse",
          excerpt: null,
          highlight: null,
          theme: "pill",
        },
      },
    ),
    {
      profile: "docs_report",
      extends: null,
      format: "markdown",
      color: "never",
      explain: "terse",
      excerpt: "highlighted",
      highlight: "tags",
      theme: "pill",
    },
  );
});

test("applyProfileDefaults breaks profile cycles safely", () => {
  assert.deepEqual(
    applyProfileDefaults(
      {
        profile: "loop_a",
        extends: null,
        format: null,
        color: null,
        explain: null,
        excerpt: null,
        highlight: null,
        theme: null,
      },
      {
        loop_a: {
          profile: null,
          extends: "loop_b",
          format: "markdown",
          color: null,
          explain: null,
          excerpt: null,
          highlight: null,
          theme: null,
        },
        loop_b: {
          profile: null,
          extends: "loop_a",
          format: null,
          color: "never",
          explain: null,
          excerpt: null,
          highlight: null,
          theme: null,
        },
      },
    ),
    {
      profile: "loop_a",
      extends: null,
      format: "markdown",
      color: "never",
      explain: null,
      excerpt: null,
      highlight: null,
      theme: null,
    },
  );
});

test("listProfiles reports merged profile sources and resolved defaults", () => {
  assert.deepEqual(
    listProfiles({
      workspaceProfiles: {
        repo_docs: {
          profile: null,
          extends: "markdown-doc",
          format: null,
          color: null,
          explain: null,
          excerpt: null,
          highlight: null,
          theme: "pill",
        },
        shared: {
          profile: null,
          extends: null,
          format: "markdown",
          color: "never",
          explain: null,
          excerpt: "highlighted",
          highlight: "tags",
          theme: null,
        },
      },
      userProfiles: {
        shared: {
          profile: null,
          extends: "ci",
          format: null,
          color: null,
          explain: "verbose",
          excerpt: null,
          highlight: null,
          theme: null,
        },
      },
    }),
    [
      {
        name: "ci",
        source: "built-in",
        extends: null,
        resolved: {
          profile: null,
          extends: null,
          format: "text",
          color: "never",
          explain: null,
          excerpt: "highlighted",
          highlight: "plain",
          theme: null,
        },
      },
      {
        name: "html-report",
        source: "built-in",
        extends: null,
        resolved: {
          profile: null,
          extends: null,
          format: "html",
          color: "never",
          explain: null,
          excerpt: "highlighted",
          highlight: "tags",
          theme: null,
        },
      },
      {
        name: "markdown-doc",
        source: "built-in",
        extends: null,
        resolved: {
          profile: null,
          extends: null,
          format: "markdown",
          color: "never",
          explain: null,
          excerpt: "highlighted",
          highlight: "tags",
          theme: null,
        },
      },
      {
        name: "repo_docs",
        source: "workspace",
        extends: "markdown-doc",
        resolved: {
          profile: null,
          extends: "markdown-doc",
          format: "markdown",
          color: "never",
          explain: null,
          excerpt: "highlighted",
          highlight: "tags",
          theme: "pill",
        },
      },
      {
        name: "shared",
        source: "user",
        extends: "ci",
        resolved: {
          profile: null,
          extends: "ci",
          format: "text",
          color: "never",
          explain: "verbose",
          excerpt: "highlighted",
          highlight: "plain",
          theme: null,
        },
      },
      {
        name: "terminal",
        source: "built-in",
        extends: null,
        resolved: {
          profile: null,
          extends: null,
          format: "text",
          color: "auto",
          explain: null,
          excerpt: "highlighted",
          highlight: "ansi",
          theme: "yellow",
        },
      },
    ],
  );
});

test("resolveCommandDefaults applies cli over env over user with profiles expanded", () => {
  const availableProfiles = {
    docs_bundle: {
      profile: null,
      extends: "markdown-doc",
      format: null,
      color: null,
      explain: "verbose",
      excerpt: null,
      highlight: null,
      theme: "pill",
    },
  };

  assert.deepEqual(
    resolveCommandDefaults({
      command: "ask",
      userConfig: {
        profile: "terminal",
        extends: null,
        format: null,
        color: "auto",
        explain: null,
        excerpt: null,
        highlight: null,
        theme: null,
        commands: {
          ask: {
            profile: null,
            extends: null,
            format: "html",
            color: null,
            explain: null,
            excerpt: "raw",
            highlight: null,
            theme: null,
          },
        },
      },
      envConfig: {
        profile: null,
        extends: null,
        format: null,
        color: null,
        explain: null,
        excerpt: null,
        highlight: null,
        theme: null,
        commands: {
          ask: {
            profile: "docs_bundle",
            extends: null,
            format: null,
            color: "never",
            explain: null,
            excerpt: null,
            highlight: null,
            theme: null,
          },
        },
      },
      cliDefaults: {
        profile: null,
        extends: null,
        format: null,
        color: null,
        explain: "terse",
        excerpt: null,
        highlight: "plain",
        theme: null,
      },
      availableProfiles,
    }),
    {
      profile: "docs_bundle",
      extends: null,
      format: "markdown",
      color: "never",
      explain: "terse",
      excerpt: "highlighted",
      highlight: "plain",
      theme: "pill",
    },
  );
});

test("resolveCommandDefaultSources reports cli, env, user, and profile-expanded origins", () => {
  const availableProfiles = {
    docs_bundle: {
      profile: null,
      extends: "markdown-doc",
      format: null,
      color: null,
      explain: "verbose",
      excerpt: null,
      highlight: null,
      theme: "pill",
    },
  };

  assert.deepEqual(
    resolveCommandDefaultSources({
      command: "ask",
      userConfig: {
        profile: "terminal",
        extends: null,
        format: null,
        color: "auto",
        explain: null,
        excerpt: null,
        highlight: null,
        theme: null,
      },
      envConfig: {
        profile: null,
        extends: null,
        format: null,
        color: null,
        explain: null,
        excerpt: null,
        highlight: null,
        theme: null,
        commands: {
          ask: {
            profile: "docs_bundle",
            extends: null,
            format: null,
            color: "never",
            explain: null,
            excerpt: null,
            highlight: null,
            theme: null,
          },
        },
      },
      cliDefaults: {
        profile: null,
        extends: null,
        format: null,
        color: null,
        explain: "terse",
        excerpt: null,
        highlight: "plain",
        theme: null,
      },
      availableProfiles,
    }),
    {
      profile: "env",
      extends: "unset",
      format: "env+profile",
      color: "env",
      explain: "cli",
      excerpt: "env+profile",
      highlight: "cli",
      theme: "env+profile",
    },
  );
});

test("profiles preview flags can override active ask defaults hypothetically", () => {
  assert.deepEqual(
    resolveCommandDefaults({
      command: "ask",
      userConfig: {
        profile: "terminal",
        extends: null,
        format: null,
        color: null,
        explain: null,
        excerpt: null,
        highlight: null,
        theme: null,
      },
      envConfig: {
        profile: null,
        extends: null,
        format: null,
        color: null,
        explain: null,
        excerpt: null,
        highlight: null,
        theme: null,
      },
      cliDefaults: {
        profile: null,
        extends: null,
        format: "json",
        color: "always",
        explain: null,
        excerpt: "highlighted",
        highlight: "ansi",
        theme: null,
      },
      availableProfiles: {},
    }),
    {
      profile: "terminal",
      extends: null,
      format: "json",
      color: "always",
      explain: null,
      excerpt: "highlighted",
      highlight: "ansi",
      theme: "yellow",
    },
  );
});

test("resolveEffectiveAskOutputDefaults applies output-specific highlight and theme behavior", () => {
  const themeConfig = {
    aliases: { md: "pill" },
    themes: {},
    wrappers: {
      pill: { before: "<mark>", after: "</mark>" },
    },
    defaults: {
      jsonTheme: "pill",
      ansiTheme: "yellow",
    },
  };

  assert.deepEqual(
    resolveEffectiveAskOutputDefaults({
      commandDefaults: {
        profile: null,
        extends: null,
        format: null,
        color: "auto",
        explain: null,
        excerpt: "highlighted",
        highlight: "ansi",
        theme: null,
      },
      themeConfig,
      outputFormat: "json",
      colorMode: "auto",
      isTTY: true,
      term: "xterm-256color",
    }),
    {
      color: "auto",
      excerpt: "highlighted",
      highlight: "tags",
      theme: "pill",
    },
  );

  assert.deepEqual(
    resolveEffectiveAskOutputDefaults({
      commandDefaults: {
        profile: null,
        extends: null,
        format: null,
        color: "never",
        explain: null,
        excerpt: "highlighted",
        highlight: null,
        theme: null,
      },
      themeConfig,
      outputFormat: "text",
      colorMode: "never",
      isTTY: true,
      term: "xterm-256color",
    }),
    {
      color: "never",
      excerpt: "highlighted",
      highlight: "plain",
      theme: null,
    },
  );
});

test("resolveEffectiveAskOutputSources marks output rewrites and workspace theme injection", () => {
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

  assert.deepEqual(
    resolveEffectiveAskOutputSources({
      commandDefaults: {
        profile: null,
        extends: null,
        format: null,
        color: "never",
        explain: null,
        excerpt: "highlighted",
        highlight: "ansi",
        theme: null,
      },
      commandSources: {
        profile: "unset",
        extends: "unset",
        format: "unset",
        color: "env",
        explain: "unset",
        excerpt: "cli",
        highlight: "cli",
        theme: "unset",
      },
      themeConfig,
      outputFormat: "json",
      colorMode: "never",
      isTTY: true,
      term: "xterm-256color",
    }),
    {
      color: "env",
      excerpt: "cli",
      highlight: "cli+output",
      theme: "workspace-output",
    },
  );
});

test("resolveColorMode applies cli, env, and user defaults", () => {
  assert.equal(
    resolveColorMode({
      cliDefaults: { color: "always" },
      envDefaults: { color: "never" },
      userDefaults: { color: "auto" },
      fallback: "auto",
    }),
    "always",
  );
  assert.equal(
    resolveColorMode({
      cliDefaults: { color: null },
      envDefaults: { color: "never" },
      userDefaults: { color: "auto" },
      fallback: "auto",
    }),
    "never",
  );
});

test("ask command defaults compose as query over cli over env over user", () => {
  const userDefaults = selectCommandDefaults(
    {
      format: "markdown",
      color: "auto",
      explain: "verbose",
      excerpt: "highlighted",
      highlight: "plain",
      theme: "green",
      commands: {
        ask: {
          format: "html",
          color: "never",
          explain: "terse",
          excerpt: "raw",
          highlight: "tags",
          theme: "cyan",
        },
      },
    },
    "ask",
  );
  const envDefaults = selectCommandDefaults(
    {
      format: "json",
      color: "auto",
      explain: "verbose",
      excerpt: "highlighted",
      highlight: "ansi",
      theme: "magenta",
      commands: {
        ask: {
          format: "markdown",
          color: "always",
          explain: "verbose",
          excerpt: "highlighted",
          highlight: "brackets",
          theme: "pill",
        },
      },
    },
    "ask",
  );
  const cliDefaults = {
    format: "text",
    color: null,
    explain: "terse",
    excerpt: "raw",
    highlight: "plain",
    theme: "yellow",
  };

  assert.equal(
    resolveOutputFormat({
      cliFormat: cliDefaults.format,
      cliDefaults,
      envDefaults,
      userDefaults,
      fallback: "text",
      command: "ask",
    }),
    "text",
  );
  assert.equal(
    resolveColorMode({
      cliDefaults,
      envDefaults,
      userDefaults,
      fallback: "auto",
    }),
    "always",
  );
  assert.equal(
    applyCliDefaultsToQuery(
      applyCliDefaultsToQuery(
        applyCliDefaultsToQuery("saved index explain:verbose", userDefaults),
        envDefaults,
      ),
      cliDefaults,
    ),
    "saved index explain:verbose excerpt:raw highlight:tags theme:cyan",
  );
});

test("resolveOutputFormat applies cli, env, and user defaults with index safety", () => {
  assert.equal(
    resolveOutputFormat({
      cliFormat: "html",
      cliDefaults: { format: "markdown" },
      envDefaults: { format: "json" },
      userDefaults: { format: "text" },
      fallback: "text",
      command: "ask",
    }),
    "html",
  );
  assert.equal(
    resolveOutputFormat({
      cliFormat: null,
      cliDefaults: { format: null },
      envDefaults: { format: "markdown" },
      userDefaults: { format: "json" },
      fallback: "text",
      command: "ask",
    }),
    "markdown",
  );
  assert.equal(
    resolveOutputFormat({
      cliFormat: null,
      cliDefaults: { format: null },
      envDefaults: { format: null },
      userDefaults: { format: "html" },
      fallback: "text",
      command: "ask",
    }),
    "html",
  );
  assert.equal(
    resolveOutputFormat({
      cliFormat: "html",
      cliDefaults: { format: "markdown" },
      envDefaults: { format: "json" },
      userDefaults: { format: "text" },
      fallback: "text",
      command: "index",
    }),
    "text",
  );
  assert.equal(
    resolveOutputFormat({
      cliFormat: null,
      cliDefaults: { format: null },
      envDefaults: { format: "json" },
      userDefaults: { format: "markdown" },
      fallback: "text",
      command: "index",
    }),
    "json",
  );
});

test("default precedence keeps query strongest, then cli, env, user, output, and workspace theme defaults", () => {
  const themeConfig = {
    aliases: { md: "pill" },
    themes: {},
    wrappers: {
      pill: { before: "<mark>", after: "</mark>" },
      mdpill: { before: "**", after: "**" },
      htmlpill: { before: "<span>", after: "</span>" },
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
  const outputQuery = applyOutputDefaultsToQuery(cliQuery, { outputFormat: "json" });
  const configuredThemeQuery = applyConfiguredThemeDefaults(outputQuery, { outputFormat: "json" }, themeConfig);
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
          { outputFormat: "json" },
        ),
        { outputFormat: "json" },
        themeConfig,
      ),
      themeConfig,
    ),
    "saved index explain:terse highlight:brackets excerpt:highlighted theme:pill",
  );
});

test("applyOutputDefaultsToQuery adds output-specific highlight defaults", () => {
  assert.equal(
    applyOutputDefaultsToQuery("saved index excerpt:highlighted", { outputFormat: "text", colorMode: "auto", isTTY: true, term: "xterm-256color" }),
    "saved index excerpt:highlighted highlight:ansi",
  );
  assert.equal(
    applyOutputDefaultsToQuery("saved index excerpt:highlighted", { outputFormat: "json", colorMode: "auto" }),
    "saved index excerpt:highlighted highlight:tags",
  );
  assert.equal(
    applyOutputDefaultsToQuery("saved index excerpt:highlighted", { outputFormat: "markdown", colorMode: "auto" }),
    "saved index excerpt:highlighted highlight:tags",
  );
  assert.equal(
    applyOutputDefaultsToQuery("saved index excerpt:highlighted", { outputFormat: "html", colorMode: "auto" }),
    "saved index excerpt:highlighted highlight:tags",
  );
  assert.equal(
    applyOutputDefaultsToQuery("saved index excerpt:highlighted", { outputFormat: "text", colorMode: "auto", isTTY: false, term: "xterm-256color" }),
    "saved index excerpt:highlighted highlight:plain",
  );
  assert.equal(
    applyOutputDefaultsToQuery("saved index excerpt:highlighted", { outputFormat: "text", colorMode: "never", isTTY: true, term: "xterm-256color" }),
    "saved index excerpt:highlighted highlight:plain",
  );
  assert.equal(
    applyOutputDefaultsToQuery("saved index excerpt:highlighted highlight:brackets", { outputFormat: "json", colorMode: "auto" }),
    "saved index excerpt:highlighted highlight:brackets",
  );
  assert.equal(
    applyOutputDefaultsToQuery("saved index excerpt:highlighted highlight:ansi", { outputFormat: "html", colorMode: "always" }),
    "saved index excerpt:highlighted highlight:tags",
  );
  assert.equal(
    applyOutputDefaultsToQuery("saved index excerpt:highlighted highlight:ansi", { outputFormat: "text", colorMode: "always", isTTY: false, term: "xterm-256color" }),
    "saved index excerpt:highlighted highlight:ansi",
  );
  assert.equal(
    applyOutputDefaultsToQuery("saved index excerpt:highlighted highlight:ansi", { outputFormat: "text", colorMode: "never", isTTY: true, term: "xterm-256color" }),
    "saved index excerpt:highlighted highlight:plain",
  );
  assert.equal(applyOutputDefaultsToQuery("saved index", { outputFormat: "text", colorMode: "auto" }), "saved index");
});

test("applyConfiguredThemeDefaults injects output and highlight defaults when theme is absent", () => {
  const themeConfig = {
    themes: { ocean: "\u001b[38;5;45m" },
    wrappers: {
      pill: { before: "<span class=\"pill\">", after: "</span>" },
      mdpill: { before: "**", after: "**" },
      htmlpill: { before: "<mark>", after: "</mark>" },
    },
    defaults: {
      jsonTheme: "pill",
      markdownTheme: "mdpill",
      htmlTheme: "htmlpill",
      plainTheme: "pill",
      ansiTheme: "ocean",
    },
  };

  assert.equal(
    applyConfiguredThemeDefaults("saved index excerpt:highlighted highlight:tags", { outputFormat: "json" }, themeConfig),
    "saved index excerpt:highlighted highlight:tags theme:pill",
  );
  assert.equal(
    applyConfiguredThemeDefaults("saved index excerpt:highlighted highlight:tags", { outputFormat: "markdown" }, themeConfig),
    "saved index excerpt:highlighted highlight:tags theme:mdpill",
  );
  assert.equal(
    applyConfiguredThemeDefaults("saved index excerpt:highlighted highlight:tags", { outputFormat: "html" }, themeConfig),
    "saved index excerpt:highlighted highlight:tags theme:htmlpill",
  );
  assert.equal(
    applyConfiguredThemeDefaults("saved index excerpt:highlighted highlight:plain", { outputFormat: "text" }, themeConfig),
    "saved index excerpt:highlighted highlight:plain theme:pill",
  );
  assert.equal(
    applyConfiguredThemeDefaults("saved index excerpt:highlighted highlight:ansi", { outputFormat: "text" }, themeConfig),
    "saved index excerpt:highlighted highlight:ansi theme:ocean",
  );
  assert.equal(
    applyConfiguredThemeDefaults("saved index excerpt:highlighted highlight:tags theme:custom", { outputFormat: "json" }, themeConfig),
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
          markdownTheme: "pill",
          htmlTheme: "pill",
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
    markdownTheme: "pill",
    htmlTheme: "pill",
    ansiTheme: "ocean",
  });
});

test("formatAskOutput renders markdown and html responses", () => {
  const payload = {
    source: "index",
    indexPath: "/tmp/.grounded-workspace-index.json",
    answer: "Grounded answer.",
    matches: [
      {
        path: "README.md",
        chunk: { startLine: 3, endLine: 5 },
        score: 12.5,
        excerpt: "<mark>grounded</mark> evidence",
        why: {
          tokenScore: 4,
          pathScore: 0,
          coverageScore: 3,
          phraseScore: 2,
          densityScore: 1.5,
          retrievalBias: 2,
          matchedTerms: ["grounded"],
          phraseHits: ["grounded answer"],
          pathHits: ["readme"],
        },
      },
    ],
  };

  const markdown = formatAskOutput(payload, "markdown");
  assert.match(markdown, /# grounded-workspace answer/);
  assert.match(markdown, /## Evidence/);
  assert.match(markdown, /<mark>grounded<\/mark> evidence/);

  const html = formatAskOutput(payload, "html");
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<h2>Evidence<\/h2>/);
  assert.match(html, /<mark>grounded<\/mark> evidence/);
});

test("formatIndexOutput renders text, markdown, and html responses", () => {
  const payload = {
    command: "index",
    root: "/tmp/workspace",
    indexPath: "/tmp/workspace/.grounded-workspace-index.json",
    generatedAt: "2026-04-01T00:00:00.000Z",
    filesIndexed: 2,
    chunksIndexed: 5,
    incremental: { enabled: true, reusedFiles: 1, changedFiles: 1, deletedFiles: 0 },
    files: ["src/cli.js", "README.md"],
  };

  const text = formatIndexOutput(payload, "text");
  const markdown = formatIndexOutput(payload, "markdown");
  const html = formatIndexOutput(payload, "html");

  assert.match(text, /Indexed \/tmp\/workspace/);
  assert.match(text, /Summary: Indexed 2 files into 5 chunks; reused 1 files, rebuilt 1, deleted 0\./);
  assert.match(text, /Incremental stats: reused=1 changed=1 deleted=0/);
  assert.match(markdown, /# grounded-workspace index/);
  assert.match(markdown, /Summary: Indexed 2 files into 5 chunks; reused 1 files, rebuilt 1, deleted 0\./);
  assert.match(markdown, /- `src\/cli\.js`/);
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /Summary: Indexed 2 files into 5 chunks; reused 1 files, rebuilt 1, deleted 0\./);
  assert.match(html, /Incremental stats: reused=1 changed=1 deleted=0/);
});

test("formatIndexOutput renders refresh-specific summaries", () => {
  const output = formatIndexOutput({
    command: "refresh",
    root: "/tmp/workspace",
    indexPath: "/tmp/workspace/.grounded-workspace-index.json",
    generatedAt: "2026-04-01T00:00:00.000Z",
    filesIndexed: 2,
    chunksIndexed: 5,
    incremental: { enabled: true, reusedFiles: 1, changedFiles: 1, deletedFiles: 0 },
    files: ["src/cli.js", "README.md"],
  }, "text");

  assert.match(output, /Refreshed \/tmp\/workspace/);
  assert.match(output, /Summary: Refreshed 2 files into 5 chunks; reused 1 files, rebuilt 1, deleted 0\./);
});

test("mergeInvestigationHits groups repeated evidence and rankInvestigationFiles orders file totals", () => {
  const evidence = mergeInvestigationHits([
    {
      query: "profile defaults",
      matches: [
        {
          path: "src/cli.js",
          chunk: { startLine: 10, endLine: 20 },
          score: 9,
          excerpt: "first excerpt",
          rawExcerpt: "first excerpt",
          why: { tokenScore: 1, matchedTerms: [], phraseHits: [], pathHits: [] },
        },
        {
          path: "README.md",
          chunk: { startLine: 1, endLine: 8 },
          score: 4,
          excerpt: "docs excerpt",
          rawExcerpt: "docs excerpt",
          why: { tokenScore: 1, matchedTerms: [], phraseHits: [], pathHits: [] },
        },
      ],
    },
    {
      query: "profile defaults path:src",
      matches: [
        {
          path: "src/cli.js",
          chunk: { startLine: 10, endLine: 20 },
          score: 6,
          excerpt: "second excerpt",
          rawExcerpt: "second excerpt",
          why: { tokenScore: 2, matchedTerms: [], phraseHits: [], pathHits: [] },
        },
      ],
    },
  ]);

  assert.equal(evidence[0].path, "src/cli.js");
  assert.equal(evidence[0].score, 15);
  assert.deepEqual(evidence[0].queries, ["profile defaults", "profile defaults path:src"]);

  const files = rankInvestigationFiles(evidence);
  assert.deepEqual(files, [
    { path: "src/cli.js", score: 23, evidenceCount: 1 },
    { path: "README.md", score: -2, evidenceCount: 1 },
  ]);
});

test("selectInvestigationEvidence keeps top files represented before adding extra matches", () => {
  const evidence = [
    { path: "src/cli.js", chunk: { startLine: 10, endLine: 20 }, score: 15, queries: ["q1"], excerpt: "src-1" },
    { path: "README.md", chunk: { startLine: 1, endLine: 20 }, score: 14, queries: ["q1"], excerpt: "readme-1" },
    { path: "README.md", chunk: { startLine: 21, endLine: 40 }, score: 13, queries: ["q2"], excerpt: "readme-2" },
    { path: "test/indexer.test.js", chunk: { startLine: 50, endLine: 70 }, score: 12, queries: ["q3"], excerpt: "test-1" },
    { path: "README.md", chunk: { startLine: 41, endLine: 60 }, score: 11, queries: ["q4"], excerpt: "readme-3" },
  ];

  const keyFiles = [
    { path: "src/cli.js", score: 15, evidenceCount: 1 },
    { path: "README.md", score: 27, evidenceCount: 3 },
    { path: "test/indexer.test.js", score: 12, evidenceCount: 1 },
  ];

  assert.deepEqual(
    selectInvestigationEvidence(evidence, keyFiles, 4).map((match) => `${match.path}:${match.chunk.startLine}`),
    [
      "src/cli.js:10",
      "README.md:1",
      "test/indexer.test.js:50",
      "README.md:21",
    ],
  );
});

test("selectInvestigationEvidence compacts long excerpts around the most relevant lines", () => {
  const selected = selectInvestigationEvidence(
    [
      {
        path: "src/cli.js",
        chunk: { startLine: 100, endLine: 111 },
        score: 18,
        queries: ["profile defaults path:src"],
        rawExcerpt: [
          "line 100 filler",
          "line 101 filler",
          "const helper = 1;",
          "line 103 filler",
          "profile defaults are merged here",
          "line 105 filler",
          "return resolvedDefaults;",
          "line 107 filler",
          "line 108 filler",
          "line 109 filler",
          "line 110 filler",
          "line 111 filler",
        ].join("\n"),
        excerpt: "unused",
        why: {
          matchedTerms: ["profile", "defaults"],
          phraseHits: ["profile defaults"],
          pathHits: ["cli"],
        },
      },
    ],
    [{ path: "src/cli.js", score: 18, evidenceCount: 1 }],
    4,
  );

  assert.equal(selected[0].chunk.startLine, 102);
  assert.equal(selected[0].chunk.endLine, 109);
  assert.match(selected[0].excerpt, /^\.\.\.\nconst helper = 1;/);
  assert.match(selected[0].excerpt, /profile defaults are merged here/);
  assert.match(selected[0].excerpt, /return resolvedDefaults;/);
  assert.match(selected[0].excerpt, /\n\.\.\.$/);
});

test("selectInvestigationEvidence drops near-duplicate excerpts from the same file", () => {
  const evidence = [
    {
      path: "src/cli.js",
      chunk: { startLine: 100, endLine: 108 },
      score: 20,
      queries: ["q1"],
      rawExcerpt: "export function applyProfileDefaults(defaults = {}, customProfiles = {}) {\n  return defaults;\n}",
      excerpt: "export function applyProfileDefaults(defaults = {}, customProfiles = {}) {\n  return defaults;\n}",
      why: { matchedTerms: ["profile", "defaults"] },
    },
    {
      path: "src/cli.js",
      chunk: { startLine: 104, endLine: 112 },
      score: 19,
      queries: ["q1"],
      rawExcerpt: "export function applyProfileDefaults(defaults = {}, customProfiles = {}) {\n  return defaults;\n}\n// nearby duplicate",
      excerpt: "export function applyProfileDefaults(defaults = {}, customProfiles = {}) {\n  return defaults;\n}\n// nearby duplicate",
      why: { matchedTerms: ["profile", "defaults"] },
    },
    {
      path: "README.md",
      chunk: { startLine: 20, endLine: 28 },
      score: 10,
      queries: ["q1"],
      rawExcerpt: "Default precedence:\n- CLI flags win over environment defaults.",
      excerpt: "Default precedence:\n- CLI flags win over environment defaults.",
      why: { matchedTerms: ["defaults"] },
    },
  ];

  const keyFiles = rankInvestigationFiles(evidence, 2, "code");
  const selected = selectInvestigationEvidence(evidence, keyFiles, 3, "code");

  assert.deepEqual(selected.map((match) => `${match.path}:${match.chunk.startLine}`), [
    "src/cli.js:100",
    "README.md:20",
  ]);
});

test("deriveInvestigationGaps reports missing evidence and narrow coverage", () => {
  assert.deepEqual(
    deriveInvestigationGaps({
      queries: ["profile defaults", "profile defaults path:src"],
      results: [
        { query: "profile defaults", matches: [{ path: "src/cli.js" }] },
        { query: "profile defaults path:src", matches: [] },
      ],
      keyFiles: [{ path: "src/cli.js", score: 15, evidenceCount: 1 }],
      evidence: [{ path: "src/cli.js", score: 15 }],
      intent: "code",
      confidence: { level: "partial", reason: "useful evidence, but coverage is narrow" },
    }),
    [
      "Some derived searches returned no evidence: profile defaults path:src",
      "Evidence is concentrated in a single file; confirm nearby code directly.",
      "Next step: read the top src file directly and rerun with the specific function or module name.",
    ],
  );
});

test("deriveInvestigationGaps suggests a next step when no evidence is found", () => {
  assert.deepEqual(
    deriveInvestigationGaps({
      queries: ["where is this documented"],
      results: [{ query: "where is this documented", matches: [] }],
      keyFiles: [],
      evidence: [],
      intent: "docs",
      confidence: { level: "weak", reason: "no grounded evidence" },
    }),
    [
      "No grounded matches were found for the investigation query set.",
      "Next step: rerun with a docs-focused question or add path:docs/ext:md terms.",
      "Some derived searches returned no evidence: where is this documented",
    ],
  );
});

test("deriveInvestigationGaps warns when a saved index is stale", () => {
  assert.deepEqual(
    deriveInvestigationGaps({
      queries: ["profile defaults", "profile defaults path:src"],
      results: [
        { query: "profile defaults", matches: [{ path: "src/cli.js" }] },
        { query: "profile defaults path:src", matches: [{ path: "src/cli.js" }] },
      ],
      keyFiles: [{ path: "src/cli.js", score: 24, evidenceCount: 2 }],
      evidence: [
        { path: "src/cli.js", score: 14 },
        { path: "src/cli.js", score: 10 },
      ],
      intent: "code",
      confidence: { level: "strong", reason: "multiple grounded excerpts with a clear top file" },
      source: "index",
      root: "/tmp/workspace",
      freshness: {
        status: "stale",
        reason: "src/cli.js changed after the saved index was generated",
        latestFilePath: "src/cli.js",
        latestFileMtime: "2026-04-01T00:00:00.000Z",
      },
    }),
    [
      "Evidence is concentrated in a single file; confirm nearby code directly.",
      "Saved index appears stale; rerun `grounded-workspace index \"/tmp/workspace\"` before relying on this investigation.",
    ],
  );
});

test("deriveInvestigationGaps suggests repairing an invalid saved index", () => {
  assert.deepEqual(
    deriveInvestigationGaps({
      queries: ["notes"],
      results: [{ query: "notes", matches: [{ path: "notes.txt" }] }],
      keyFiles: [{ path: "notes.txt", score: 18, evidenceCount: 1 }],
      evidence: [{ path: "notes.txt", score: 18 }],
      intent: "general",
      confidence: { level: "partial", reason: "useful evidence, but coverage is narrow" },
      source: "scan",
      sourceReason: "saved index invalid JSON",
      root: "/tmp/workspace",
    }),
    [
      "Evidence is concentrated in a single file; confirm nearby code directly.",
      "Only one investigation query was available, so coverage may be narrow.",
      "Next step: read the strongest file directly and refine the question around the missing detail.",
      "Saved index is invalid JSON; rerun `grounded-workspace index \"/tmp/workspace\"` to repair it.",
    ],
  );
});

test("deriveInvestigationGaps suggests repairing an unreadable saved index", () => {
  assert.deepEqual(
    deriveInvestigationGaps({
      queries: ["notes"],
      results: [{ query: "notes", matches: [{ path: "notes.txt" }] }],
      keyFiles: [{ path: "notes.txt", score: 18, evidenceCount: 1 }],
      evidence: [{ path: "notes.txt", score: 18 }],
      intent: "general",
      confidence: { level: "partial", reason: "useful evidence, but coverage is narrow" },
      source: "scan",
      sourceReason: "saved index unreadable",
      root: "/tmp/workspace",
    }),
    [
      "Evidence is concentrated in a single file; confirm nearby code directly.",
      "Only one investigation query was available, so coverage may be narrow.",
      "Next step: read the strongest file directly and refine the question around the missing detail.",
      "Saved index is unreadable; check file permissions or rerun `grounded-workspace index \"/tmp/workspace\"` to replace it.",
    ],
  );
});

test("formatInvestigateOutput renders a grounded investigation report", () => {
  const output = formatInvestigateOutput({
    source: "index",
    sourceReason: "loaded saved index",
    sourceMode: "index",
    root: "/tmp/workspace",
    indexPath: "/tmp/.grounded-workspace-index.json",
    generatedAt: "2026-04-01T00:00:00.000Z",
    freshness: { status: "stale", reason: "saved index differs from current files (1 changed)", changedFiles: 1, deletedFiles: 0, newFiles: 0 },
    refresh: { requested: true, mode: "if-stale", performed: false, indexMode: "incremental", reason: "saved index was already fresh" },
    question: "how do profile defaults work",
    queries: ["how do profile defaults work", "profile default defaults path:src"],
    summary: "Defaults are layered in src/cli.js.",
    confidence: { level: "strong", reason: "multiple grounded excerpts with a clear top file" },
    keyFiles: [{ path: "src/cli.js", score: 15, evidenceCount: 2 }],
    evidence: [
      {
        path: "src/cli.js",
        chunk: { startLine: 10, endLine: 20 },
        score: 15,
        kind: "implementation",
        why: {
          matchedTerms: ["profile", "defaults"],
          phraseHits: ["profile defaults"],
          pathHits: ["cli"],
        },
        queries: ["how do profile defaults work", "profile default defaults path:src"],
        excerpt: "resolved defaults live here",
      },
    ],
    gaps: ["Evidence is concentrated in a single file; confirm nearby code directly."],
  });

  assert.match(output, /Question: how do profile defaults work/);
  assert.match(output, /Source mode: index/);
  assert.match(output, /Source reason: loaded saved index/);
  assert.match(output, /Warnings:\n- Saved index appears stale \(1 changed, 0 deleted, 0 new\); rerun `grounded-workspace index "\/tmp\/workspace"` before relying on this investigation\./);
  assert.match(output, /Summary:\nDefaults are layered in src\/cli\.js\./);
  assert.match(output, /Confidence: strong \(multiple grounded excerpts with a clear top file\)/);
  assert.match(output, /Freshness: stale \(saved index differs from current files \(1 changed\)\) \[changed=1 deleted=0 new=0\]/);
  assert.match(output, /Refresh: not needed \(if-stale\) \[incremental\] - saved index was already fresh/);
  assert.match(output, /1\. src\/cli\.js \(score: 15, evidence: 2\)/);
  assert.match(output, /# src\/cli\.js:10-20 \(score: 15, queries: how do profile defaults work \| profile default defaults path:src\)/);
  assert.match(output, /kind: implementation/);
  assert.match(output, /reason: implementation bias; matched phrase: profile defaults; path hint: cli; matched terms: profile, defaults/);
  assert.match(output, /Gaps:\n- Evidence is concentrated in a single file; confirm nearby code directly\./);
});

test("formatInvestigateOutput omits low-signal stopwords from evidence reasons", () => {
  const output = formatInvestigateOutput({
    source: "index",
    sourceReason: "loaded saved index",
    sourceMode: "index",
    indexPath: "/tmp/.grounded-workspace-index.json",
    freshness: { status: "fresh", reason: "saved index is newer than indexed files" },
    question: "where is this documented in some missing manual",
    queries: ["where is this documented in some missing manual", "some missing manual"],
    summary: "Strongest grounded evidence for \"where is this documented in some missing manual\" is in README.md.",
    confidence: { level: "partial", reason: "useful evidence, but coverage is narrow" },
    keyFiles: [{ path: "README.md", score: 19.811, evidenceCount: 1 }],
    evidence: [
      {
        path: "README.md",
        chunk: { startLine: 3, endLine: 10 },
        score: 19.811,
        kind: "docs",
        why: {
          matchedTerms: ["is", "this", "in"],
          phraseHits: [],
          pathHits: [],
        },
        excerpt: "README excerpt",
        queries: ["where is this documented in some missing manual"],
      },
    ],
    gaps: ["Next step: read the top README/docs hits directly and refine the question around the missing detail."],
  });

  assert.match(output, /kind: docs/);
  assert.match(output, /reason: docs bias/);
  assert.doesNotMatch(output, /matched terms: is, this, in/);
});

test("formatInvestigateOutput can carry a safer fallback summary for vague docs investigations", () => {
  const output = formatInvestigateOutput({
    source: "index",
    sourceReason: "loaded saved index",
    sourceMode: "index",
    indexPath: "/tmp/.grounded-workspace-index.json",
    freshness: { status: "fresh", reason: "saved index is newer than indexed files" },
    question: "where is this documented in some missing manual",
    queries: ["where is this documented in some missing manual", "some missing manual"],
    summary: "Strongest grounded evidence for \"where is this documented in some missing manual\" is in README.md.",
    confidence: { level: "partial", reason: "useful evidence, but coverage is narrow" },
    keyFiles: [{ path: "README.md", score: 19.811, evidenceCount: 1 }],
    evidence: [],
    gaps: [],
  });

  assert.match(output, /Summary:\nStrongest grounded evidence for "where is this documented in some missing manual" is in README\.md\./);
});

test("formatInvestigateOutput surfaces corrupt saved-index warnings near the top", () => {
  const output = formatInvestigateOutput({
    source: "scan",
    sourceReason: "saved index invalid JSON",
    sourceMode: "scan",
    root: "/tmp/workspace",
    indexPath: "/tmp/.grounded-workspace-index.json",
    freshness: { status: "live", reason: "using a live scan" },
    question: "notes",
    queries: ["notes"],
    summary: "Strongest grounded evidence for \"notes\" is in notes.txt.",
    confidence: { level: "partial", reason: "useful evidence, but coverage is narrow" },
    keyFiles: [{ path: "notes.txt", score: 18, evidenceCount: 1 }],
    evidence: [],
    gaps: ["Saved index is invalid JSON; rerun `grounded-workspace index \"/tmp/workspace\"` to repair it."],
  });

  assert.match(output, /Warnings:\n- Saved index is invalid JSON; rerun `grounded-workspace index "\/tmp\/workspace"` to repair it\./);
  assert.match(output, /Gaps:\n- none/);
});

test("formatInvestigateOutput renders live-scan investigate runs without refresh metadata", () => {
  const output = formatInvestigateOutput({
    source: "scan",
    sourceReason: "forced live scan",
    sourceMode: "scan",
    indexPath: "/tmp/.grounded-workspace-index.json",
    freshness: { status: "live", reason: "using a live scan" },
    question: "how do profile defaults work",
    queries: ["how do profile defaults work"],
    summary: "Strongest grounded evidence for \"how do profile defaults work\" is in src/cli.js.",
    confidence: { level: "partial", reason: "grounded evidence exists, but support is mixed" },
    keyFiles: [{ path: "src/cli.js", score: 12, evidenceCount: 1 }],
    evidence: [],
    gaps: [],
  });

  assert.match(output, /Using live scan from \/tmp\/\.grounded-workspace-index\.json/);
  assert.match(output, /Source mode: scan/);
  assert.match(output, /Source reason: forced live scan/);
  assert.match(output, /Freshness: live \(using a live scan\)/);
  assert.doesNotMatch(output, /Refresh:/);
});

test("formatInvestigateOutput renders markdown investigations with warnings", () => {
  const output = formatInvestigateOutput({
    source: "scan",
    sourceReason: "saved index invalid JSON",
    sourceMode: "scan",
    root: "/tmp/workspace",
    indexPath: "/tmp/.grounded-workspace-index.json",
    freshness: { status: "live", reason: "using a live scan" },
    question: "notes",
    queries: ["notes"],
    summary: "Strongest grounded evidence for \"notes\" is in notes.txt.",
    confidence: { level: "partial", reason: "useful evidence, but coverage is narrow" },
    keyFiles: [{ path: "notes.txt", score: 18, evidenceCount: 1 }],
    evidence: [],
    gaps: ["Saved index is invalid JSON; rerun `grounded-workspace index \"/tmp/workspace\"` to repair it."],
  }, "markdown");

  assert.match(output, /# grounded-workspace investigation/);
  assert.match(output, /## Warnings/);
  assert.match(output, /- Saved index is invalid JSON; rerun `grounded-workspace index "\/tmp\/workspace"` to repair it\./);
  assert.match(output, /## Gaps\n\n- none/);
});

test("formatInvestigateOutput renders html investigations with warnings", () => {
  const output = formatInvestigateOutput({
    source: "index",
    sourceReason: "loaded saved index",
    sourceMode: "index",
    root: "/tmp/workspace",
    indexPath: "/tmp/.grounded-workspace-index.json",
    freshness: { status: "stale", reason: "saved index differs from current files (0 changed)", changedFiles: 0, deletedFiles: 0, newFiles: 0 },
    question: "how do profile defaults work",
    queries: ["how do profile defaults work"],
    summary: "Defaults are layered in src/cli.js.",
    confidence: { level: "partial", reason: "useful evidence, but coverage is narrow" },
    keyFiles: [{ path: "src/cli.js", score: 15, evidenceCount: 1 }],
    evidence: [],
    gaps: ["Saved index appears stale (0 changed, 0 deleted, 0 new); rerun `grounded-workspace index \"/tmp/workspace\"` before relying on this investigation."],
  }, "html");

  assert.match(output, /<!doctype html>/i);
  assert.match(output, /<h2>Warnings<\/h2>/);
  assert.match(output, /Saved index appears stale \(0 changed, 0 deleted, 0 new\); rerun `grounded-workspace index &quot;\/tmp\/workspace&quot;` before relying on this investigation\./);
  assert.match(output, /<h2>Gaps<\/h2>\s*<p>none<\/p>/);
});

test("serializeInvestigatePayload keeps compact evidence fields for json output", () => {
  const payload = serializeInvestigatePayload({
    root: "/tmp/workspace",
    question: "how do profile defaults work",
    source: "index",
    sourceReason: "loaded saved index",
    sourceMode: "index",
    indexPath: "/tmp/.grounded-workspace-index.json",
    generatedAt: "2026-04-01T00:00:00.000Z",
    freshness: { status: "fresh", reason: "saved index matches current indexed files", changedFiles: 0, deletedFiles: 0, newFiles: 0 },
    refresh: { requested: true, mode: "if-stale", performed: false, indexMode: "incremental", reason: "saved index was already fresh" },
    queries: ["q1"],
    summary: "summary",
    confidence: { level: "partial", reason: "grounded evidence exists, but support is mixed" },
    keyFiles: [{ path: "src/cli.js", score: 12, evidenceCount: 1 }],
    evidence: [
      {
        path: "src/cli.js",
        chunk: { startLine: 10, endLine: 14 },
        score: 12,
        kind: "implementation",
        why: { matchedTerms: ["profile"], phraseHits: [], pathHits: [] },
        excerpt: "compact excerpt",
        queries: ["q1"],
        rawExcerpt: "very long raw excerpt",
        highlightedExcerpt: "very long highlighted excerpt",
      },
    ],
    gaps: ["gap"],
  }, {});

  assert.deepEqual(payload, {
    root: "/tmp/workspace",
    question: "how do profile defaults work",
    source: "index",
    sourceReason: "loaded saved index",
    sourceMode: "index",
    indexPath: "/tmp/.grounded-workspace-index.json",
    generatedAt: "2026-04-01T00:00:00.000Z",
    freshness: { status: "fresh", reason: "saved index matches current indexed files", changedFiles: 0, deletedFiles: 0, newFiles: 0 },
    refresh: { requested: true, mode: "if-stale", performed: false, indexMode: "incremental", reason: "saved index was already fresh" },
    queries: ["q1"],
    summary: "summary",
    confidence: { level: "partial", reason: "grounded evidence exists, but support is mixed" },
    keyFiles: [{ path: "src/cli.js", score: 12, evidenceCount: 1 }],
    evidence: [
      {
        path: "src/cli.js",
        chunk: { startLine: 10, endLine: 14 },
        score: 12,
        kind: "implementation",
        reason: "implementation bias; matched terms: profile",
        why: { matchedTerms: ["profile"], phraseHits: [], pathHits: [] },
        excerpt: "compact excerpt",
        queries: ["q1"],
      },
    ],
    gaps: ["gap"],
  });
});

test("serializeInvestigatePayload can include raw evidence fields on demand", () => {
  const payload = serializeInvestigatePayload({
    root: "/tmp/workspace",
    question: "how do profile defaults work",
    source: "index",
    sourceReason: "loaded saved index",
    sourceMode: "index",
    indexPath: "/tmp/.grounded-workspace-index.json",
    generatedAt: "2026-04-01T00:00:00.000Z",
    freshness: { status: "fresh", reason: "saved index matches current indexed files", changedFiles: 0, deletedFiles: 0, newFiles: 0 },
    refresh: { requested: true, mode: "always", performed: true, indexMode: "incremental", reason: "forced by --refresh-index" },
    queries: ["q1"],
    summary: "summary",
    confidence: { level: "partial", reason: "grounded evidence exists, but support is mixed" },
    keyFiles: [{ path: "src/cli.js", score: 12, evidenceCount: 1 }],
    evidence: [
      {
        path: "src/cli.js",
        chunk: { startLine: 10, endLine: 14 },
        score: 12,
        kind: "implementation",
        why: { matchedTerms: ["profile"], phraseHits: [], pathHits: [] },
        excerpt: "compact excerpt",
        queries: ["q1"],
        rawExcerpt: "very long raw excerpt",
        highlightedExcerpt: "very long highlighted excerpt",
      },
    ],
    gaps: ["gap"],
  }, { includeRaw: true });

  assert.equal(payload.evidence[0].kind, "implementation");
  assert.equal(payload.evidence[0].reason, "implementation bias; matched terms: profile");
  assert.equal(payload.sourceReason, "loaded saved index");
  assert.equal(payload.sourceMode, "index");
  assert.deepEqual(payload.refresh, { requested: true, mode: "always", performed: true, indexMode: "incremental", reason: "forced by --refresh-index" });
  assert.equal(payload.evidence[0].rawExcerpt, "very long raw excerpt");
  assert.equal(payload.evidence[0].highlightedExcerpt, "very long highlighted excerpt");
});

test("getIndexFreshness reports when indexed files changed after index generation", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "grounded-workspace-"));
  await fs.writeFile(path.join(rootDir, "notes.txt"), "first version\n", "utf8");
  const index = await buildIndex(rootDir);
  await saveIndex(rootDir, index);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await fs.writeFile(path.join(rootDir, "notes.txt"), "second version\n", "utf8");

  const freshness = await getIndexFreshness(rootDir, index.generatedAt);
  assert.equal(freshness.status, "stale");
  assert.equal(freshness.latestFilePath, "notes.txt");
});

test("getIndexFreshness can report changed, deleted, and new file counts from saved index metadata", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "grounded-workspace-"));
  await fs.writeFile(path.join(rootDir, "a.txt"), "alpha\n", "utf8");
  await fs.writeFile(path.join(rootDir, "b.txt"), "bravo\n", "utf8");

  const index = await buildIndex(rootDir);
  await saveIndex(rootDir, index);
  await new Promise((resolve) => setTimeout(resolve, 20));

  await fs.writeFile(path.join(rootDir, "a.txt"), "alpha changed\n", "utf8");
  await fs.unlink(path.join(rootDir, "b.txt"));
  await fs.writeFile(path.join(rootDir, "c.txt"), "charlie\n", "utf8");

  const freshness = await getIndexFreshness(rootDir, { generatedAt: index.generatedAt, files: index.files });
  assert.equal(freshness.status, "stale");
  assert.equal(freshness.changedFiles, 1);
  assert.equal(freshness.deletedFiles, 1);
  assert.equal(freshness.newFiles, 1);
});

test("rankInvestigationFiles and selectInvestigationEvidence respect explicit limits", () => {
  const evidence = [
    { path: "src/cli.js", chunk: { startLine: 10, endLine: 20 }, score: 15, queries: ["q1"], rawExcerpt: "a", excerpt: "a", why: { matchedTerms: [], phraseHits: [], pathHits: [] } },
    { path: "README.md", chunk: { startLine: 1, endLine: 8 }, score: 14, queries: ["q1"], rawExcerpt: "b", excerpt: "b", why: { matchedTerms: [], phraseHits: [], pathHits: [] } },
    { path: "test/indexer.test.js", chunk: { startLine: 50, endLine: 70 }, score: 13, queries: ["q1"], rawExcerpt: "c", excerpt: "c", why: { matchedTerms: [], phraseHits: [], pathHits: [] } },
  ];

  const keyFiles = rankInvestigationFiles(evidence, 2);
  assert.deepEqual(keyFiles.map((file) => file.path), ["src/cli.js", "test/indexer.test.js"]);

  const selected = selectInvestigationEvidence(evidence, keyFiles, 2);
  assert.equal(selected.length, 2);
  assert.deepEqual(selected.map((match) => match.path), ["src/cli.js", "test/indexer.test.js"]);
  assert.deepEqual(selected.map((match) => match.kind), ["reference", "tests"]);
});

test("investigate prefers implementation evidence over help-style matches", () => {
  const evidence = [
    {
      path: "src/cli.js",
      chunk: { startLine: 100, endLine: 110 },
      score: 12,
      queries: ["q1"],
      rawExcerpt: "Usage:\n  --theme <mode> set a default theme\nNotes:\n  excerpt:highlighted defaults to ansi",
      excerpt: "help excerpt",
      why: { matchedTerms: ["theme", "default"] },
    },
    {
      path: "src/cli.js",
      chunk: { startLine: 200, endLine: 210 },
      score: 11,
      queries: ["q1"],
      rawExcerpt: "export function applyProfileDefaults(defaults = {}, customProfiles = {}) {\n  return defaults.theme ?? profile.theme ?? null;\n}",
      excerpt: "code excerpt",
      why: { matchedTerms: ["theme", "default"] },
    },
  ];

  const keyFiles = rankInvestigationFiles(evidence, 1);
  const selected = selectInvestigationEvidence(evidence, keyFiles, 1);

  assert.equal(selected[0].chunk.startLine, 200);
});

test("investigate suppresses dominant help blocks when implementation evidence exists in the same file", () => {
  const evidence = [
    {
      path: "src/cli.js",
      chunk: { startLine: 340, endLine: 348 },
      score: 57.635,
      queries: ["q1"],
      rawExcerpt: [
        "--json            emit machine-readable JSON",
        "  --profile <name>  choose a built-in render profile",
        "  --format <mode>   choose text, json, markdown, or html output",
        "  --color <mode>    choose auto, always, or never for terminal ansi behavior",
        "Notes:",
        "  excerpt:highlighted defaults to ansi",
      ].join("\n"),
      excerpt: "help excerpt",
      why: { matchedTerms: ["profile", "defaults"] },
    },
    {
      path: "src/cli.js",
      chunk: { startLine: 390, endLine: 397 },
      score: 16.414,
      queries: ["q1"],
      rawExcerpt: [
        "export function applyProfileDefaults(defaults = {}, customProfiles = {}) {",
        "  const profile = resolveProfileDefinition(defaults.profile, customProfiles);",
        "  if (!profile) {",
        "    return defaults;",
        "  }",
      ].join("\n"),
      excerpt: "code excerpt",
      why: { matchedTerms: ["profile", "defaults"] },
    },
  ];

  const keyFiles = rankInvestigationFiles(evidence, 1);
  const selected = selectInvestigationEvidence(evidence, keyFiles, 1);

  assert.equal(selected[0].chunk.startLine, 390);
});

test("investigate downranks test and spec examples that quote the exact question text", () => {
  const evidence = [
    {
      path: "test/indexer.test.js",
      chunk: { startLine: 100, endLine: 110 },
      score: 40,
      queries: ["how do profile defaults work"],
      rawExcerpt: "test(\"x\", () => { assert.match(output, /Question: how do profile defaults work/); });",
      excerpt: "test excerpt",
      why: { matchedTerms: ["profile", "defaults"] },
    },
    {
      path: "docs/investigate-spec.md",
      chunk: { startLine: 10, endLine: 20 },
      score: 42,
      queries: ["how do profile defaults work"],
      rawExcerpt: "{ \"question\": \"how do profile defaults work\", \"summary\": [\"Profile defaults are resolved in src/cli.js\"] }",
      excerpt: "spec excerpt",
      why: { matchedTerms: ["profile", "defaults"] },
    },
    {
      path: "src/cli.js",
      chunk: { startLine: 390, endLine: 397 },
      score: 16,
      queries: ["how do profile defaults work"],
      rawExcerpt: "export function applyProfileDefaults(defaults = {}, customProfiles = {}) {\n  return defaults;\n}",
      excerpt: "code excerpt",
      why: { matchedTerms: ["profile", "defaults"] },
    },
  ];

  const keyFiles = rankInvestigationFiles(evidence, 1);
  assert.deepEqual(keyFiles.map((file) => file.path), ["src/cli.js"]);
});

test("investigate downranks js fixture payloads that mirror investigate output", () => {
  const evidence = [
    {
      path: "test/indexer.test.js",
      chunk: { startLine: 150, endLine: 160 },
      score: 30,
      queries: ["how do profile defaults work"],
      rawExcerpt: "question: \"how do profile defaults work\",\nsummary: \"Defaults are layered in src/cli.js.\",\nkeyFiles: [{ path: \"src/cli.js\" }],\nevidence: [",
      excerpt: "fixture excerpt",
      why: { matchedTerms: ["profile", "defaults"] },
    },
    {
      path: "src/cli.js",
      chunk: { startLine: 390, endLine: 397 },
      score: 16,
      queries: ["how do profile defaults work"],
      rawExcerpt: "export function applyProfileDefaults(defaults = {}, customProfiles = {}) {\n  return defaults;\n}",
      excerpt: "code excerpt",
      why: { matchedTerms: ["profile", "defaults"] },
    },
  ];

  const keyFiles = rankInvestigationFiles(evidence, 1);
  assert.deepEqual(keyFiles.map((file) => file.path), ["src/cli.js"]);
});

test("investigate downranks repo self-fixtures that describe cli internals", () => {
  const evidence = [
    {
      path: "test/indexer.test.js",
      chunk: { startLine: 150, endLine: 160 },
      score: 28,
      queries: ["how do profile defaults work"],
      rawExcerpt: "summary: \"Defaults are layered in src/cli.js.\"\nserializeInvestigatePayload({ question: \"how do profile defaults work\" })",
      excerpt: "fixture excerpt",
      why: { matchedTerms: ["profile", "defaults"] },
    },
    {
      path: "docs/investigate-spec.md",
      chunk: { startLine: 60, endLine: 70 },
      score: 30,
      queries: ["how do profile defaults work"],
      rawExcerpt: "{ \"question\": \"how do profile defaults work\", \"summary\": [\"Profile defaults are resolved in src/cli.js\"] }",
      excerpt: "spec excerpt",
      why: { matchedTerms: ["profile", "defaults"] },
    },
    {
      path: "src/cli.js",
      chunk: { startLine: 438, endLine: 445 },
      score: 16,
      queries: ["how do profile defaults work"],
      rawExcerpt: "export function applyProfileDefaults(defaults = {}, customProfiles = {}) {\n  const profile = resolveProfileDefinition(defaults.profile, customProfiles);\n  return defaults;\n}",
      excerpt: "code excerpt",
      why: { matchedTerms: ["profile", "defaults"] },
    },
  ];

  const keyFiles = rankInvestigationFiles(evidence, 1, "code");
  assert.deepEqual(keyFiles.map((file) => file.path), ["src/cli.js"]);
});

test("investigate intent routing biases ranking toward docs or tests when requested", () => {
  const evidence = [
    {
      path: "src/cli.js",
      chunk: { startLine: 390, endLine: 397 },
      score: 16,
      queries: ["q1"],
      rawExcerpt: "export function applyProfileDefaults(defaults = {}, customProfiles = {}) {\n  return defaults;\n}",
      excerpt: "code excerpt",
      why: { matchedTerms: ["profile", "defaults"] },
    },
    {
      path: "README.md",
      chunk: { startLine: 229, endLine: 236 },
      score: 14,
      queries: ["q1"],
      rawExcerpt: "Default precedence:\n- CLI flags win over environment defaults.",
      excerpt: "docs excerpt",
      why: { matchedTerms: ["defaults"] },
    },
    {
      path: "test/indexer.test.js",
      chunk: { startLine: 100, endLine: 110 },
      score: 14,
      queries: ["q1"],
      rawExcerpt: "test(\"defaults\", () => { assert.equal(value, expected); });",
      excerpt: "tests excerpt",
      why: { matchedTerms: ["defaults"] },
    },
  ];

  assert.deepEqual(rankInvestigationFiles(evidence, 1, "docs").map((file) => file.path), ["README.md"]);
  assert.deepEqual(rankInvestigationFiles(evidence, 1, "tests").map((file) => file.path), ["test/indexer.test.js"]);
});

test("formatProfilesOutput renders text, markdown, and html responses", () => {
  const payload = {
    root: "/tmp/workspace",
    activeDefaults: {
      ask: {
        profile: "docs_bundle",
        format: "markdown",
        color: "never",
        explain: "terse",
        excerpt: "highlighted",
        highlight: "tags",
        theme: "pill",
      },
      index: {
        profile: null,
        format: "json",
        color: null,
        explain: null,
        excerpt: null,
        highlight: null,
        theme: null,
      },
    },
    activeDefaultSources: {
      ask: {
        profile: "cli",
        format: "cli",
        color: "env",
        explain: "user",
        excerpt: "cli",
        highlight: "cli",
        theme: "user+profile",
      },
      index: {
        profile: "unset",
        format: "env",
        color: "unset",
        explain: "unset",
        excerpt: "unset",
        highlight: "unset",
        theme: "unset",
      },
    },
    effectiveOutputDefaults: {
      text: {
        color: "auto",
        excerpt: "highlighted",
        highlight: "ansi",
        theme: "yellow",
      },
      json: {
        color: "auto",
        excerpt: "highlighted",
        highlight: "tags",
        theme: "pill",
      },
      markdown: {
        color: "auto",
        excerpt: "highlighted",
        highlight: "tags",
        theme: "pill",
      },
      html: {
        color: "auto",
        excerpt: "highlighted",
        highlight: "tags",
        theme: "pill",
      },
    },
    effectiveOutputSources: {
      text: {
        color: "env",
        excerpt: "cli",
        highlight: "cli",
        theme: "user+profile",
      },
      json: {
        color: "env",
        excerpt: "cli",
        highlight: "cli+output",
        theme: "workspace-output",
      },
      markdown: {
        color: "env",
        excerpt: "cli",
        highlight: "cli+output",
        theme: "workspace-output",
      },
      html: {
        color: "env",
        excerpt: "cli",
        highlight: "cli+output",
        theme: "workspace-output",
      },
    },
    profiles: [
      {
        name: "docs_bundle",
        source: "user",
        extends: "docs_base",
        resolved: {
          format: "markdown",
          color: "never",
          explain: "terse",
          excerpt: "highlighted",
          highlight: "tags",
          theme: "pill",
        },
      },
    ],
  };

  const text = formatProfilesOutput(payload, "text");
  assert.match(text, /Available profiles for \/tmp\/workspace/);
  assert.match(text, /Active defaults:/);
  assert.match(text, /ask: profile=docs_bundle \[cli\] format=markdown \[cli\]/);
  assert.match(text, /Effective ask defaults by output:/);
  assert.match(text, /json: color=auto \[env\] excerpt=highlighted \[cli\] highlight=tags \[cli\+output\] theme=pill \[workspace-output\]/);
  assert.match(text, /docs_bundle \[user\] extends docs_base/);

  const markdown = formatProfilesOutput(payload, "markdown");
  assert.match(markdown, /# grounded-workspace profiles/);
  assert.match(markdown, /## Active defaults/);
  assert.match(markdown, /## Effective ask defaults by output/);
  assert.match(markdown, /Source: user extends `docs_base`/);

  const html = formatProfilesOutput(payload, "html");
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<h2>Active defaults<\/h2>/);
  assert.match(html, /<h2>Effective ask defaults by output<\/h2>/);
  assert.match(html, /Source: user extends <code>docs_base<\/code>/);
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
  assert.equal(loaded.sourceReason, "loaded saved index");
  assert.equal(loaded.documents[0].path, "notes.txt");
});

test("buildIndex can incrementally reuse unchanged files and prune deleted ones", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "grounded-workspace-"));
  await fs.writeFile(path.join(rootDir, "a.txt"), "alpha\n", "utf8");
  await fs.writeFile(path.join(rootDir, "b.txt"), "bravo\n", "utf8");

  const initialIndex = await buildIndex(rootDir);
  await saveIndex(rootDir, initialIndex);
  await new Promise((resolve) => setTimeout(resolve, 20));

  await fs.writeFile(path.join(rootDir, "a.txt"), "alpha changed\n", "utf8");
  await fs.unlink(path.join(rootDir, "b.txt"));
  await fs.writeFile(path.join(rootDir, "c.txt"), "charlie\n", "utf8");

  const incrementalIndex = await buildIndex(rootDir, { incremental: true });

  assert.equal(incrementalIndex.incremental.enabled, true);
  assert.equal(incrementalIndex.incremental.reusedFiles, 0);
  assert.equal(incrementalIndex.incremental.changedFiles, 2);
  assert.equal(incrementalIndex.incremental.deletedFiles, 1);
  assert.deepEqual(incrementalIndex.files.map((file) => file.path).sort(), ["a.txt", "c.txt"]);
  assert.deepEqual([...new Set(incrementalIndex.documents.map((document) => document.path))].sort(), ["a.txt", "c.txt"]);
});

test("loadDocuments reports scan fallback reason when the saved index is missing", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "grounded-workspace-"));
  await fs.writeFile(path.join(rootDir, "notes.txt"), "Live scan fallback.\n", "utf8");

  const loaded = await loadDocuments(rootDir);
  assert.equal(loaded.source, "scan");
  assert.equal(loaded.sourceReason, "saved index missing");
  assert.equal(loaded.documents[0].path, "notes.txt");
});

test("loadDocuments reports scan fallback reason when the saved index has invalid json", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "grounded-workspace-"));
  await fs.writeFile(path.join(rootDir, "notes.txt"), "Live scan fallback.\n", "utf8");
  await fs.writeFile(path.join(rootDir, ".grounded-workspace-index.json"), "{not valid json\n", "utf8");

  const loaded = await loadDocuments(rootDir);
  assert.equal(loaded.source, "scan");
  assert.equal(loaded.sourceReason, "saved index invalid JSON");
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

test("buildIndex splits help-style sections away from nearby implementation chunks", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "grounded-workspace-"));
  const fileContent = [
    "export function applyProfileDefaults(defaults = {}, customProfiles = {}) {",
    "  const profile = resolveProfileDefinition(defaults.profile, customProfiles);",
    "  if (!profile) {",
    "    return defaults;",
    "  }",
    "  return profile;",
    "}",
    "",
    "Usage:",
    "  --json emit json",
    "  --profile choose profile",
    "  --format choose format",
    "Notes:",
    "  excerpt:highlighted defaults to ansi",
    "",
    "export function resolveCommandDefaults() {",
    "  return {};",
    "}",
  ].join("\n");
  await fs.writeFile(path.join(rootDir, "src.js"), fileContent, "utf8");

  const index = await buildIndex(rootDir);
  const chunks = index.documents
    .filter((document) => document.path === "src.js")
    .map((document) => ({
      start: document.chunk.startLine,
      end: document.chunk.endLine,
      content: document.content,
    }));

  assert.ok(chunks.some((chunk) => /Usage:/.test(chunk.content)));
  assert.ok(chunks.some((chunk) => /applyProfileDefaults/.test(chunk.content)));
  assert.ok(chunks.some((chunk) => /resolveCommandDefaults/.test(chunk.content)));
  assert.ok(chunks.some((chunk) => /Usage:/.test(chunk.content) && !/applyProfileDefaults/.test(chunk.content)));
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
