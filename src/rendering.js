import { getEmptyDefaults } from "./profiles.js";

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

function normalizeOutputFormat(value) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "text" || normalized === "json" || normalized === "markdown" || normalized === "html"
    ? normalized
    : null;
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

export function formatAskOutput(payload, outputFormat = "text") {
  if (outputFormat === "markdown") {
    return formatAskMarkdown(payload);
  }

  if (outputFormat === "html") {
    return formatAskHtml(payload);
  }

  return formatAskText(payload);
}

export function formatIndexOutput(payload, outputFormat = "text") {
  if (outputFormat === "markdown") {
    return formatIndexMarkdown(payload);
  }

  if (outputFormat === "html") {
    return formatIndexHtml(payload);
  }

  return formatIndexText(payload);
}

export function formatJsonOutput(payload, { pretty = true } = {}) {
  return `${JSON.stringify(payload, null, pretty ? 2 : 0)}\n`;
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

function formatIndexText(payload) {
  const { command, root, indexPath, generatedAt, filesIndexed, chunksIndexed, incremental, files } = payload;
  let output = `${command === "refresh" ? "Refreshed" : "Indexed"} ${root}\n\n`;
  output += `Summary: ${formatIndexSummary(payload)}\n\n`;
  output += `Index path: ${indexPath}\n`;
  output += `Generated: ${generatedAt}\n`;
  output += `Files indexed: ${filesIndexed}\n`;
  output += `Chunks indexed: ${chunksIndexed}\n`;
  output += `Incremental: ${incremental?.enabled ? "yes" : "no"}\n`;
  if (incremental?.enabled) {
    output += `Incremental stats: reused=${incremental.reusedFiles ?? 0} changed=${incremental.changedFiles ?? 0} deleted=${incremental.deletedFiles ?? 0}\n`;
  }
  output += "\nFiles:\n";
  if (files.length === 0) {
    output += "- none\n";
  } else {
    for (const file of files) {
      output += `- ${file}\n`;
    }
  }
  return output;
}

function formatChunkRange(chunk) {
  if (!chunk) {
    return "";
  }

  return `:${chunk.startLine}-${chunk.endLine}`;
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

function formatIndexMarkdown(payload) {
  const { command, root, indexPath, generatedAt, filesIndexed, chunksIndexed, incremental, files } = payload;
  let output = `# grounded-workspace ${command === "refresh" ? "refresh" : "index"}\n\n`;
  output += `Root: \`${root}\`\n\n`;
  output += `Summary: ${formatIndexSummary(payload)}\n\n`;
  output += `Index path: \`${indexPath}\`\n\n`;
  output += `Generated: ${generatedAt}\n\n`;
  output += `Files indexed: ${filesIndexed}\n\n`;
  output += `Chunks indexed: ${chunksIndexed}\n\n`;
  output += `Incremental: ${incremental?.enabled ? "yes" : "no"}\n\n`;
  if (incremental?.enabled) {
    output += `Incremental stats: reused=${incremental.reusedFiles ?? 0} changed=${incremental.changedFiles ?? 0} deleted=${incremental.deletedFiles ?? 0}\n\n`;
  }
  output += "## Files\n\n";
  if (files.length === 0) {
    output += "- none\n";
  } else {
    for (const file of files) {
      output += `- \`${file}\`\n`;
    }
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

function formatIndexHtml(payload) {
  const { command, root, indexPath, generatedAt, filesIndexed, chunksIndexed, incremental, files } = payload;
  let output = "<!doctype html>\n";
  output += `<html><head><meta charset="utf-8"><title>grounded-workspace ${command === "refresh" ? "refresh" : "index"}</title></head><body>\n`;
  output += `<h1>grounded-workspace ${command === "refresh" ? "refresh" : "index"}</h1>\n`;
  output += `<p>Root: <code>${escapeHtml(root)}</code></p>\n`;
  output += `<p>Summary: ${escapeHtml(formatIndexSummary(payload))}</p>\n`;
  output += `<p>Index path: <code>${escapeHtml(indexPath)}</code></p>\n`;
  output += `<p>Generated: ${escapeHtml(generatedAt)}</p>\n`;
  output += `<p>Files indexed: ${escapeHtml(String(filesIndexed))}</p>\n`;
  output += `<p>Chunks indexed: ${escapeHtml(String(chunksIndexed))}</p>\n`;
  output += `<p>Incremental: ${escapeHtml(incremental?.enabled ? "yes" : "no")}</p>\n`;
  if (incremental?.enabled) {
    output += `<p>Incremental stats: reused=${escapeHtml(String(incremental.reusedFiles ?? 0))} changed=${escapeHtml(String(incremental.changedFiles ?? 0))} deleted=${escapeHtml(String(incremental.deletedFiles ?? 0))}</p>\n`;
  }
  output += "<h2>Files</h2>\n";
  if (files.length === 0) {
    output += "<p>none</p>\n";
  } else {
    output += "<ul>\n";
    for (const file of files) {
      output += `<li><code>${escapeHtml(file)}</code></li>\n`;
    }
    output += "</ul>\n";
  }
  output += "</body></html>\n";
  return output;
}

function formatIndexSummary(payload) {
  const { command, filesIndexed, chunksIndexed, incremental } = payload;
  if (incremental?.enabled) {
    return `${command === "refresh" ? "Refreshed" : "Indexed"} ${filesIndexed} files into ${chunksIndexed} chunks; reused ${incremental.reusedFiles ?? 0} files, rebuilt ${incremental.changedFiles ?? 0}, deleted ${incremental.deletedFiles ?? 0}.`;
  }

  return `${command === "refresh" ? "Refreshed" : "Indexed"} ${filesIndexed} files into ${chunksIndexed} chunks.`;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

export function resolveEffectiveAskOutputDefaults({
  commandDefaults = getEmptyDefaults(),
  themeConfig = { defaults: {}, themes: {}, wrappers: {} },
  outputFormat = "text",
  colorMode = "auto",
  isTTY = false,
  term = "",
} = {}) {
  const seededQuery = applyCliDefaultsToQuery("__probe__", commandDefaults);
  const outputQuery = applyOutputDefaultsToQuery(seededQuery, { outputFormat, colorMode, isTTY, term });
  const themedQuery = applyConfiguredThemeDefaults(outputQuery, { outputFormat }, themeConfig);
  const effectiveQuery = resolveThemeAliasesInQuery(themedQuery, themeConfig);

  return {
    color: colorMode,
    excerpt: effectiveQuery.match(/\bexcerpt:(raw|highlighted)\b/i)?.[1]?.toLowerCase() ?? null,
    highlight: effectiveQuery.match(/\bhighlight:(plain|brackets|ansi|tags)\b/i)?.[1]?.toLowerCase() ?? null,
    theme: effectiveQuery.match(/\btheme:([a-z0-9_-]+)\b/i)?.[1]?.toLowerCase() ?? null,
  };
}

export function resolveEffectiveAskOutputSources({
  commandDefaults = getEmptyDefaults(),
  commandSources = {},
  themeConfig = { defaults: {}, themes: {}, wrappers: {} },
  outputFormat = "text",
  colorMode = "auto",
  isTTY = false,
  term = "",
} = {}) {
  const seededQuery = applyCliDefaultsToQuery("__probe__", commandDefaults);
  const outputQuery = applyOutputDefaultsToQuery(seededQuery, { outputFormat, colorMode, isTTY, term });
  const themedQuery = applyConfiguredThemeDefaults(outputQuery, { outputFormat }, themeConfig);
  const effectiveQuery = resolveThemeAliasesInQuery(themedQuery, themeConfig);

  const outputHighlight = outputQuery.match(/\bhighlight:(plain|brackets|ansi|tags)\b/i)?.[1]?.toLowerCase() ?? null;
  const finalHighlight = effectiveQuery.match(/\bhighlight:(plain|brackets|ansi|tags)\b/i)?.[1]?.toLowerCase() ?? null;
  const finalTheme = effectiveQuery.match(/\btheme:([a-z0-9_-]+)\b/i)?.[1]?.toLowerCase() ?? null;

  return {
    color: commandSources.color !== "unset" ? commandSources.color : "output",
    excerpt: commandSources.excerpt ?? "unset",
    highlight:
      commandSources.highlight === "unset"
        ? "output"
        : outputHighlight !== commandDefaults.highlight || finalHighlight !== commandDefaults.highlight
          ? `${commandSources.highlight}+output`
          : commandSources.highlight,
    theme:
      finalTheme === null
        ? "unset"
        : commandSources.theme !== "unset" && commandSources.theme
          ? commandSources.theme
          : themedQuery !== outputQuery
            ? "workspace-output"
            : effectiveQuery !== themedQuery
              ? "alias"
              : "output",
  };
}

export function defaultsFromFormat(format) {
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

export function normalizePreviewDefaultFlag(defaults, command, flag, value) {
  if (flag === `--${command}-format`) {
    defaults.format = normalizeOutputFormat(value);
    return true;
  }

  if (flag === `--${command}-color`) {
    defaults.color = normalizeColorMode(value);
    return true;
  }

  if (flag === `--${command}-explain`) {
    defaults.explain = normalizeExplainMode(value);
    return true;
  }

  if (flag === `--${command}-excerpt`) {
    defaults.excerpt = normalizeExcerptMode(value);
    return true;
  }

  if (flag === `--${command}-highlight`) {
    defaults.highlight = normalizeHighlightMode(value);
    return true;
  }

  if (flag === `--${command}-theme`) {
    defaults.theme = value?.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "") || null;
    return true;
  }

  return false;
}
