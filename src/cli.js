#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  buildIndex,
  loadDocuments,
  rankDocuments,
  saveIndex,
  synthesizeAnswer,
} from "./indexer.js";

export async function main() {
  const [, , command, ...args] = process.argv;
  const workingDir = process.cwd();

  if (!command || command === "help" || command === "--help") {
    printHelp();
    process.exit(0);
  }

  if (command === "index") {
    const { positionalArgs, json } = parseCliOptions(args);
    const targetDir = path.resolve(positionalArgs[0] ?? workingDir);
    const index = await buildIndex(targetDir);
    const indexPath = await saveIndex(targetDir, index);
    const payload = {
      root: targetDir,
      indexPath,
      generatedAt: index.generatedAt,
      filesIndexed: index.filesIndexed,
      chunksIndexed: index.chunksIndexed,
      files: [...new Set(index.documents.map((document) => document.path))],
    };
    writeOutput(payload, json);
    return;
  }

  if (command === "ask") {
    const { positionalArgs, json, defaults } = parseCliOptions(args);
    const targetDir = path.resolve(positionalArgs[0] ?? workingDir);
    const query = positionalArgs.slice(1).join(" ").trim();

    if (!query) {
      throw new Error("Query required. Usage: grounded-workspace ask <dir> <question>");
    }

    const { documents, source, indexPath } = await loadDocuments(targetDir);
    const userDefaults = await loadUserDefaults();
    const envDefaults = loadEnvDefaults();
    const userDefaultQuery = applyCliDefaultsToQuery(query, userDefaults);
    const envDefaultQuery = applyCliDefaultsToQuery(userDefaultQuery, envDefaults);
    const cliDefaultQuery = applyCliDefaultsToQuery(envDefaultQuery, defaults);
    const outputDefaultQuery = applyOutputDefaultsToQuery(cliDefaultQuery, {
      json,
      isTTY: process.stdout.isTTY,
      noColor: "NO_COLOR" in process.env,
      term: process.env.TERM ?? "",
    });
    const themeConfig = await loadThemeConfig(targetDir);
    const defaultThemeQuery = applyConfiguredThemeDefaults(outputDefaultQuery, { json }, themeConfig);
    const effectiveQuery = resolveThemeAliasesInQuery(defaultThemeQuery, themeConfig);
    const matches = rankDocuments(documents, effectiveQuery, 5, {
      ansiThemes: themeConfig.themes,
      wrapperThemes: themeConfig.wrappers,
    });
    const answer = matches.length > 0 ? synthesizeAnswer(matches, query) : null;
    const payload = {
      query,
      effectiveQuery,
      source,
      indexPath,
      answer,
      matches,
    };

    if (matches.length === 0) {
      if (json) {
        writeOutput(payload, true);
        return;
      }
      process.stdout.write("No grounded matches found.\n");
      return;
    }

    if (json) {
      writeOutput(payload, true);
      return;
    }

    process.stdout.write(`Using ${source === "index" ? "saved index" : "live scan"} from ${indexPath}\n\n`);
    process.stdout.write(`Answer: ${answer}\n\n`);
    for (const match of matches) {
      const range = match.chunk ? `:${match.chunk.startLine}-${match.chunk.endLine}` : "";
      process.stdout.write(`# ${match.path}${range} (score: ${match.score})\n`);
      process.stdout.write(
        `why: token=${match.why.tokenScore} path=${match.why.pathScore} coverage=${match.why.coverageScore} phrase=${match.why.phraseScore} density=${match.why.densityScore} bias=${match.why.retrievalBias}\n`,
      );
      if ("phraseHits" in match.why && (match.why.matchedTerms.length > 0 || match.why.phraseHits.length > 0 || match.why.pathHits.length > 0)) {
        process.stdout.write(
          `details: matched=${match.why.matchedTerms.join(", ") || "-"} phrases=${match.why.phraseHits.join(" | ") || "-"} path=${match.why.pathHits.join(", ") || "-"}\n`,
        );
      }
      process.stdout.write(`${match.excerpt}\n\n`);
    }
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function printHelp() {
  process.stdout.write(`grounded-workspace

Usage:
  grounded-workspace index [dir] [--json]
  grounded-workspace ask [dir] <question> [--json] [--explain <mode>] [--excerpt <mode>] [--highlight <mode>] [--theme <mode>]

Query filters:
  ext:<extension>   limit matches to a file extension
  path:<prefix>     limit matches to a path prefix
  limit:<count>     limit the number of returned matches
  minscore:<score>  drop matches below a score threshold
  explain:<mode>    choose terse or verbose explanations
  excerpt:<mode>    choose raw or highlighted snippets
  highlight:<mode>  choose plain, brackets, ansi, or tags for highlights
  theme:<mode>      choose yellow, cyan, green, magenta, inverse, or bold for ansi highlights

Output:
  --json            emit machine-readable JSON
  --explain <mode>  set a default explanation mode for this command
  --excerpt <mode>  set a default excerpt mode for this command
  --highlight <mode> set a default highlight mode for this command
  --theme <mode>    set a default theme for this command

Notes:
  excerpt:highlighted defaults to ansi in color terminals, plain in non-color terminals, and tags in JSON output
  environment defaults can be defined with GROUNDED_WORKSPACE_EXPLAIN, GROUNDED_WORKSPACE_EXCERPT, GROUNDED_WORKSPACE_HIGHLIGHT, and GROUNDED_WORKSPACE_THEME
  user-level defaults can be defined in ~/.grounded-workspace.json
  theme aliases, custom ansi themes, and wrapper themes can be defined in .grounded-workspace-theme.json
  configured theme defaults apply only when the query does not already specify theme:<mode>
`);
}

export function parseCliOptions(args) {
  const positionalArgs = [];
  let json = false;
  const defaults = {
    explain: null,
    excerpt: null,
    highlight: null,
    theme: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--explain") {
      defaults.explain = normalizeExplainMode(args[index + 1]);
      index += 1;
      continue;
    }

    if (arg === "--excerpt") {
      defaults.excerpt = normalizeExcerptMode(args[index + 1]);
      index += 1;
      continue;
    }

    if (arg === "--highlight") {
      defaults.highlight = normalizeHighlightMode(args[index + 1]);
      index += 1;
      continue;
    }

    if (arg === "--theme") {
      defaults.theme = normalizeThemeMode(args[index + 1]);
      index += 1;
      continue;
    }

    positionalArgs.push(arg);
  }

  return { positionalArgs, json, defaults };
}

export function applyCliDefaultsToQuery(query, defaults = {}) {
  let effectiveQuery = query;

  if (defaults.explain && !/\bexplain:/i.test(effectiveQuery)) {
    effectiveQuery = `${effectiveQuery} explain:${defaults.explain}`.trim();
  }

  if (defaults.excerpt && !/\bexcerpt:/i.test(effectiveQuery)) {
    effectiveQuery = `${effectiveQuery} excerpt:${defaults.excerpt}`.trim();
  }

  if (defaults.highlight && !/\bhighlight:/i.test(effectiveQuery)) {
    effectiveQuery = `${effectiveQuery} highlight:${defaults.highlight}`.trim();
  }

  if (defaults.theme && !/\btheme:/i.test(effectiveQuery)) {
    effectiveQuery = `${effectiveQuery} theme:${defaults.theme}`.trim();
  }

  return effectiveQuery;
}

export function applyOutputDefaultsToQuery(query, { json, isTTY = false, noColor = false, term = "" }) {
  if (!/\bexcerpt:highlighted\b/i.test(query)) {
    return query;
  }

  const explicitHighlight = query.match(/\bhighlight:(plain|brackets|ansi|tags)\b/i)?.[1]?.toLowerCase() ?? null;
  if (explicitHighlight) {
    const safeHighlight = normalizeHighlightForOutput(explicitHighlight, { json, isTTY, noColor, term });
    if (safeHighlight === explicitHighlight) {
      return query;
    }

    return query.replace(/\bhighlight:(plain|brackets|ansi|tags)\b/i, `highlight:${safeHighlight}`);
  }

  const defaultHighlight = json ? "tags" : getDefaultTerminalHighlight({ isTTY, noColor, term });
  return `${query} highlight:${defaultHighlight}`.trim();
}

export function resolveThemeAliasesInQuery(query, themeConfig = { aliases: {}, themes: {}, wrappers: {} }) {
  const themeToken = query.match(/\btheme:([a-z0-9_-]+)\b/i)?.[1]?.toLowerCase() ?? null;
  if (!themeToken) {
    return query;
  }

  if (isBuiltInTheme(themeToken) || themeToken in themeConfig.themes || themeToken in themeConfig.wrappers) {
    return query;
  }

  const resolvedTheme = themeConfig.aliases[themeToken];
  const safeTheme =
    isBuiltInTheme(resolvedTheme) || resolvedTheme in themeConfig.themes || resolvedTheme in themeConfig.wrappers
      ? resolvedTheme
      : "yellow";
  return query.replace(/\btheme:[a-z0-9_-]+\b/i, `theme:${safeTheme}`);
}

export function applyConfiguredThemeDefaults(query, { json }, themeConfig = { defaults: {}, themes: {}, wrappers: {} }) {
  if (!/\bexcerpt:highlighted\b/i.test(query) || /\btheme:/i.test(query)) {
    return query;
  }

  const highlight = query.match(/\bhighlight:(plain|brackets|ansi|tags)\b/i)?.[1]?.toLowerCase() ?? null;
  if (!highlight) {
    return query;
  }

  const defaults = themeConfig.defaults ?? {};
  const configuredTheme =
    (json ? defaults.jsonTheme : null) ??
    defaults[`${highlight}Theme`] ??
    null;

  if (!isUsableTheme(configuredTheme, themeConfig)) {
    return query;
  }

  return `${query} theme:${configuredTheme}`.trim();
}

function getDefaultTerminalHighlight({ isTTY, noColor, term }) {
  if (isTTY && !noColor && term !== "dumb") {
    return "ansi";
  }

  return "plain";
}

function normalizeHighlightForOutput(highlight, { json, isTTY, noColor, term }) {
  if (highlight !== "ansi") {
    return highlight;
  }

  if (json) {
    return "tags";
  }

  return getDefaultTerminalHighlight({ isTTY, noColor, term });
}

function isBuiltInTheme(theme) {
  return (
    theme === "yellow" ||
    theme === "cyan" ||
    theme === "green" ||
    theme === "magenta" ||
    theme === "inverse" ||
    theme === "bold"
  );
}

function isUsableTheme(theme, themeConfig) {
  if (!theme || typeof theme !== "string") {
    return false;
  }

  return isBuiltInTheme(theme) || theme in themeConfig.themes || theme in themeConfig.wrappers;
}

export async function loadUserDefaults(homeDir = process.env.HOME ?? "") {
  if (!homeDir) {
    return getEmptyDefaults();
  }

  const configPath = path.join(homeDir, ".grounded-workspace.json");

  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return getEmptyDefaults();
    }

    const defaults = parsed.defaults && typeof parsed.defaults === "object" ? parsed.defaults : parsed;
    return {
      explain: normalizeExplainMode(defaults.explain),
      excerpt: normalizeExcerptMode(defaults.excerpt),
      highlight: normalizeHighlightMode(defaults.highlight),
      theme: normalizeThemeMode(defaults.theme),
    };
  } catch {
    return getEmptyDefaults();
  }
}

export function loadEnvDefaults(env = process.env) {
  return {
    explain: normalizeExplainMode(env.GROUNDED_WORKSPACE_EXPLAIN),
    excerpt: normalizeExcerptMode(env.GROUNDED_WORKSPACE_EXCERPT),
    highlight: normalizeHighlightMode(env.GROUNDED_WORKSPACE_HIGHLIGHT),
    theme: normalizeThemeMode(env.GROUNDED_WORKSPACE_THEME),
  };
}

export async function loadThemeConfig(rootDir) {
  const configPath = path.join(rootDir, ".grounded-workspace-theme.json");

  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { aliases: {}, themes: {}, wrappers: {}, defaults: {} };
    }

    const aliases =
      typeof parsed.aliases === "object" && parsed.aliases !== null
        ? Object.fromEntries(
            Object.entries(parsed.aliases)
              .map(([alias, theme]) => [alias.toLowerCase(), typeof theme === "string" ? theme.toLowerCase() : ""])
              .filter(([alias, theme]) => alias && theme),
          )
        : {};

    const themes =
      typeof parsed.themes === "object" && parsed.themes !== null
        ? Object.fromEntries(
            Object.entries(parsed.themes)
              .map(([name, theme]) => [name.toLowerCase(), normalizeThemeDefinition(theme)])
              .filter(([name, theme]) => /^[a-z0-9_-]+$/.test(name) && theme !== null),
          )
        : {};

    const wrappers =
      typeof parsed.wrappers === "object" && parsed.wrappers !== null
        ? Object.fromEntries(
            Object.entries(parsed.wrappers)
              .map(([name, wrapper]) => [name.toLowerCase(), normalizeWrapperDefinition(wrapper)])
              .filter(([name, wrapper]) => /^[a-z0-9_-]+$/.test(name) && wrapper !== null),
          )
        : {};

    const defaults =
      typeof parsed.defaults === "object" && parsed.defaults !== null
        ? Object.fromEntries(
            Object.entries(parsed.defaults)
              .map(([key, theme]) => [key, typeof theme === "string" ? theme.toLowerCase() : ""])
              .filter(([key, theme]) => /^(jsonTheme|ansiTheme|plainTheme|bracketsTheme|tagsTheme)$/.test(key) && theme),
          )
        : {};

    return { aliases, themes, wrappers, defaults };
  } catch {
    return { aliases: {}, themes: {}, wrappers: {}, defaults: {} };
  }
}

function normalizeThemeDefinition(theme) {
  if (typeof theme === "string") {
    return /^\u001b\[[0-9;]+m$/u.test(theme) ? theme : null;
  }

  if (!theme || typeof theme !== "object") {
    return null;
  }

  if (typeof theme.start !== "string" || typeof theme.reset !== "string") {
    return null;
  }

  if (!/^\u001b\[[0-9;]+m$/u.test(theme.start) || !/^\u001b\[[0-9;]+m$/u.test(theme.reset)) {
    return null;
  }

  return {
    start: theme.start,
    reset: theme.reset,
  };
}

function normalizeWrapperDefinition(wrapper) {
  if (!wrapper || typeof wrapper !== "object") {
    return null;
  }

  if (typeof wrapper.before !== "string" || typeof wrapper.after !== "string") {
    return null;
  }

  return {
    before: wrapper.before,
    after: wrapper.after,
  };
}

function normalizeExplainMode(value) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "terse" || normalized === "verbose" ? normalized : null;
}

function normalizeExcerptMode(value) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "raw" || normalized === "highlighted" ? normalized : null;
}

function normalizeHighlightMode(value) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "plain" || normalized === "brackets" || normalized === "ansi" || normalized === "tags"
    ? normalized
    : null;
}

function normalizeThemeMode(value) {
  const normalized = value?.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return normalized || null;
}

function getEmptyDefaults() {
  return {
    explain: null,
    excerpt: null,
    highlight: null,
    theme: null,
  };
}

function writeOutput(payload, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
