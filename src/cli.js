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
    const { positionalArgs, json, format } = parseCliOptions(args);
    const targetDir = path.resolve(positionalArgs[0] ?? workingDir);
    const userDefaults = await loadUserDefaults();
    const envDefaults = loadEnvDefaults();
    const themeConfig = await loadThemeConfig(targetDir);
    const availableProfiles = mergeProfiles(themeConfig.profiles, userDefaults.profiles);
    const resolvedUserDefaults = applyProfileDefaults(selectCommandDefaults(userDefaults, "index"), availableProfiles);
    const resolvedEnvDefaults = applyProfileDefaults(selectCommandDefaults(envDefaults, "index"), availableProfiles);
    const resolvedCliDefaults = applyProfileDefaults(defaultsFromFormat(format), availableProfiles);
    const outputFormat = resolveOutputFormat({
      cliFormat: format,
      cliDefaults: resolvedCliDefaults,
      envDefaults: resolvedEnvDefaults,
      userDefaults: resolvedUserDefaults,
      fallback: json ? "json" : "text",
      command: "index",
    });
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
    writeOutput(payload, outputFormat === "json");
    return;
  }

  if (command === "profiles") {
    const { positionalArgs, json, format } = parseCliOptions(args);
    const targetDir = path.resolve(positionalArgs[0] ?? workingDir);
    const userConfig = await loadUserDefaults();
    const themeConfig = await loadThemeConfig(targetDir);
    const payload = {
      root: targetDir,
      profiles: listProfiles({ userProfiles: userConfig.profiles, workspaceProfiles: themeConfig.profiles }),
    };
    const outputFormat = resolveOutputFormat({
      cliFormat: format,
      cliDefaults: defaultsFromFormat(format),
      envDefaults: {},
      userDefaults: {},
      fallback: json ? "json" : "text",
      command: "ask",
    });

    if (outputFormat === "json") {
      writeOutput(payload, true);
      return;
    }

    process.stdout.write(formatProfilesOutput(payload, outputFormat));
    return;
  }

  if (command === "ask") {
    const { positionalArgs, json, format, defaults } = parseCliOptions(args);
    const targetDir = path.resolve(positionalArgs[0] ?? workingDir);
    const query = positionalArgs.slice(1).join(" ").trim();

    if (!query) {
      throw new Error("Query required. Usage: grounded-workspace ask <dir> <question>");
    }

    const { documents, source, indexPath } = await loadDocuments(targetDir);
    const userConfig = await loadUserDefaults();
    const envConfig = loadEnvDefaults();
    const themeConfig = await loadThemeConfig(targetDir);
    const availableProfiles = mergeProfiles(themeConfig.profiles, userConfig.profiles);
    const userDefaults = applyProfileDefaults(selectCommandDefaults(userConfig, "ask"), availableProfiles);
    const envDefaults = applyProfileDefaults(selectCommandDefaults(envConfig, "ask"), availableProfiles);
    const cliDefaults = applyProfileDefaults(defaults, availableProfiles);
    const outputFormat = resolveOutputFormat({
      cliFormat: format,
      cliDefaults,
      envDefaults,
      userDefaults,
      fallback: json ? "json" : "text",
      command: "ask",
    });
    const userDefaultQuery = applyCliDefaultsToQuery(query, userDefaults);
    const envDefaultQuery = applyCliDefaultsToQuery(userDefaultQuery, envDefaults);
    const cliDefaultQuery = applyCliDefaultsToQuery(envDefaultQuery, cliDefaults);
    const outputDefaultQuery = applyOutputDefaultsToQuery(cliDefaultQuery, {
      outputFormat,
      colorMode: resolveColorMode({
        cliDefaults,
        envDefaults,
        userDefaults,
        fallback: "NO_COLOR" in process.env ? "never" : "auto",
      }),
      isTTY: process.stdout.isTTY,
      term: process.env.TERM ?? "",
    });
    const defaultThemeQuery = applyConfiguredThemeDefaults(outputDefaultQuery, { outputFormat }, themeConfig);
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
      if (outputFormat === "json") {
        writeOutput(payload, true);
        return;
      }
      if (outputFormat === "markdown" || outputFormat === "html") {
        process.stdout.write(formatAskOutput(payload, outputFormat));
        return;
      }
      process.stdout.write("No grounded matches found.\n");
      return;
    }

    if (outputFormat === "json") {
      writeOutput(payload, true);
      return;
    }

    process.stdout.write(formatAskOutput(payload, outputFormat));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function printHelp() {
  process.stdout.write(`grounded-workspace

Usage:
  grounded-workspace index [dir] [--json]
  grounded-workspace profiles [dir] [--json] [--format <mode>]
  grounded-workspace ask [dir] <question> [--json] [--profile <name>] [--format <mode>] [--color <mode>] [--explain <mode>] [--excerpt <mode>] [--highlight <mode>] [--theme <mode>]

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
  --profile <name>  choose a built-in render profile like terminal, ci, markdown-doc, or html-report
  --format <mode>   choose text, json, markdown, or html output
  --color <mode>    choose auto, always, or never for terminal ansi behavior
  --explain <mode>  set a default explanation mode for this command
  --excerpt <mode>  set a default excerpt mode for this command
  --highlight <mode> set a default highlight mode for this command
  --theme <mode>    set a default theme for this command

Notes:
  excerpt:highlighted defaults to ansi in color terminals, plain in non-color terminals, and tags in json, markdown, and html output
  environment defaults can be defined with GROUNDED_WORKSPACE_PROFILE, GROUNDED_WORKSPACE_ASK_PROFILE, GROUNDED_WORKSPACE_FORMAT, GROUNDED_WORKSPACE_ASK_FORMAT, GROUNDED_WORKSPACE_INDEX_FORMAT, GROUNDED_WORKSPACE_COLOR, GROUNDED_WORKSPACE_ASK_COLOR, GROUNDED_WORKSPACE_EXPLAIN, GROUNDED_WORKSPACE_ASK_EXPLAIN, GROUNDED_WORKSPACE_EXCERPT, GROUNDED_WORKSPACE_ASK_EXCERPT, GROUNDED_WORKSPACE_HIGHLIGHT, GROUNDED_WORKSPACE_ASK_HIGHLIGHT, GROUNDED_WORKSPACE_THEME, and GROUNDED_WORKSPACE_ASK_THEME
  user-level defaults can be defined in ~/.grounded-workspace.json
  theme aliases, custom ansi themes, and wrapper themes can be defined in .grounded-workspace-theme.json
  configured theme defaults apply only when the query does not already specify theme:<mode>
`);
}

export function parseCliOptions(args) {
  const positionalArgs = [];
  let format = null;
  const defaults = {
    profile: null,
    format: null,
    color: null,
    explain: null,
    excerpt: null,
    highlight: null,
    theme: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      format = "json";
      continue;
    }

    if (arg === "--format") {
      const normalizedFormat = normalizeOutputFormat(args[index + 1]);
      format = normalizedFormat ?? format;
      defaults.format = normalizedFormat ?? defaults.format;
      index += 1;
      continue;
    }

    if (arg === "--profile") {
      defaults.profile = normalizeProfileName(args[index + 1]);
      index += 1;
      continue;
    }

    if (arg === "--color") {
      defaults.color = normalizeColorMode(args[index + 1]);
      index += 1;
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

  return { positionalArgs, json: format === "json", format, defaults };
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

export function applyOutputDefaultsToQuery(query, { outputFormat = "text", colorMode = "auto", isTTY = false, term = "" }) {
  if (!/\bexcerpt:highlighted\b/i.test(query)) {
    return query;
  }

  const explicitHighlight = query.match(/\bhighlight:(plain|brackets|ansi|tags)\b/i)?.[1]?.toLowerCase() ?? null;
  if (explicitHighlight) {
    const safeHighlight = normalizeHighlightForOutput(explicitHighlight, { outputFormat, colorMode, isTTY, term });
    if (safeHighlight === explicitHighlight) {
      return query;
    }

    return query.replace(/\bhighlight:(plain|brackets|ansi|tags)\b/i, `highlight:${safeHighlight}`);
  }

  const defaultHighlight = getDefaultHighlightForOutput({ outputFormat, colorMode, isTTY, term });
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

export function applyConfiguredThemeDefaults(query, { outputFormat = "text" }, themeConfig = { defaults: {}, themes: {}, wrappers: {} }) {
  if (!/\bexcerpt:highlighted\b/i.test(query) || /\btheme:/i.test(query)) {
    return query;
  }

  const highlight = query.match(/\bhighlight:(plain|brackets|ansi|tags)\b/i)?.[1]?.toLowerCase() ?? null;
  if (!highlight) {
    return query;
  }

  const defaults = themeConfig.defaults ?? {};
  const configuredTheme =
    defaults[`${outputFormat}Theme`] ??
    (outputFormat === "markdown" || outputFormat === "html" ? defaults.jsonTheme ?? null : null) ??
    defaults[`${highlight}Theme`] ??
    null;

  if (!isUsableTheme(configuredTheme, themeConfig)) {
    return query;
  }

  return `${query} theme:${configuredTheme}`.trim();
}

function getDefaultTerminalHighlight({ colorMode, isTTY, term }) {
  if (colorMode === "always") {
    return "ansi";
  }

  if (colorMode === "never") {
    return "plain";
  }

  if (isTTY && term !== "dumb") {
    return "ansi";
  }

  return "plain";
}

function getDefaultHighlightForOutput({ outputFormat, colorMode, isTTY, term }) {
  if (outputFormat === "json" || outputFormat === "markdown" || outputFormat === "html") {
    return "tags";
  }

  return getDefaultTerminalHighlight({ colorMode, isTTY, term });
}

function normalizeHighlightForOutput(highlight, { outputFormat, colorMode, isTTY, term }) {
  if (highlight !== "ansi") {
    return highlight;
  }

  if (outputFormat === "json" || outputFormat === "markdown" || outputFormat === "html") {
    return "tags";
  }

  return getDefaultTerminalHighlight({ colorMode, isTTY, term });
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
    return getEmptyDefaultsConfig();
  }

  const configPath = path.join(homeDir, ".grounded-workspace.json");

  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return getEmptyDefaultsConfig();
    }

    const defaults = parsed.defaults && typeof parsed.defaults === "object" ? parsed.defaults : parsed;
    return {
      ...normalizeDefaults(defaults),
      profiles: normalizeProfiles(parsed.profiles),
      commands: {
        ask: normalizeDefaults(getCommandConfig(parsed, "ask")),
        index: normalizeDefaults(getCommandConfig(parsed, "index")),
      },
    };
  } catch {
    return getEmptyDefaultsConfig();
  }
}

export function loadEnvDefaults(env = process.env) {
  return {
    ...normalizeDefaults({
      profile: env.GROUNDED_WORKSPACE_PROFILE,
      format: env.GROUNDED_WORKSPACE_FORMAT,
      color: env.GROUNDED_WORKSPACE_COLOR,
      explain: env.GROUNDED_WORKSPACE_EXPLAIN,
      excerpt: env.GROUNDED_WORKSPACE_EXCERPT,
      highlight: env.GROUNDED_WORKSPACE_HIGHLIGHT,
      theme: env.GROUNDED_WORKSPACE_THEME,
    }),
    commands: {
      ask: normalizeDefaults({
        profile: env.GROUNDED_WORKSPACE_ASK_PROFILE,
        format: env.GROUNDED_WORKSPACE_ASK_FORMAT,
        color: env.GROUNDED_WORKSPACE_ASK_COLOR,
        explain: env.GROUNDED_WORKSPACE_ASK_EXPLAIN,
        excerpt: env.GROUNDED_WORKSPACE_ASK_EXCERPT,
        highlight: env.GROUNDED_WORKSPACE_ASK_HIGHLIGHT,
        theme: env.GROUNDED_WORKSPACE_ASK_THEME,
      }),
      index: normalizeDefaults({
        format: env.GROUNDED_WORKSPACE_INDEX_FORMAT,
      }),
    },
    profiles: {},
  };
}

export async function loadThemeConfig(rootDir) {
  const configPath = path.join(rootDir, ".grounded-workspace-theme.json");

  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { aliases: {}, themes: {}, wrappers: {}, defaults: {}, profiles: {} };
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
              .filter(([key, theme]) => /^(jsonTheme|markdownTheme|htmlTheme|ansiTheme|plainTheme|bracketsTheme|tagsTheme)$/.test(key) && theme),
          )
        : {};

    const profiles = normalizeProfiles(parsed.profiles);

    return { aliases, themes, wrappers, defaults, profiles };
  } catch {
    return { aliases: {}, themes: {}, wrappers: {}, defaults: {}, profiles: {} };
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

function normalizeColorMode(value) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "auto" || normalized === "always" || normalized === "never" ? normalized : null;
}

function normalizeProfileName(value) {
  const normalized = value?.trim().toLowerCase();
  return /^[a-z0-9_-]+$/.test(normalized ?? "") ? normalized : null;
}

function normalizeThemeMode(value) {
  const normalized = value?.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return normalized || null;
}

function normalizeOutputFormat(value) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "text" || normalized === "json" || normalized === "markdown" || normalized === "html"
    ? normalized
    : null;
}

export function formatAskOutput(payload, outputFormat = "text") {
  if (outputFormat === "markdown") {
    return formatAskMarkdown(payload);
  }

  if (outputFormat === "html") {
    return formatAskHtml(payload);
  }

  return formatAskText(payload);
}

export function formatProfilesOutput(payload, outputFormat = "text") {
  if (outputFormat === "markdown") {
    return formatProfilesMarkdown(payload);
  }

  if (outputFormat === "html") {
    return formatProfilesHtml(payload);
  }

  return formatProfilesText(payload);
}

function formatAskText(payload) {
  const { source, indexPath, answer, matches } = payload;
  let output = `Using ${source === "index" ? "saved index" : "live scan"} from ${indexPath}\n\n`;
  output += `Answer: ${answer}\n\n`;

  for (const match of matches) {
    const range = match.chunk ? `:${match.chunk.startLine}-${match.chunk.endLine}` : "";
    output += `# ${match.path}${range} (score: ${match.score})\n`;
    output += `why: token=${match.why.tokenScore} path=${match.why.pathScore} coverage=${match.why.coverageScore} phrase=${match.why.phraseScore} density=${match.why.densityScore} bias=${match.why.retrievalBias}\n`;
    if ("phraseHits" in match.why && (match.why.matchedTerms.length > 0 || match.why.phraseHits.length > 0 || match.why.pathHits.length > 0)) {
      output += `details: matched=${match.why.matchedTerms.join(", ") || "-"} phrases=${match.why.phraseHits.join(" | ") || "-"} path=${match.why.pathHits.join(", ") || "-"}\n`;
    }
    output += `${match.excerpt}\n\n`;
  }

  return output;
}

function formatAskMarkdown(payload) {
  const { source, indexPath, answer, matches } = payload;
  let output = `# grounded-workspace answer\n\n`;
  output += `Source: ${source === "index" ? "saved index" : "live scan"} from \`${indexPath}\`\n\n`;
  output += `## Answer\n\n${answer ?? "No grounded matches found."}\n\n`;

  if (matches.length === 0) {
    return output;
  }

  output += `## Evidence\n\n`;
  for (const match of matches) {
    const range = match.chunk ? `:${match.chunk.startLine}-${match.chunk.endLine}` : "";
    output += `### \`${match.path}${range}\`\n\n`;
    output += `Score: ${match.score}\n\n`;
    output += `Why: token=${match.why.tokenScore} path=${match.why.pathScore} coverage=${match.why.coverageScore} phrase=${match.why.phraseScore} density=${match.why.densityScore} bias=${match.why.retrievalBias}\n\n`;
    if ("phraseHits" in match.why && (match.why.matchedTerms.length > 0 || match.why.phraseHits.length > 0 || match.why.pathHits.length > 0)) {
      output += `Details: matched=${match.why.matchedTerms.join(", ") || "-"} phrases=${match.why.phraseHits.join(" | ") || "-"} path=${match.why.pathHits.join(", ") || "-"}\n\n`;
    }
    output += `${match.excerpt}\n\n`;
  }

  return output;
}

function formatAskHtml(payload) {
  const { source, indexPath, answer, matches } = payload;
  let output = "<!doctype html>\n";
  output += "<html><head><meta charset=\"utf-8\"><title>grounded-workspace answer</title></head><body>\n";
  output += "<h1>grounded-workspace answer</h1>\n";
  output += `<p>Source: ${escapeHtml(source === "index" ? "saved index" : "live scan")} from <code>${escapeHtml(indexPath)}</code></p>\n`;
  output += `<h2>Answer</h2>\n<p>${escapeHtml(answer ?? "No grounded matches found.")}</p>\n`;

  if (matches.length === 0) {
    output += "</body></html>\n";
    return output;
  }

  output += "<h2>Evidence</h2>\n";
  for (const match of matches) {
    const range = match.chunk ? `:${match.chunk.startLine}-${match.chunk.endLine}` : "";
    output += `<section>\n<h3><code>${escapeHtml(match.path + range)}</code></h3>\n`;
    output += `<p>Score: ${escapeHtml(String(match.score))}</p>\n`;
    output += `<p>Why: token=${escapeHtml(String(match.why.tokenScore))} path=${escapeHtml(String(match.why.pathScore))} coverage=${escapeHtml(String(match.why.coverageScore))} phrase=${escapeHtml(String(match.why.phraseScore))} density=${escapeHtml(String(match.why.densityScore))} bias=${escapeHtml(String(match.why.retrievalBias))}</p>\n`;
    if ("phraseHits" in match.why && (match.why.matchedTerms.length > 0 || match.why.phraseHits.length > 0 || match.why.pathHits.length > 0)) {
      output += `<p>Details: matched=${escapeHtml(match.why.matchedTerms.join(", ") || "-")} phrases=${escapeHtml(match.why.phraseHits.join(" | ") || "-")} path=${escapeHtml(match.why.pathHits.join(", ") || "-")}</p>\n`;
    }
    output += `<pre>${match.excerpt}</pre>\n</section>\n`;
  }

  output += "</body></html>\n";
  return output;
}

function formatProfilesText(payload) {
  const { root, profiles } = payload;
  let output = `Available profiles for ${root}\n\n`;

  for (const profile of profiles) {
    const extendsLabel = profile.extends ? ` extends ${profile.extends}` : "";
    output += `- ${profile.name} [${profile.source}]${extendsLabel}\n`;
    output += `  format=${profile.resolved.format ?? "-"} color=${profile.resolved.color ?? "-"} explain=${profile.resolved.explain ?? "-"} excerpt=${profile.resolved.excerpt ?? "-"} highlight=${profile.resolved.highlight ?? "-"} theme=${profile.resolved.theme ?? "-"}\n`;
  }

  return output;
}

function formatProfilesMarkdown(payload) {
  const { root, profiles } = payload;
  let output = `# grounded-workspace profiles\n\n`;
  output += `Root: \`${root}\`\n\n`;

  for (const profile of profiles) {
    const extendsLabel = profile.extends ? ` extends \`${profile.extends}\`` : "";
    output += `## \`${profile.name}\`\n\n`;
    output += `Source: ${profile.source}${extendsLabel}\n\n`;
    output += `Resolved: format=${profile.resolved.format ?? "-"} color=${profile.resolved.color ?? "-"} explain=${profile.resolved.explain ?? "-"} excerpt=${profile.resolved.excerpt ?? "-"} highlight=${profile.resolved.highlight ?? "-"} theme=${profile.resolved.theme ?? "-"}\n\n`;
  }

  return output;
}

function formatProfilesHtml(payload) {
  const { root, profiles } = payload;
  let output = "<!doctype html>\n";
  output += "<html><head><meta charset=\"utf-8\"><title>grounded-workspace profiles</title></head><body>\n";
  output += "<h1>grounded-workspace profiles</h1>\n";
  output += `<p>Root: <code>${escapeHtml(root)}</code></p>\n`;

  for (const profile of profiles) {
    const extendsLabel = profile.extends ? ` extends <code>${escapeHtml(profile.extends)}</code>` : "";
    output += `<section>\n<h2><code>${escapeHtml(profile.name)}</code></h2>\n`;
    output += `<p>Source: ${escapeHtml(profile.source)}${extendsLabel}</p>\n`;
    output += `<p>Resolved: format=${escapeHtml(profile.resolved.format ?? "-")} color=${escapeHtml(profile.resolved.color ?? "-")} explain=${escapeHtml(profile.resolved.explain ?? "-")} excerpt=${escapeHtml(profile.resolved.excerpt ?? "-")} highlight=${escapeHtml(profile.resolved.highlight ?? "-")} theme=${escapeHtml(profile.resolved.theme ?? "-")}</p>\n`;
    output += "</section>\n";
  }

  output += "</body></html>\n";
  return output;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function getEmptyDefaults() {
  return {
    profile: null,
    extends: null,
    format: null,
    color: null,
    explain: null,
    excerpt: null,
    highlight: null,
    theme: null,
  };
}

function getEmptyDefaultsConfig() {
  return {
    ...getEmptyDefaults(),
    profiles: {},
    commands: {
      ask: getEmptyDefaults(),
      index: getEmptyDefaults(),
    },
  };
}

function normalizeDefaults(defaults = {}) {
  return {
    profile: normalizeProfileName(defaults.profile),
    extends: normalizeProfileName(defaults.extends),
    format: normalizeOutputFormat(defaults.format),
    color: normalizeColorMode(defaults.color),
    explain: normalizeExplainMode(defaults.explain),
    excerpt: normalizeExcerptMode(defaults.excerpt),
    highlight: normalizeHighlightMode(defaults.highlight),
    theme: normalizeThemeMode(defaults.theme),
  };
}

function normalizeProfiles(profiles) {
  if (!profiles || typeof profiles !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(profiles)
      .map(([name, profile]) => [normalizeProfileName(name), normalizeDefaults(profile)])
      .filter(([name, profile]) => name && Object.values(profile).some((value) => value !== null)),
  );
}

function mergeProfiles(baseProfiles = {}, overridingProfiles = {}) {
  return {
    ...baseProfiles,
    ...overridingProfiles,
  };
}

export function listProfiles({ userProfiles = {}, workspaceProfiles = {} } = {}) {
  const profileNames = [...new Set([
    ...Object.keys(BUILT_IN_PROFILES),
    ...Object.keys(workspaceProfiles),
    ...Object.keys(userProfiles),
  ])].sort();
  const availableProfiles = mergeProfiles(workspaceProfiles, userProfiles);

  return profileNames.map((name) => {
    const definition = availableProfiles[name] ?? BUILT_IN_PROFILES[name] ?? getEmptyDefaults();
    return {
      name,
      source: userProfiles[name] ? "user" : workspaceProfiles[name] ? "workspace" : "built-in",
      extends: definition.extends ?? null,
      resolved: normalizeDefaults(resolveProfileDefinition(name, availableProfiles) ?? getEmptyDefaults()),
    };
  });
}

function getCommandConfig(parsed, command) {
  const commandConfig = parsed[command];
  if (!commandConfig || typeof commandConfig !== "object") {
    return {};
  }

  if (commandConfig.defaults && typeof commandConfig.defaults === "object") {
    return commandConfig.defaults;
  }

  return commandConfig;
}

export function selectCommandDefaults(defaults, command) {
  const commandDefaults = defaults?.commands?.[command] ?? {};
  return {
    profile: commandDefaults.profile ?? defaults?.profile ?? null,
    extends: commandDefaults.extends ?? defaults?.extends ?? null,
    format: commandDefaults.format ?? defaults?.format ?? null,
    color: commandDefaults.color ?? defaults?.color ?? null,
    explain: commandDefaults.explain ?? defaults?.explain ?? null,
    excerpt: commandDefaults.excerpt ?? defaults?.excerpt ?? null,
    highlight: commandDefaults.highlight ?? defaults?.highlight ?? null,
    theme: commandDefaults.theme ?? defaults?.theme ?? null,
  };
}

function defaultsFromFormat(format) {
  return {
    profile: null,
    extends: null,
    format,
    color: null,
    explain: null,
    excerpt: null,
    highlight: null,
    theme: null,
  };
}

export function resolveOutputFormat({
  cliFormat = null,
  cliDefaults = {},
  envDefaults = {},
  userDefaults = {},
  fallback = "text",
  command = "ask",
} = {}) {
  const requestedFormat =
    cliFormat ??
    cliDefaults.format ??
    envDefaults.format ??
    userDefaults.format ??
    fallback;

  if (command === "index") {
    return requestedFormat === "json" ? "json" : "text";
  }

  return normalizeOutputFormat(requestedFormat) ?? fallback;
}

export function resolveColorMode({ cliDefaults = {}, envDefaults = {}, userDefaults = {}, fallback = "auto" } = {}) {
  return cliDefaults.color ?? envDefaults.color ?? userDefaults.color ?? normalizeColorMode(fallback) ?? "auto";
}

export function applyProfileDefaults(defaults = {}, customProfiles = {}) {
  const profile = resolveProfileDefinition(defaults.profile, customProfiles);
  if (!profile) {
    return defaults;
  }

  return {
    profile: defaults.profile,
    extends: defaults.extends ?? null,
    format: defaults.format ?? profile.format ?? null,
    color: defaults.color ?? profile.color ?? null,
    explain: defaults.explain ?? profile.explain ?? null,
    excerpt: defaults.excerpt ?? profile.excerpt ?? null,
    highlight: defaults.highlight ?? profile.highlight ?? null,
    theme: defaults.theme ?? profile.theme ?? null,
  };
}

function resolveProfileDefinition(profileName, customProfiles = {}, seen = new Set()) {
  if (!profileName || seen.has(profileName)) {
    return null;
  }

  seen.add(profileName);
  const ownProfile = customProfiles[profileName] ?? BUILT_IN_PROFILES[profileName] ?? null;
  if (!ownProfile) {
    return null;
  }

  const parentProfile = ownProfile.extends ? resolveProfileDefinition(ownProfile.extends, customProfiles, seen) : null;
  if (!parentProfile) {
    return ownProfile;
  }

  return mergeDefaultValues(parentProfile, ownProfile);
}

function mergeDefaultValues(base = {}, override = {}) {
  return {
    profile: override.profile ?? base.profile ?? null,
    extends: override.extends ?? base.extends ?? null,
    format: override.format ?? base.format ?? null,
    color: override.color ?? base.color ?? null,
    explain: override.explain ?? base.explain ?? null,
    excerpt: override.excerpt ?? base.excerpt ?? null,
    highlight: override.highlight ?? base.highlight ?? null,
    theme: override.theme ?? base.theme ?? null,
  };
}

const BUILT_IN_PROFILES = {
  terminal: {
    format: "text",
    color: "auto",
    excerpt: "highlighted",
    highlight: "ansi",
    theme: "yellow",
  },
  ci: {
    format: "text",
    color: "never",
    excerpt: "highlighted",
    highlight: "plain",
  },
  "markdown-doc": {
    format: "markdown",
    color: "never",
    excerpt: "highlighted",
    highlight: "tags",
  },
  "html-report": {
    format: "html",
    color: "never",
    excerpt: "highlighted",
    highlight: "tags",
  },
};

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
