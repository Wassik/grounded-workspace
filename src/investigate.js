import fs from "node:fs/promises";
import path from "node:path";

import { expandQueryTokens, parseQuery, synthesizeAnswer } from "./indexer.js";

const INVESTIGATION_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "do",
  "does",
  "for",
  "how",
  "in",
  "is",
  "it",
  "of",
  "or",
  "the",
  "this",
  "to",
  "what",
  "where",
  "which",
  "why",
  "work",
  "works",
]);

export function resolveInvestigateOutputFormat({ json = false, format = null, outputFile = null } = {}) {
  if (json || format === "json") {
    return "json";
  }

  if (format) {
    return format;
  }

  return inferInvestigateOutputFormatFromPath(outputFile) ?? "text";
}

export function validateInvestigateOptions(options = {}) {
  if (options.live && options.refreshIndex) {
    throw new Error("--live cannot be combined with --refresh-index");
  }

  if (options.live && options.refreshIfStale) {
    throw new Error("--live cannot be combined with --refresh-if-stale");
  }
}

function inferInvestigateOutputFormatFromPath(outputFile) {
  if (!outputFile) {
    return null;
  }

  const extension = path.extname(outputFile).toLowerCase();
  if (extension === ".json") {
    return "json";
  }
  if (extension === ".md" || extension === ".markdown") {
    return "markdown";
  }
  if (extension === ".html" || extension === ".htm") {
    return "html";
  }
  if (extension === ".txt") {
    return "text";
  }

  return null;
}

export function formatInvestigateOutput(payload, outputFormat = "text") {
  if (outputFormat === "markdown") {
    return formatInvestigateMarkdown(payload);
  }

  if (outputFormat === "html") {
    return formatInvestigateHtml(payload);
  }

  return formatInvestigateText(payload);
}

function formatInvestigateText(payload) {
  const { source, sourceReason, sourceMode, indexPath, question, queries, summary, confidence, freshness, refresh, keyFiles, evidence, gaps } = payload;
  const warnings = getInvestigateWarnings({ source, sourceReason, freshness, root: payload.root });
  const displayGaps = gaps.filter((gap) => !warnings.includes(gap));
  let output = `Using ${source === "index" ? "saved index" : "live scan"} from ${indexPath}\n\n`;
  if (sourceMode) {
    output += `Source mode: ${sourceMode}\n\n`;
  }
  if (sourceReason) {
    output += `Source reason: ${sourceReason}\n\n`;
  }
  if (warnings.length > 0) {
    output += "Warnings:\n";
    for (const warning of warnings) {
      output += `- ${warning}\n`;
    }
    output += "\n";
  }
  output += `Question: ${question}\n\n`;
  output += "Queries:\n";
  for (const query of queries) {
    output += `- ${query}\n`;
  }

  output += `\nSummary:\n${summary}\n\n`;
  output += `Confidence: ${confidence.level}`;
  if (confidence.reason) {
    output += ` (${confidence.reason})`;
  }
  output += `\nFreshness: ${freshness.status}`;
  if (freshness.reason) {
    output += ` (${freshness.reason})`;
  }
  if (hasFreshnessCounts(freshness)) {
    output += ` [changed=${freshness.changedFiles ?? 0} deleted=${freshness.deletedFiles ?? 0} new=${freshness.newFiles ?? 0}]`;
  }
  if (refresh?.requested) {
    output += `\nRefresh: ${refresh.performed ? "performed" : "not needed"}`;
    if (refresh.mode && refresh.mode !== "none") {
      output += ` (${refresh.mode})`;
    }
    if (refresh.indexMode) {
      output += ` [${refresh.indexMode}]`;
    }
    if (refresh.reason) {
      output += ` - ${refresh.reason}`;
    }
  }
  output += "\n\n";
  output += "Key files:\n";
  if (keyFiles.length === 0) {
    output += "- none\n";
  } else {
    for (const [index, file] of keyFiles.entries()) {
      output += `${index + 1}. ${file.path} (score: ${file.score}, evidence: ${file.evidenceCount})\n`;
    }
  }

  output += "\nEvidence:\n";
  if (evidence.length === 0) {
    output += "No grounded matches found.\n";
  } else {
    for (const match of evidence) {
      output += `\n# ${match.path}${formatChunkRange(match.chunk)} (score: ${match.score}, queries: ${match.queries.join(" | ")})\n`;
      output += `kind: ${match.kind}\n`;
      output += `reason: ${formatInvestigationReason(match)}\n`;
      output += `${match.excerpt}\n`;
    }
  }

  output += "\nGaps:\n";
  if (displayGaps.length === 0) {
    output += "- none\n";
  } else {
    for (const gap of displayGaps) {
      output += `- ${gap}\n`;
    }
  }

  return output;
}

function formatInvestigateMarkdown(payload) {
  const { source, sourceReason, sourceMode, indexPath, question, queries, summary, confidence, freshness, refresh, keyFiles, evidence, gaps } = payload;
  const warnings = getInvestigateWarnings({ source, sourceReason, freshness, root: payload.root });
  const displayGaps = gaps.filter((gap) => !warnings.includes(gap));
  let output = "# grounded-workspace investigation\n\n";
  output += `Source: ${source === "index" ? "saved index" : "live scan"} from \`${indexPath}\`\n\n`;
  if (sourceMode) {
    output += `Source mode: ${sourceMode}\n\n`;
  }
  if (sourceReason) {
    output += `Source reason: ${sourceReason}\n\n`;
  }
  if (warnings.length > 0) {
    output += "## Warnings\n\n";
    for (const warning of warnings) {
      output += `- ${warning}\n`;
    }
    output += "\n";
  }
  output += `## Question\n\n${question}\n\n`;
  output += "## Queries\n\n";
  for (const query of queries) {
    output += `- ${query}\n`;
  }
  output += `\n## Summary\n\n${summary}\n\n`;
  output += `## Confidence\n\n${confidence.level}${confidence.reason ? ` (${confidence.reason})` : ""}\n\n`;
  output += `## Freshness\n\n${freshness.status}${freshness.reason ? ` (${freshness.reason})` : ""}${hasFreshnessCounts(freshness) ? ` [changed=${freshness.changedFiles ?? 0} deleted=${freshness.deletedFiles ?? 0} new=${freshness.newFiles ?? 0}]` : ""}\n\n`;
  if (refresh?.requested) {
    output += `## Refresh\n\n${refresh.performed ? "performed" : "not needed"}${refresh.mode && refresh.mode !== "none" ? ` (${refresh.mode})` : ""}${refresh.indexMode ? ` [${refresh.indexMode}]` : ""}${refresh.reason ? ` - ${refresh.reason}` : ""}\n\n`;
  }
  output += "## Key Files\n\n";
  if (keyFiles.length === 0) {
    output += "- none\n\n";
  } else {
    for (const [index, file] of keyFiles.entries()) {
      output += `${index + 1}. \`${file.path}\` (score: ${file.score}, evidence: ${file.evidenceCount})\n`;
    }
    output += "\n";
  }
  output += "## Evidence\n\n";
  if (evidence.length === 0) {
    output += "No grounded matches found.\n\n";
  } else {
    for (const match of evidence) {
      output += `### \`${match.path}${formatChunkRange(match.chunk)}\`\n\n`;
      output += `Score: ${match.score}; queries: ${match.queries.join(" | ")}\n\n`;
      output += `Kind: ${match.kind}\n\n`;
      output += `Reason: ${formatInvestigationReason(match)}\n\n`;
      output += "```text\n";
      output += `${match.excerpt}\n`;
      output += "```\n\n";
    }
  }
  output += "## Gaps\n\n";
  if (displayGaps.length === 0) {
    output += "- none\n";
  } else {
    for (const gap of displayGaps) {
      output += `- ${gap}\n`;
    }
  }
  return output;
}

function formatInvestigateHtml(payload) {
  const { source, sourceReason, sourceMode, indexPath, question, queries, summary, confidence, freshness, refresh, keyFiles, evidence, gaps } = payload;
  const warnings = getInvestigateWarnings({ source, sourceReason, freshness, root: payload.root });
  const displayGaps = gaps.filter((gap) => !warnings.includes(gap));
  let output = "<!doctype html>\n";
  output += "<html><head><meta charset=\"utf-8\"><title>grounded-workspace investigation</title></head><body>\n";
  output += "<h1>grounded-workspace investigation</h1>\n";
  output += `<p>Source: ${escapeHtml(source === "index" ? "saved index" : "live scan")} from <code>${escapeHtml(indexPath)}</code></p>\n`;
  if (sourceMode) {
    output += `<p>Source mode: ${escapeHtml(sourceMode)}</p>\n`;
  }
  if (sourceReason) {
    output += `<p>Source reason: ${escapeHtml(sourceReason)}</p>\n`;
  }
  if (warnings.length > 0) {
    output += "<h2>Warnings</h2>\n<ul>\n";
    for (const warning of warnings) {
      output += `<li>${escapeHtml(warning)}</li>\n`;
    }
    output += "</ul>\n";
  }
  output += `<h2>Question</h2>\n<p>${escapeHtml(question)}</p>\n`;
  output += "<h2>Queries</h2>\n<ul>\n";
  for (const query of queries) {
    output += `<li>${escapeHtml(query)}</li>\n`;
  }
  output += "</ul>\n";
  output += `<h2>Summary</h2>\n<p>${escapeHtml(summary)}</p>\n`;
  output += `<h2>Confidence</h2>\n<p>${escapeHtml(confidence.level)}${confidence.reason ? ` (${escapeHtml(confidence.reason)})` : ""}</p>\n`;
  output += `<h2>Freshness</h2>\n<p>${escapeHtml(freshness.status)}${freshness.reason ? ` (${escapeHtml(freshness.reason)})` : ""}${hasFreshnessCounts(freshness) ? ` [changed=${escapeHtml(String(freshness.changedFiles ?? 0))} deleted=${escapeHtml(String(freshness.deletedFiles ?? 0))} new=${escapeHtml(String(freshness.newFiles ?? 0))}]` : ""}</p>\n`;
  if (refresh?.requested) {
    output += `<h2>Refresh</h2>\n<p>${refresh.performed ? "performed" : "not needed"}${refresh.mode && refresh.mode !== "none" ? ` (${escapeHtml(refresh.mode)})` : ""}${refresh.indexMode ? ` [${escapeHtml(refresh.indexMode)}]` : ""}${refresh.reason ? ` - ${escapeHtml(refresh.reason)}` : ""}</p>\n`;
  }
  output += "<h2>Key Files</h2>\n";
  if (keyFiles.length === 0) {
    output += "<p>none</p>\n";
  } else {
    output += "<ol>\n";
    for (const file of keyFiles) {
      output += `<li><code>${escapeHtml(file.path)}</code> (score: ${escapeHtml(String(file.score))}, evidence: ${escapeHtml(String(file.evidenceCount))})</li>\n`;
    }
    output += "</ol>\n";
  }
  output += "<h2>Evidence</h2>\n";
  if (evidence.length === 0) {
    output += "<p>No grounded matches found.</p>\n";
  } else {
    for (const match of evidence) {
      output += "<section>\n";
      output += `<h3><code>${escapeHtml(match.path + formatChunkRange(match.chunk))}</code></h3>\n`;
      output += `<p>Score: ${escapeHtml(String(match.score))}; queries: ${escapeHtml(match.queries.join(" | "))}</p>\n`;
      output += `<p>Kind: ${escapeHtml(match.kind)}</p>\n`;
      output += `<p>Reason: ${escapeHtml(formatInvestigationReason(match))}</p>\n`;
      output += `<pre>${escapeHtml(match.excerpt)}</pre>\n`;
      output += "</section>\n";
    }
  }
  output += "<h2>Gaps</h2>\n";
  if (displayGaps.length === 0) {
    output += "<p>none</p>\n";
  } else {
    output += "<ul>\n";
    for (const gap of displayGaps) {
      output += `<li>${escapeHtml(gap)}</li>\n`;
    }
    output += "</ul>\n";
  }
  output += "</body></html>\n";
  return output;
}

function getInvestigateWarnings({ source = "index", sourceReason = null, freshness = null, root = null } = {}) {
  const warnings = [];

  if (source === "index" && freshness?.status === "stale") {
    warnings.push(`Saved index appears stale${formatFreshnessCountSuffix(freshness)}; rerun \`${formatInvestigateIndexCommand(root)}\` before relying on this investigation.`);
  }

  if (source === "scan" && sourceReason === "saved index invalid JSON") {
    warnings.push(`Saved index is invalid JSON; rerun \`${formatInvestigateIndexCommand(root)}\` to repair it.`);
  }

  if (source === "scan" && sourceReason === "saved index unreadable") {
    warnings.push(`Saved index is unreadable; check file permissions or rerun \`${formatInvestigateIndexCommand(root)}\` to replace it.`);
  }

  return warnings;
}

function hasFreshnessCounts(freshness = {}) {
  return (
    typeof freshness.changedFiles === "number" ||
    typeof freshness.deletedFiles === "number" ||
    typeof freshness.newFiles === "number"
  );
}

function formatFreshnessCountSuffix(freshness = {}) {
  if (!hasFreshnessCounts(freshness)) {
    return "";
  }

  return ` (${freshness.changedFiles ?? 0} changed, ${freshness.deletedFiles ?? 0} deleted, ${freshness.newFiles ?? 0} new)`;
}

export function serializeInvestigatePayload(payload, options = {}) {
  const includeRaw = options.includeRaw === true;
  return {
    root: payload.root,
    question: payload.question,
    source: payload.source,
    ...(payload.sourceReason ? { sourceReason: payload.sourceReason } : {}),
    ...(payload.sourceMode ? { sourceMode: payload.sourceMode } : {}),
    indexPath: payload.indexPath,
    generatedAt: payload.generatedAt,
    freshness: payload.freshness,
    ...(payload.refresh ? { refresh: payload.refresh } : {}),
    ...(payload.intent ? { intent: payload.intent } : {}),
    queries: payload.queries,
    summary: payload.summary,
    confidence: payload.confidence,
    keyFiles: payload.keyFiles,
    evidence: payload.evidence.map((match) => ({
      path: match.path,
      chunk: match.chunk,
      score: match.score,
      kind: match.kind,
      reason: formatInvestigationReason(match),
      why: match.why,
      excerpt: match.excerpt,
      queries: match.queries,
      ...(includeRaw
        ? {
            rawExcerpt: match.rawExcerpt,
            highlightedExcerpt: match.highlightedExcerpt,
          }
        : {}),
    })),
    gaps: payload.gaps,
  };
}

export function deriveInvestigationQueries(question) {
  const trimmedQuestion = question.trim();
  if (!trimmedQuestion) {
    return [];
  }

  const { queryText, filters } = parseQuery(trimmedQuestion);
  const intent = detectInvestigationIntent(trimmedQuestion);
  const queries = [trimmedQuestion];
  const significantTerms = deriveInvestigationTerms(queryText, intent);
  const filterSuffix = [
    ...filters.extensions.map((extension) => `ext:${extension.slice(1)}`),
    ...filters.pathPrefixes.map((prefix) => `path:${prefix}`),
  ].join(" ");
  const significantQuery = [significantTerms.slice(0, 3).join(" "), filterSuffix].filter(Boolean).join(" ").trim();
  if (significantQuery && significantQuery !== trimmedQuestion) {
    queries.push(significantQuery);
  }

  if (filters.pathPrefixes.length === 0) {
    const pathBiasedQuery = derivePathBiasedInvestigationQuery({ queryText, significantTerms, filterSuffix, filters });
    if (pathBiasedQuery) {
      queries.push(pathBiasedQuery);
    }
  }

  return [...new Set(queries)];
}

function deriveInvestigationTerms(queryText, intent = "general") {
  const baseTerms = [...expandQueryTokens(queryText).keys()]
    .filter((token) => token.length > 2 && !INVESTIGATION_STOP_WORDS.has(token));

  if (intent === "docs") {
    return baseTerms
      .filter((token) => token !== "document" && token !== "documented" && token !== "documentation" && token !== "thi")
      .slice(0, 4);
  }

  if (intent === "tests") {
    return baseTerms.filter((token) => token !== "cover" && token !== "coverage").slice(0, 4);
  }

  if (intent === "code") {
    return baseTerms.filter((token) => token !== "implemented" && token !== "implementation").slice(0, 4);
  }

  return baseTerms.slice(0, 4);
}

export function detectInvestigationIntent(question) {
  const { queryText } = parseQuery(question.trim());
  const normalized = queryText.toLowerCase();

  if (/\b(spec|test|tests|coverage|assert)\b/.test(normalized)) {
    return "tests";
  }

  if (/\b(readme|docs?|documentation|guide|manual)\b/.test(normalized)) {
    return "docs";
  }

  if (/\b(cli|command|commands|default|defaults|function|implementation|implemented|index|indexing|logic|profile|profiles|theme|source|code)\b/.test(normalized)) {
    return "code";
  }

  return "general";
}

function derivePathBiasedInvestigationQuery({ queryText, significantTerms, filterSuffix, filters }) {
  const baseTerms = significantTerms.slice(0, 3).join(" ").trim() || queryText.trim();
  if (!baseTerms) {
    return null;
  }

  const docsHint = /\b(readme|docs?|documentation|guide)\b/i.test(queryText);
  const testHint = /\b(spec|test|tests)\b/i.test(queryText);
  const sourceHint = /\b(cli|command|commands|default|defaults|function|implementation|implemented|index|indexing|logic|profile|profiles|theme)\b/i.test(queryText);

  if (docsHint) {
    return [baseTerms, filterSuffix, filters.extensions.includes(".md") ? null : "ext:md"].filter(Boolean).join(" ").trim();
  }

  if (testHint) {
    return [baseTerms, filterSuffix, "path:test"].filter(Boolean).join(" ").trim();
  }

  if (sourceHint) {
    return [baseTerms, filterSuffix, "path:src"].filter(Boolean).join(" ").trim();
  }

  return null;
}

export function mergeInvestigationHits(results = []) {
  const merged = new Map();

  for (const result of results) {
    for (const match of result.matches ?? []) {
      const key = `${match.path}:${match.chunk?.startLine ?? 0}:${match.chunk?.endLine ?? 0}`;
      const existing = merged.get(key);

      if (!existing) {
        merged.set(key, {
          ...match,
          queries: [result.query],
          score: Number(match.score),
          bestScore: Number(match.score),
        });
        continue;
      }

      existing.score = Math.round((existing.score + match.score) * 1000) / 1000;
      if (!existing.queries.includes(result.query)) {
        existing.queries.push(result.query);
      }
      if (match.score > existing.bestScore) {
        existing.excerpt = match.excerpt;
        existing.rawExcerpt = match.rawExcerpt;
        existing.highlightedExcerpt = match.highlightedExcerpt;
        existing.why = match.why;
        existing.bestScore = Number(match.score);
      }
    }
  }

  return [...merged.values()]
    .map(({ bestScore, ...match }) => match)
    .sort((left, right) => right.score - left.score);
}

export function rankInvestigationFiles(evidence = [], maxFiles = 3, intent = "general") {
  const files = new Map();

  for (const match of evidence) {
    const existing = files.get(match.path) ?? { path: match.path, scores: [], evidenceCount: 0 };
    existing.scores.push(getInvestigationEvidenceScore(match, intent));
    existing.evidenceCount += 1;
    files.set(match.path, existing);
  }

  return [...files.values()]
    .map((file) => ({
      path: file.path,
      score: Math.round(file.scores.sort((left, right) => right - left).slice(0, 2).reduce((total, score) => total + score, 0) * 1000) / 1000,
      evidenceCount: file.evidenceCount,
    }))
    .sort((left, right) => right.score - left.score || right.evidenceCount - left.evidenceCount || left.path.localeCompare(right.path))
    .slice(0, maxFiles);
}

export function selectInvestigationEvidence(evidence = [], keyFiles = [], maxEvidence = 4, intent = "general") {
  if (evidence.length <= maxEvidence) {
    return dedupeInvestigationEvidence(
      [...evidence]
        .sort((left, right) => getInvestigationEvidenceScore(right, intent) - getInvestigationEvidenceScore(left, intent))
        .map((match) => compactInvestigationMatch(match)),
    ).slice(0, maxEvidence);
  }

  const filePriority = new Map(keyFiles.map((file, index) => [file.path, index]));
  const selected = [];
  const seen = new Set();

  for (const file of keyFiles) {
    const topMatch = [...evidence]
      .filter((match) => match.path === file.path)
      .sort((left, right) => getInvestigationEvidenceScore(right, intent) - getInvestigationEvidenceScore(left, intent))[0];
    if (!topMatch) {
      continue;
    }
    const key = `${topMatch.path}:${topMatch.chunk?.startLine ?? 0}:${topMatch.chunk?.endLine ?? 0}`;
    if (seen.has(key)) {
      continue;
    }
    selected.push(topMatch);
    seen.add(key);
    if (selected.length >= maxEvidence) {
      return dedupeInvestigationEvidence(selected.map((match) => compactInvestigationMatch(match))).slice(0, maxEvidence);
    }
  }

  const remaining = [...evidence]
    .filter((match) => {
      const key = `${match.path}:${match.chunk?.startLine ?? 0}:${match.chunk?.endLine ?? 0}`;
      return !seen.has(key);
    })
    .sort((left, right) => {
      const leftPriority = filePriority.get(left.path) ?? Number.MAX_SAFE_INTEGER;
      const rightPriority = filePriority.get(right.path) ?? Number.MAX_SAFE_INTEGER;
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }
      return getInvestigationEvidenceScore(right, intent) - getInvestigationEvidenceScore(left, intent) || left.path.localeCompare(right.path);
    });

  for (const match of remaining) {
    selected.push(match);
    if (selected.length >= maxEvidence) {
      break;
    }
  }

  return dedupeInvestigationEvidence(selected.map((match) => compactInvestigationMatch(match))).slice(0, maxEvidence);
}

function dedupeInvestigationEvidence(evidence = []) {
  const kept = [];

  for (const match of evidence) {
    const isDuplicate = kept.some((existing) => {
      if (existing.path !== match.path) {
        return false;
      }

      return investigationExcerptSimilarity(existing.excerpt, match.excerpt) >= 0.75;
    });

    if (!isDuplicate) {
      kept.push(match);
    }
  }

  return kept;
}

function investigationExcerptSimilarity(leftExcerpt = "", rightExcerpt = "") {
  const leftTokens = new Set(tokenizeInvestigationExcerpt(leftExcerpt));
  const rightTokens = new Set(tokenizeInvestigationExcerpt(rightExcerpt));

  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap / Math.min(leftTokens.size, rightTokens.size);
}

function tokenizeInvestigationExcerpt(excerpt) {
  return excerpt.toLowerCase().match(/[a-z0-9_/-]+/g) ?? [];
}

function getInvestigationEvidenceScore(match, intent = "general") {
  return Number((match.score + getInvestigationEvidenceBias(match, intent)).toFixed(3));
}

function getInvestigationEvidenceBias(match, intent = "general") {
  const excerpt = (match.rawExcerpt ?? match.excerpt ?? "").toLowerCase();
  const filePath = match.path.toLowerCase();
  let score = 0;
  const optionLineCount = excerpt.match(/^\s{0,2}--[a-z0-9-]+/gm)?.length ?? 0;
  const hasHelpMarkers = /\busage:\b|\bnotes:\b/.test(excerpt) || optionLineCount >= 3;
  const hasImplementationMarkers = /\bexport function\b|\bfunction\b|\bconst\b|=>|\breturn\b/.test(excerpt);

  if (hasImplementationMarkers) {
    score += 8;
  }

  if (hasHelpMarkers) {
    score -= hasImplementationMarkers ? 12 : 40;
  }

  if (/\bassert\.(match|equal|deepEqual)\b|\btest\(/.test(excerpt)) {
    score -= 24;
  }

  if (/"question":|"summary":|"keyFiles":|"evidence":|\bquestion:\b|\bsummary:\b|\bkeyFiles:\b|\bevidence:\b|\bindexPath:\b|\bqueries:\b/.test(excerpt)) {
    score -= 18;
  }

  if (isRepoSelfFixture(match)) {
    score -= 36;
  }

  if (filePath.includes("/src/") || filePath.startsWith("src/")) {
    score += 8;
  }

  if (filePath.endsWith(".md") || filePath.includes("readme")) {
    score -= 6;
  }

  if (filePath.includes("/test/") || filePath.startsWith("test/") || filePath.includes(".test.") || filePath.includes(".spec.")) {
    score -= 3;
  }

  if (intent === "code") {
    if (filePath.includes("/src/") || filePath.startsWith("src/")) {
      score += 8;
    }
    if (filePath.endsWith(".md") || filePath.includes("readme")) {
      score -= 4;
    }
  }

  if (intent === "docs") {
    if (filePath.endsWith(".md") || filePath.includes("readme") || filePath.includes("/docs/") || filePath.startsWith("docs/")) {
      score += 18;
    }
    if (filePath.includes("/src/") || filePath.startsWith("src/")) {
      score -= 12;
    }
  }

  if (intent === "tests") {
    if (filePath.includes("/test/") || filePath.startsWith("test/") || filePath.includes(".test.") || filePath.includes(".spec.")) {
      score += 36;
    }
    if (filePath.includes("/src/") || filePath.startsWith("src/")) {
      score -= 12;
    }
  }

  return score;
}

function isRepoSelfFixture(match) {
  const excerpt = (match.rawExcerpt ?? match.excerpt ?? "").toLowerCase();
  const filePath = match.path.toLowerCase();

  if (!(filePath.startsWith("test/") || filePath.includes(".test.") || filePath.startsWith("docs/") || filePath.includes("investigate-spec"))) {
    return false;
  }

  const hasInvestigatePayloadShape =
    /\bquestion:\b|\bsummary:\b|\bkeyfiles:\b|\bevidence:\b|\bindexpath:\b|\bqueries:\b/.test(excerpt) ||
    /"question":|"summary":|"keyfiles":|"evidence":|"indexpath":|"queries":/.test(excerpt);

  const mentionsCliInternals =
    /src\/cli\.js|applyprofiledefaults|serializeinvestigatepayload|deriveinvestigationqueries|formatinvestigateoutput/.test(excerpt);

  return hasInvestigatePayloadShape || mentionsCliInternals;
}

function classifyInvestigationEvidence(match) {
  const excerpt = (match.rawExcerpt ?? match.excerpt ?? "").toLowerCase();
  const filePath = match.path.toLowerCase();
  const optionLineCount = excerpt.match(/^\s{0,2}--[a-z0-9-]+/gm)?.length ?? 0;
  const hasHelpMarkers = /\busage:\b|\bnotes:\b/.test(excerpt) || optionLineCount >= 3;
  const hasImplementationMarkers = /\bexport function\b|\bfunction\b|\bconst\b|=>|\breturn\b/.test(excerpt);

  if (hasHelpMarkers) {
    return "help";
  }

  if (hasImplementationMarkers && (filePath.includes("/src/") || filePath.startsWith("src/"))) {
    return "implementation";
  }

  if (filePath.endsWith(".md") || filePath.includes("readme") || filePath.includes("/docs/") || filePath.startsWith("docs/")) {
    return "docs";
  }

  if (filePath.includes("/test/") || filePath.startsWith("test/") || filePath.includes(".test.") || filePath.includes(".spec.")) {
    return "tests";
  }

  if (hasImplementationMarkers) {
    return "code";
  }

  return "reference";
}

function formatInvestigationReason(match) {
  const reasons = [];
  const significantMatchedTerms = (match.why?.matchedTerms ?? []).filter((term) => !INVESTIGATION_STOP_WORDS.has(term));

  if (match.kind === "implementation") {
    reasons.push("implementation bias");
  } else if (match.kind === "docs") {
    reasons.push("docs bias");
  } else if (match.kind === "tests") {
    reasons.push("tests bias");
  } else if (match.kind === "help") {
    reasons.push("help text");
  }

  if ((match.why?.phraseHits?.length ?? 0) > 0) {
    reasons.push(`matched phrase: ${match.why.phraseHits[0]}`);
  }

  if ((match.why?.pathHits?.length ?? 0) > 0) {
    reasons.push(`path hint: ${match.why.pathHits[0]}`);
  }

  if (significantMatchedTerms.length > 0) {
    reasons.push(`matched terms: ${significantMatchedTerms.slice(0, 3).join(", ")}`);
  }

  return reasons.join("; ") || "score-based retrieval";
}

export function deriveInvestigationGaps({
  queries = [],
  results = [],
  keyFiles = [],
  evidence = [],
  intent = "general",
  confidence = null,
  freshness = null,
  source = "index",
  sourceReason = null,
  root = null,
} = {}) {
  const gaps = [];
  const emptyQueries = results.filter((result) => (result.matches ?? []).length === 0).map((result) => result.query);

  if (evidence.length === 0) {
    gaps.push("No grounded matches were found for the investigation query set.");
    gaps.push(getInvestigationNextStep({ intent, confidence, hasEvidence: false }));
  }

  if (emptyQueries.length > 0) {
    gaps.push(`Some derived searches returned no evidence: ${emptyQueries.join(" | ")}`);
  }

  if (evidence.length > 0 && keyFiles.length === 1) {
    gaps.push("Evidence is concentrated in a single file; confirm nearby code directly.");
  }

  if (queries.length === 1 && evidence.length > 0) {
    gaps.push("Only one investigation query was available, so coverage may be narrow.");
  }

  if (evidence.length > 0 && confidence?.level !== "strong") {
    gaps.push(getInvestigationNextStep({ intent, confidence, hasEvidence: true }));
  }

  if (source === "index" && freshness?.status === "stale") {
    gaps.push(`Saved index appears stale; rerun \`${formatInvestigateIndexCommand(root)}\` before relying on this investigation.`);
  }

  if (source === "scan" && sourceReason === "saved index invalid JSON") {
    gaps.push(`Saved index is invalid JSON; rerun \`${formatInvestigateIndexCommand(root)}\` to repair it.`);
  }

  if (source === "scan" && sourceReason === "saved index unreadable") {
    gaps.push(`Saved index is unreadable; check file permissions or rerun \`${formatInvestigateIndexCommand(root)}\` to replace it.`);
  }

  return [...new Set(gaps)];
}

function formatInvestigateIndexCommand(rootDir) {
  const target = typeof rootDir === "string" && rootDir.trim() ? rootDir : "<dir>";
  return `grounded-workspace index ${JSON.stringify(target)}`;
}

export function deriveInvestigationConfidence({ keyFiles = [], evidence = [], gaps = [] } = {}) {
  if (evidence.length === 0) {
    return { level: "weak", reason: "no grounded evidence" };
  }

  const topFile = keyFiles[0] ?? null;
  const secondFile = keyFiles[1] ?? null;
  const topScore = topFile?.score ?? 0;
  const secondScore = secondFile?.score ?? 0;
  const strongLead = topScore >= secondScore + 10;

  if (gaps.length === 0 && evidence.length >= 2 && keyFiles.length >= 1 && strongLead) {
    return { level: "strong", reason: "multiple grounded excerpts with a clear top file" };
  }

  if (evidence.length >= 1 && keyFiles.length >= 1) {
    if (gaps.some((gap) => /single file|narrow/i.test(gap))) {
      return { level: "partial", reason: "useful evidence, but coverage is narrow" };
    }

    return { level: "partial", reason: "grounded evidence exists, but support is mixed" };
  }

  return { level: "weak", reason: "evidence is sparse" };
}

function getInvestigationNextStep({ intent = "general", confidence = null, hasEvidence = false } = {}) {
  if (!hasEvidence) {
    if (intent === "docs") {
      return "Next step: rerun with a docs-focused question or add path:docs/ext:md terms.";
    }

    if (intent === "tests") {
      return "Next step: rerun with a narrower test-oriented question or add path:test terms.";
    }

    if (intent === "code") {
      return "Next step: rerun with a narrower implementation question or add path:src terms.";
    }

    return "Next step: narrow the question or rerun with a path: or ext: filter.";
  }

  if (confidence?.level === "partial") {
    if (intent === "docs") {
      return "Next step: read the top README/docs hits directly and refine the question around the missing detail.";
    }

    if (intent === "tests") {
      return "Next step: read the top test file directly and rerun with the missing symbol or behavior name.";
    }

    if (intent === "code") {
      return "Next step: read the top src file directly and rerun with the specific function or module name.";
    }
  }

  return "Next step: read the strongest file directly and refine the question around the missing detail.";
}

export function buildInvestigationSummary({ question, keyFiles, evidence = [] }) {
  if (keyFiles.length === 0) {
    return "No grounded answer available.";
  }

  if (evidence.length > 0) {
    const groundedSummary = synthesizeAnswer(
      evidence.map((match) => ({
        ...match,
        rawExcerpt: match.excerpt,
      })),
      question,
      2,
    );

    if (isUsefulInvestigationSummary(groundedSummary, question)) {
      return groundedSummary;
    }
  }

  if (keyFiles.length === 1) {
    return `Strongest grounded evidence for "${question}" is in ${keyFiles[0].path}.`;
  }

  return `Strongest grounded evidence for "${question}" is in ${keyFiles[0].path}, then ${keyFiles[1].path}.`;
}

function isUsefulInvestigationSummary(summary, question = "") {
  if (!summary || summary === "No grounded answer available." || /^Grounded matches found,/i.test(summary)) {
    return false;
  }

  const trimmed = summary.trim();
  if (trimmed.split(/\s+/).length < 4) {
    return false;
  }

  if (/^[-#`]/.test(trimmed) || trimmed.startsWith("--")) {
    return false;
  }

  if (/[<{}`]/.test(trimmed)) {
    return false;
  }

  const meaningfulQueryTerms = deriveInvestigationTerms(parseQuery(question).queryText, detectInvestigationIntent(question));
  if (meaningfulQueryTerms.length > 0) {
    const normalizedSummary = trimmed.toLowerCase();
    const matchedMeaningfulTerms = meaningfulQueryTerms.filter((term) => normalizedSummary.includes(term));
    if (matchedMeaningfulTerms.length === 0) {
      return false;
    }
  }

  return /^[A-Za-z]/.test(trimmed);
}

function compactInvestigationMatch(match, maxLines = 8) {
  const sourceExcerpt = match.rawExcerpt ?? match.excerpt ?? "";
  const lines = sourceExcerpt.split("\n");
  if (!match.chunk || lines.length <= maxLines) {
    return {
      ...match,
      kind: classifyInvestigationEvidence(match),
      excerpt: sourceExcerpt,
    };
  }

  const bestLineIndex = findBestInvestigationLineIndex(lines, match.why);
  const startIndex = Math.max(0, Math.min(bestLineIndex - 2, lines.length - maxLines));
  const endIndex = Math.min(lines.length, startIndex + maxLines);
  const excerptLines = lines.slice(startIndex, endIndex);
  const prefix = startIndex > 0 ? ["..."] : [];
  const suffix = endIndex < lines.length ? ["..."] : [];

  return {
    ...match,
    kind: classifyInvestigationEvidence(match),
    chunk: {
      startLine: match.chunk.startLine + startIndex,
      endLine: match.chunk.startLine + endIndex - 1,
    },
    excerpt: [...prefix, ...excerptLines, ...suffix].join("\n"),
  };
}

function findBestInvestigationLineIndex(lines, why = {}) {
  let bestIndex = 0;
  let bestScore = -1;

  for (const [index, line] of lines.entries()) {
    const score = scoreInvestigationLine(line, why);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  return bestIndex;
}

function scoreInvestigationLine(line, why = {}) {
  const normalizedLine = line.toLowerCase();
  let score = 0;
  const significantMatchedTerms = (why.matchedTerms ?? []).filter((term) => !INVESTIGATION_STOP_WORDS.has(term));

  for (const token of significantMatchedTerms) {
    if (normalizedLine.includes(token)) {
      score += 2;
    }
  }

  for (const phrase of why.phraseHits ?? []) {
    if (normalizedLine.includes(phrase)) {
      score += 3;
    }
  }

  for (const token of why.pathHits ?? []) {
    if (normalizedLine.includes(token)) {
      score += 1;
    }
  }

  if (/\bfunction\b|\bconst\b|\breturn\b|=>/.test(line)) {
    score += 1;
  }

  return score;
}

export async function writeInvestigateOutput(outputFile, content, format = "text") {
  const targetPath = await resolveInvestigateOutputPath(outputFile, format);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content, "utf8");
  return targetPath;
}

export async function resolveInvestigateOutputPath(outputFile, format = "text") {
  const resolvedPath = path.resolve(outputFile);
  const defaultExtension = getInvestigateOutputExtension(format);

  if (/[\\/]$/.test(outputFile)) {
    return path.join(resolvedPath, `investigate-report${defaultExtension}`);
  }

  try {
    const stat = await fs.stat(resolvedPath);
    if (stat.isDirectory()) {
      return path.join(resolvedPath, `investigate-report${defaultExtension}`);
    }
  } catch {
    // Fall through and infer from the path string.
  }

  const currentExtension = path.extname(resolvedPath);
  if (!currentExtension) {
    return `${resolvedPath}${defaultExtension}`;
  }

  if (currentExtension.toLowerCase() !== defaultExtension) {
    return `${resolvedPath.slice(0, -currentExtension.length)}${defaultExtension}`;
  }

  return resolvedPath;
}

function getInvestigateOutputExtension(format) {
  if (format === "json") {
    return ".json";
  }

  if (format === "markdown") {
    return ".md";
  }

  if (format === "html") {
    return ".html";
  }

  return ".txt";
}

export function formatInvestigateExportManifest({ reportPath = null, metadataPath = null, asJson = false } = {}) {
  if (asJson) {
    return `${JSON.stringify({ ...(reportPath ? { report: reportPath } : {}), ...(metadataPath ? { metadata: metadataPath } : {}) }, null, 2)}\n`;
  }

  let output = "";
  if (reportPath) {
    output += `report=${reportPath}\n`;
  }
  if (metadataPath) {
    output += `metadata=${metadataPath}\n`;
  }
  return output;
}

function formatChunkRange(chunk) {
  if (!chunk) {
    return "";
  }

  return `:${chunk.startLine}-${chunk.endLine}`;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}
