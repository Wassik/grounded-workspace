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
  applyProfileDefaults,
  applyOutputDefaultsToQuery,
  formatAskOutput,
  formatProfilesOutput,
  loadEnvDefaults,
  loadThemeConfig,
  loadUserDefaults,
  listProfiles,
  parseCliOptions,
  resolveColorMode,
  resolveOutputFormat,
  selectCommandDefaults,
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

test("formatProfilesOutput renders text, markdown, and html responses", () => {
  const payload = {
    root: "/tmp/workspace",
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
  assert.match(text, /docs_bundle \[user\] extends docs_base/);

  const markdown = formatProfilesOutput(payload, "markdown");
  assert.match(markdown, /# grounded-workspace profiles/);
  assert.match(markdown, /Source: user extends `docs_base`/);

  const html = formatProfilesOutput(payload, "html");
  assert.match(html, /<!doctype html>/i);
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
