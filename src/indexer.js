import fs from "node:fs/promises";
import path from "node:path";

export const INDEX_FILE_NAME = ".grounded-workspace-index.json";
export const IGNORE_FILE_NAME = ".grounded-workspaceignore";
const CHUNK_SIZE_LINES = 12;
const CHUNK_OVERLAP_LINES = 4;

const DEFAULT_IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  ".cache",
]);

const TEXT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".css",
  ".go",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".md",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".svg",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

export async function scanWorkspace(rootDir) {
  const ignoreRules = await loadIgnoreRules(rootDir);
  const files = await collectWorkspaceFiles(rootDir, ignoreRules);
  return files.flatMap((file) => chunkDocument(file.path, file.content));
}

export async function buildIndex(rootDir, options = {}) {
  const incremental = options.incremental === true;
  const ignoreRules = await loadIgnoreRules(rootDir);
  const files = await collectWorkspaceFiles(rootDir, ignoreRules);
  const fileRecords = files.map((file) => ({
    path: file.path,
    mtimeMs: file.mtimeMs,
  }));
  let documents;
  let reusedFiles = 0;
  let changedFiles = files.length;
  let deletedFiles = 0;

  if (incremental) {
    const existingIndex = await loadIncrementalBaseIndex(rootDir);
    if (existingIndex?.files) {
      const existingFileMap = new Map(existingIndex.files.map((file) => [file.path, file]));
      const existingDocumentsByPath = groupDocumentsByPath(hydrateDocuments(existingIndex.documents ?? []));
      const currentPaths = new Set(files.map((file) => file.path));
      documents = [];
      changedFiles = 0;

      for (const file of files) {
        const existingFile = existingFileMap.get(file.path);
        if (existingFile && existingFile.mtimeMs === file.mtimeMs && existingDocumentsByPath.has(file.path)) {
          documents.push(...existingDocumentsByPath.get(file.path));
          reusedFiles += 1;
          continue;
        }

        documents.push(...chunkDocument(file.path, file.content));
        changedFiles += 1;
      }

      deletedFiles = existingIndex.files.filter((file) => !currentPaths.has(file.path)).length;
    } else {
      documents = files.flatMap((file) => chunkDocument(file.path, file.content));
    }
  } else {
    documents = files.flatMap((file) => chunkDocument(file.path, file.content));
  }

  return {
    version: 3,
    root: rootDir,
    generatedAt: new Date().toISOString(),
    filesIndexed: countUniqueFiles(documents),
    chunksIndexed: documents.length,
    files: fileRecords,
    incremental: {
      enabled: incremental,
      reusedFiles,
      changedFiles,
      deletedFiles,
    },
    documents: documents.map(serializeDocument),
  };
}

export async function saveIndex(rootDir, index) {
  const indexPath = getIndexPath(rootDir);
  await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return indexPath;
}

export async function loadIndex(rootDir) {
  const indexPath = getIndexPath(rootDir);
  const raw = await fs.readFile(indexPath, "utf8");
  return JSON.parse(raw);
}

export async function loadDocuments(rootDir) {
  try {
    const index = await loadIndex(rootDir);
    return {
      source: "index",
      sourceReason: "loaded saved index",
      indexPath: getIndexPath(rootDir),
      generatedAt: index.generatedAt ?? null,
      files: index.files ?? null,
      documents: hydrateDocuments(index.documents),
    };
  } catch (error) {
    const sourceReason =
      error?.code === "ENOENT"
        ? "saved index missing"
        : error instanceof SyntaxError
          ? "saved index invalid JSON"
          : "saved index unreadable";
    const documents = await scanWorkspace(rootDir);
    return {
      source: "scan",
      sourceReason,
      indexPath: getIndexPath(rootDir),
      generatedAt: null,
      documents,
    };
  }
}

export async function getIndexFreshness(rootDir, generatedAt = null) {
  let indexedFiles = null;

  if (generatedAt && typeof generatedAt === "object") {
    indexedFiles = Array.isArray(generatedAt.files) ? generatedAt.files : null;
    generatedAt = generatedAt.generatedAt ?? null;
  }

  if (Array.isArray(indexedFiles) && indexedFiles.length > 0) {
    return getIndexedFilesFreshness(rootDir, indexedFiles);
  }

  const indexGeneratedAt = generatedAt ? Date.parse(generatedAt) : Number.NaN;
  if (!Number.isFinite(indexGeneratedAt)) {
    return {
      status: "unknown",
      reason: "index timestamp unavailable",
      latestFilePath: null,
      latestFileMtime: null,
    };
  }

  const ignoreRules = await loadIgnoreRules(rootDir);
  const latestFile = await findLatestIndexedFile(rootDir, rootDir, ignoreRules);

  if (!latestFile) {
    return {
      status: "fresh",
      reason: "no newer indexed files found",
      latestFilePath: null,
      latestFileMtime: null,
    };
  }

  if (latestFile.mtimeMs > indexGeneratedAt) {
    return {
      status: "stale",
      reason: `${latestFile.path} changed after the saved index was generated`,
      latestFilePath: latestFile.path,
      latestFileMtime: new Date(latestFile.mtimeMs).toISOString(),
    };
  }

  return {
    status: "fresh",
    reason: "saved index is newer than indexed files",
    latestFilePath: latestFile.path,
    latestFileMtime: new Date(latestFile.mtimeMs).toISOString(),
  };
}

async function getIndexedFilesFreshness(rootDir, indexedFiles) {
  const ignoreRules = await loadIgnoreRules(rootDir);
  const currentFiles = await collectWorkspaceFiles(rootDir, ignoreRules);
  const currentFileMap = new Map(currentFiles.map((file) => [file.path, file]));
  const indexedFileMap = new Map(indexedFiles.map((file) => [file.path, file]));
  const changedFiles = [];
  const deletedFiles = [];
  const newFiles = [];
  let latestChanged = null;

  for (const indexedFile of indexedFiles) {
    const currentFile = currentFileMap.get(indexedFile.path);
    if (!currentFile) {
      deletedFiles.push(indexedFile.path);
      continue;
    }

    if (currentFile.mtimeMs !== indexedFile.mtimeMs) {
      changedFiles.push(indexedFile.path);
      if (!latestChanged || currentFile.mtimeMs > latestChanged.mtimeMs) {
        latestChanged = {
          path: currentFile.path,
          mtimeMs: currentFile.mtimeMs,
        };
      }
    }
  }

  for (const currentFile of currentFiles) {
    if (!indexedFileMap.has(currentFile.path)) {
      newFiles.push(currentFile.path);
      if (!latestChanged || currentFile.mtimeMs > latestChanged.mtimeMs) {
        latestChanged = {
          path: currentFile.path,
          mtimeMs: currentFile.mtimeMs,
        };
      }
    }
  }

  if (changedFiles.length === 0 && deletedFiles.length === 0 && newFiles.length === 0) {
    return {
      status: "fresh",
      reason: "saved index matches current indexed files",
      latestFilePath: currentFiles[0]?.path ?? null,
      latestFileMtime: currentFiles[0] ? new Date(currentFiles[0].mtimeMs).toISOString() : null,
      changedFiles: 0,
      deletedFiles: 0,
      newFiles: 0,
    };
  }

  const reasonParts = [];
  if (changedFiles.length > 0) {
    reasonParts.push(`${changedFiles.length} changed`);
  }
  if (deletedFiles.length > 0) {
    reasonParts.push(`${deletedFiles.length} deleted`);
  }
  if (newFiles.length > 0) {
    reasonParts.push(`${newFiles.length} new`);
  }

  return {
    status: "stale",
    reason: `saved index differs from current files (${reasonParts.join(", ")})`,
    latestFilePath: latestChanged?.path ?? null,
    latestFileMtime: latestChanged ? new Date(latestChanged.mtimeMs).toISOString() : null,
    changedFiles: changedFiles.length,
    deletedFiles: deletedFiles.length,
    newFiles: newFiles.length,
  };
}

export function getIndexPath(rootDir) {
  return path.join(rootDir, INDEX_FILE_NAME);
}

async function walk(rootDir, currentDir, files, ignoreRules) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = path.relative(rootDir, absolutePath);

    if (entry.isDirectory()) {
      if (!shouldIgnorePath(relativePath, entry.name, true, ignoreRules)) {
        await walk(rootDir, absolutePath, files, ignoreRules);
      }
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!shouldIndexFile(relativePath, entry.name, ignoreRules)) {
      continue;
    }

    const content = await readTextFile(absolutePath);
    if (!content) {
      continue;
    }

    files.push(...chunkDocument(relativePath, content));
  }
}

async function collectWorkspaceFiles(rootDir, ignoreRules) {
  const files = [];
  await walkFiles(rootDir, rootDir, files, ignoreRules);
  return files;
}

async function walkFiles(rootDir, currentDir, files, ignoreRules) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = path.relative(rootDir, absolutePath);

    if (entry.isDirectory()) {
      if (!shouldIgnorePath(relativePath, entry.name, true, ignoreRules)) {
        await walkFiles(rootDir, absolutePath, files, ignoreRules);
      }
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!shouldIndexFile(relativePath, entry.name, ignoreRules)) {
      continue;
    }

    const content = await readTextFile(absolutePath);
    if (!content) {
      continue;
    }

    try {
      const stat = await fs.stat(absolutePath);
      files.push({
        path: relativePath.split(path.sep).join("/"),
        absolutePath,
        mtimeMs: stat.mtimeMs,
        content,
      });
    } catch {
      continue;
    }
  }
}

async function loadIncrementalBaseIndex(rootDir) {
  try {
    const index = await loadIndex(rootDir);
    if (!Array.isArray(index.files)) {
      return null;
    }
    return index;
  } catch {
    return null;
  }
}

async function findLatestIndexedFile(rootDir, currentDir, ignoreRules, latest = null) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = path.relative(rootDir, absolutePath);

    if (entry.isDirectory()) {
      if (!shouldIgnorePath(relativePath, entry.name, true, ignoreRules)) {
        latest = await findLatestIndexedFile(rootDir, absolutePath, ignoreRules, latest);
      }
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!shouldIndexFile(relativePath, entry.name, ignoreRules)) {
      continue;
    }

    try {
      const stat = await fs.stat(absolutePath);
      if (!latest || stat.mtimeMs > latest.mtimeMs) {
        latest = {
          path: relativePath.split(path.sep).join("/"),
          mtimeMs: stat.mtimeMs,
        };
      }
    } catch {
      continue;
    }
  }

  return latest;
}

function shouldIndexFile(relativePath, fileName, ignoreRules) {
  if (fileName === INDEX_FILE_NAME || fileName === IGNORE_FILE_NAME) {
    return false;
  }

  const extension = path.extname(fileName).toLowerCase();
  if (!TEXT_EXTENSIONS.has(extension) && extension !== "") {
    return false;
  }

  return !shouldIgnorePath(relativePath, fileName, false, ignoreRules);
}

async function readTextFile(filePath) {
  try {
    const buffer = await fs.readFile(filePath);
    if (buffer.includes(0)) {
      return null;
    }
    return buffer.toString("utf8");
  } catch {
    return null;
  }
}

export function rankDocuments(documents, query, defaultLimit = 5, options = {}) {
  const { queryText, filters } = parseQuery(query);
  const resultLimit = filters.limit ?? defaultLimit;
  const minScore = filters.minScore ?? 0;
  const explanationLevel = filters.explain ?? "verbose";
  const excerptMode = filters.excerpt ?? "raw";
  const highlightStyle = filters.highlight ?? "brackets";
  const highlightTheme = filters.theme ?? "yellow";
  const ansiThemes = options.ansiThemes ?? {};
  const wrapperThemes = options.wrapperThemes ?? {};
  const filteredDocuments = applyFilters(documents, filters);
  const queryTokens = expandQueryTokens(queryText);
  const scored = filteredDocuments
    .map((document) => {
      const scoring = scoreDocument(document, queryTokens, queryText);
      return { ...document, score: scoring.total, why: scoring.why };
    })
    .filter((document) => document.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, resultLimit * 3)
    .map((document) => ({
      path: document.path,
      chunk: document.chunk,
      score: document.score,
      why: document.why,
      rawExcerpt: document.content,
      highlightedExcerpt: highlightExcerpt(document.content, queryTokens, highlightStyle, highlightTheme, ansiThemes, wrapperThemes),
    }));

  return mergeRankedMatches(scored)
    .filter((match) => match.score >= minScore)
    .map((match) => ({
      ...match,
      why: formatWhy(match.why, explanationLevel),
      excerpt: excerptMode === "highlighted" ? match.highlightedExcerpt : match.rawExcerpt,
    }))
    .slice(0, resultLimit);
}

export function synthesizeAnswer(matches, query, maxSentences = 3) {
  const { queryText } = parseQuery(query);
  const queryTokens = [...expandQueryTokens(queryText).keys()];

  if (matches.length === 0) {
    return "No grounded answer available.";
  }

  const candidateSentences = [];

  for (const match of matches.slice(0, 3)) {
    const excerpt = match.rawExcerpt ?? match.excerpt;
    const sentences = splitIntoSentences(excerpt);
    for (const sentence of sentences) {
      const score = scoreSummarySentence(sentence, queryTokens, match.path);
      if (score > 0) {
        candidateSentences.push({
          path: match.path,
          chunk: match.chunk,
          text: sentence,
          score,
        });
      }
    }
  }

  if (candidateSentences.length === 0) {
    const fallback =
      matches
        .flatMap((match) => (match.rawExcerpt ?? match.excerpt).split("\n"))
        .map((line) => line.trim())
        .find((line) => line && !looksLikeCode(line)) ??
      matches
        .flatMap((match) => (match.rawExcerpt ?? match.excerpt).split("\n"))
        .map((line) => line.trim())
        .find((line) => line && /[a-z]/i.test(line) && !looksLikeCode(line));

    return fallback ? fallback.trim() : "Grounded matches found, but no prose summary was available.";
  }

  const rankedSentences = candidateSentences
    .sort((a, b) => b.score - a.score)
    .filter((sentence, index, all) => {
      return all.findIndex((other) => other.text === sentence.text) === index;
    });

  const completeSentences = rankedSentences.filter((sentence) => /[.!?]$/.test(sentence.text));
  const sourceSentences = completeSentences.length > 0 ? completeSentences : rankedSentences;

  const uniqueSentences = dedupeSimilarSentences(sourceSentences);

  const topSentences = uniqueSentences
    .slice(0, maxSentences)
    .map((sentence) => sentence.text.trim());

  return topSentences.join(" ");
}

export function parseQuery(query) {
  const filters = {
    extensions: [],
    pathPrefixes: [],
    limit: null,
    minScore: null,
    explain: "verbose",
    excerpt: "raw",
    highlight: "brackets",
    theme: "yellow",
  };
  const terms = [];

  for (const rawPart of query.split(/\s+/)) {
    const part = rawPart.trim();
    if (!part) {
      continue;
    }

    if (part.startsWith("ext:")) {
      const extension = normalizeExtensionFilter(part.slice(4));
      if (extension) {
        filters.extensions.push(extension);
        continue;
      }
    }

    if (part.startsWith("path:")) {
      const prefix = normalizePathFilter(part.slice(5));
      if (prefix) {
        filters.pathPrefixes.push(prefix);
        continue;
      }
    }

    if (part.startsWith("limit:")) {
      const limit = normalizeLimitFilter(part.slice(6));
      if (limit !== null) {
        filters.limit = limit;
        continue;
      }
    }

    if (part.startsWith("minscore:")) {
      const minScore = normalizeMinScoreFilter(part.slice(9));
      if (minScore !== null) {
        filters.minScore = minScore;
        continue;
      }
    }

    if (part.startsWith("explain:")) {
      const explain = normalizeExplainFilter(part.slice(8));
      if (explain) {
        filters.explain = explain;
        continue;
      }
    }

    if (part.startsWith("excerpt:")) {
      const excerpt = normalizeExcerptFilter(part.slice(8));
      if (excerpt) {
        filters.excerpt = excerpt;
        continue;
      }
    }

    if (part.startsWith("highlight:")) {
      const highlight = normalizeHighlightFilter(part.slice(10));
      if (highlight) {
        filters.highlight = highlight;
        continue;
      }
    }

    if (part.startsWith("theme:")) {
      const theme = normalizeThemeFilter(part.slice(6));
      if (theme) {
        filters.theme = theme;
        continue;
      }
    }

    terms.push(part);
  }

  return {
    queryText: terms.join(" ").trim(),
    filters,
  };
}

function scoreDocument(document, queryTokens, query) {
  let matchedTerms = 0;
  const { tokens: documentTokens, path: filePath, content } = document;
  const pathLower = filePath.toLowerCase();
  const contentLower = content.toLowerCase();
  const uniqueQueryTerms = [...queryTokens.keys()];
  let tokenScore = 0;
  let pathScore = 0;
  const matchedTokens = [];
  const pathHits = [];

  for (const token of uniqueQueryTerms) {
    const tokenHits = documentTokens.get(token) ?? 0;
    if (tokenHits > 0) {
      matchedTerms += 1;
      tokenScore += 2 + Math.min(tokenHits, 3);
      matchedTokens.push(token);
    }

    if (pathLower.includes(token)) {
      pathScore += 3;
      pathHits.push(token);
    }
  }

  if (matchedTerms === 0) {
    return {
      total: 0,
      why: {
        tokenScore: 0,
        pathScore: 0,
        coverageScore: 0,
        phraseScore: 0,
        densityScore: 0,
        retrievalBias: 0,
        matchedTerms: [],
        phraseHits: [],
        pathHits: [],
      },
    };
  }

  const coverageRatio = matchedTerms / uniqueQueryTerms.length;
  const coverageScore = coverageRatio * 8;

  const normalizedQuery = normalizeText(query);
  let phraseScore = 0;
  const phraseHits = [];
  if (normalizedQuery && contentLower.includes(normalizedQuery)) {
    phraseScore += 6;
    phraseHits.push(normalizedQuery);
  }

  const phraseWindows = buildPhraseWindows(normalizedQuery);
  for (const phrase of phraseWindows) {
    if (contentLower.includes(phrase)) {
      phraseScore += 2;
      phraseHits.push(phrase);
    }
  }

  const tokenCount = Math.max(countContentTokens(content), 1);
  const densityBonus = matchedTerms / tokenCount;
  const densityScore = densityBonus * 20;
  const retrievalBias = getPathRetrievalBias(filePath);
  const total = tokenScore + pathScore + coverageScore + phraseScore + densityScore + retrievalBias;

  return {
    total: Number(total.toFixed(3)),
    why: {
      tokenScore: Number(tokenScore.toFixed(3)),
      pathScore: Number(pathScore.toFixed(3)),
      coverageScore: Number(coverageScore.toFixed(3)),
      phraseScore: Number(phraseScore.toFixed(3)),
      densityScore: Number(densityScore.toFixed(3)),
      retrievalBias: Number(retrievalBias.toFixed(3)),
      matchedTerms: uniqueArray(matchedTokens),
      phraseHits: uniqueArray(phraseHits),
      pathHits: uniqueArray(pathHits),
    },
  };
}

export function tokenize(value) {
  const counts = new Map();
  const tokens = value.toLowerCase().match(/[a-z0-9_/-]+/g) ?? [];

  for (const token of tokens) {
    if (token.length < 2) {
      continue;
    }

    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return counts;
}

function normalizeText(value) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function buildPhraseWindows(query) {
  const terms = query.split(" ").filter(Boolean);
  const phrases = [];

  for (let index = 0; index < terms.length - 1; index += 1) {
    phrases.push(`${terms[index]} ${terms[index + 1]}`);
  }

  return phrases;
}

function countContentTokens(content) {
  return content.match(/[a-z0-9_/-]+/gi)?.length ?? 0;
}

function splitIntoSentences(content) {
  return content
    .split(/\n+/)
    .flatMap(extractSentenceCandidates)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 12)
    .filter((sentence) => !looksLikeCode(sentence))
    .filter((sentence) => !looksLikeFragment(sentence));
}

function scoreSummarySentence(sentence, queryTokens, filePath) {
  const normalizedSentence = normalizeText(sentence);
  let score = 0;

  for (const token of queryTokens) {
    if (normalizedSentence.includes(token)) {
      score += 2;
    }
  }

  score += Math.max(0, 20 - sentence.length / 8);
  score += getPathAnswerBias(filePath);
  score += getProseQualityBias(sentence);
  return Number(score.toFixed(3));
}

function getPathAnswerBias(filePath) {
  const normalizedPath = filePath.toLowerCase();
  let score = 0;

  if (normalizedPath.includes("readme")) {
    score += 5;
  }

  if (normalizedPath.endsWith(".md")) {
    score += 3;
  }

  if (normalizedPath.includes("/docs/") || normalizedPath.startsWith("docs/")) {
    score += 3;
  }

  if (normalizedPath.includes("/test/") || normalizedPath.startsWith("test/")) {
    score -= 6;
  }

  if (normalizedPath.includes(".test.") || normalizedPath.includes(".spec.")) {
    score -= 6;
  }

  return score;
}

function getPathRetrievalBias(filePath) {
  const normalizedPath = filePath.toLowerCase();
  let score = 0;

  if (normalizedPath.includes("readme")) {
    score += 4;
  }

  if (normalizedPath.endsWith(".md")) {
    score += 2;
  }

  if (normalizedPath.includes("/docs/") || normalizedPath.startsWith("docs/")) {
    score += 2;
  }

  if (normalizedPath.includes("/test/") || normalizedPath.startsWith("test/")) {
    score -= 5;
  }

  if (normalizedPath.includes(".test.") || normalizedPath.includes(".spec.")) {
    score -= 5;
  }

  return score;
}

function getProseQualityBias(sentence) {
  let score = 0;

  if (/[.!?]$/.test(sentence)) {
    score += 2;
  }

  if (/\b(the|this|that|it|ask|index|stores|returns|uses|reuses)\b/i.test(sentence)) {
    score += 2;
  }

  if (/^[A-Z]/.test(sentence)) {
    score += 1;
  }

  return score;
}

function looksLikeCode(sentence) {
  if (!/[a-z]/i.test(sentence)) {
    return true;
  }

  if (/^\s*#/.test(sentence)) {
    return true;
  }

  if (/[{};$`]|=>|\bconst\b|\breturn\b|\bfunction\b/.test(sentence)) {
    return true;
  }

  if (/\b(node|npm|npx|yarn|pnpm)\b/i.test(sentence)) {
    return true;
  }

  if (sentence.includes("./") || sentence.includes("/") || sentence.includes('"')) {
    return true;
  }

  return false;
}

function looksLikeFragment(sentence) {
  if (/\b(ext:|path:|limit:)\b/i.test(sentence)) {
    return true;
  }

  if (!/[.!?]$/.test(sentence) && !/\b(the|this|that|it|ask|index|stores|returns|uses|reuses|loads)\b/i.test(sentence)) {
    return true;
  }

  if (sentence.split(/\s+/).length < 4) {
    return true;
  }

  return false;
}

function extractSentenceCandidates(line) {
  const quotedMatches = [...line.matchAll(/"([^"]{12,})"/g)];
  const candidates = quotedMatches.length > 0 ? [] : [line];

  for (const match of quotedMatches) {
    candidates.push(match[1]);
  }

  return candidates;
}

function dedupeSimilarSentences(sentences) {
  const kept = [];

  for (const sentence of sentences) {
    const isNearDuplicate = kept.some((existing) => {
      return sentenceSimilarity(existing.text, sentence.text) >= 0.75;
    });

    if (!isNearDuplicate) {
      kept.push(sentence);
    }
  }

  return kept;
}

function sentenceSimilarity(left, right) {
  const leftTokens = new Set(tokenize(left).keys());
  const rightTokens = new Set(tokenize(right).keys());

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

function highlightExcerpt(content, queryTokens, style = "brackets", theme = "yellow", ansiThemes = {}, wrapperThemes = {}) {
  const tokens = [...queryTokens.keys()].filter((token) => token.length >= 2);
  if (tokens.length === 0) {
    return content;
  }

  const pattern = new RegExp(`\\b(${tokens.map(escapeRegExp).join("|")})\\b`, "gi");
  return content
    .split("\n")
    .map((line) => {
      if (looksLikeCode(line)) {
        return line;
      }

      return line.replace(pattern, (match) => formatHighlightedMatch(match, style, theme, ansiThemes, wrapperThemes));
    })
    .join("\n");
}

function formatHighlightedMatch(match, style, theme, ansiThemes, wrapperThemes) {
  if (style === "plain") {
    const wrapper = getWrapperTheme(theme, wrapperThemes);
    if (wrapper) {
      return `${wrapper.before}${match}${wrapper.after}`;
    }
    return `<<${match}>>`;
  }

  if (style === "ansi") {
    const ansiTheme = getAnsiTheme(theme, ansiThemes);
    return `${ansiTheme.start}${match}${ansiTheme.reset}`;
  }

  if (style === "tags") {
    const wrapper = getWrapperTheme(theme, wrapperThemes);
    if (wrapper) {
      return `${wrapper.before}${match}${wrapper.after}`;
    }
    return `<mark>${match}</mark>`;
  }

  const wrapper = getWrapperTheme(theme, wrapperThemes);
  if (wrapper) {
    return `${wrapper.before}${match}${wrapper.after}`;
  }

  return `[${match}]`;
}

function getAnsiTheme(theme, ansiThemes = {}) {
  const customTheme = ansiThemes[theme];
  if (typeof customTheme === "string" && customTheme) {
    return { start: customTheme, reset: "\u001B[0m" };
  }

  if (customTheme && typeof customTheme === "object" && typeof customTheme.start === "string" && typeof customTheme.reset === "string") {
    return customTheme;
  }

  if (theme === "cyan") {
    return { start: "\u001B[1;36m", reset: "\u001B[0m" };
  }

  if (theme === "green") {
    return { start: "\u001B[1;32m", reset: "\u001B[0m" };
  }

  if (theme === "magenta") {
    return { start: "\u001B[1;35m", reset: "\u001B[0m" };
  }

  if (theme === "inverse") {
    return { start: "\u001B[7m", reset: "\u001B[0m" };
  }

  if (theme === "bold") {
    return { start: "\u001B[1m", reset: "\u001B[0m" };
  }

  return { start: "\u001B[1;33m", reset: "\u001B[0m" };
}

function getWrapperTheme(theme, wrapperThemes = {}) {
  const wrapper = wrapperThemes[theme];
  if (!wrapper || typeof wrapper !== "object") {
    return null;
  }

  if (typeof wrapper.before !== "string" || typeof wrapper.after !== "string") {
    return null;
  }

  return wrapper;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyFilters(documents, filters) {
  return documents.filter((document) => {
    if (filters.extensions.length > 0) {
      const extension = path.extname(document.path).toLowerCase();
      if (!filters.extensions.includes(extension)) {
        return false;
      }
    }

    if (filters.pathPrefixes.length > 0) {
      const normalizedPath = document.path.split(path.sep).join("/");
      const matchesPrefix = filters.pathPrefixes.some(
        (prefix) => normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`),
      );
      if (!matchesPrefix) {
        return false;
      }
    }

    return true;
  });
}

function mergeRankedMatches(matches) {
  const merged = [];

  for (const match of matches) {
    const previous = merged[merged.length - 1];
    if (previous && canMergeMatches(previous, match)) {
      previous.chunk = {
        startLine: Math.min(previous.chunk.startLine, match.chunk.startLine),
        endLine: Math.max(previous.chunk.endLine, match.chunk.endLine),
      };
      previous.score = Number(Math.max(previous.score, match.score).toFixed(3));
      previous.why = mergeWhy(previous.why, match.why);
      previous.rawExcerpt = mergeExcerpt(previous.rawExcerpt, match.rawExcerpt);
      previous.highlightedExcerpt = mergeExcerpt(previous.highlightedExcerpt, match.highlightedExcerpt);
      continue;
    }

    merged.push({ ...match });
  }

  return merged;
}

function canMergeMatches(left, right) {
  if (left.path !== right.path || !left.chunk || !right.chunk) {
    return false;
  }

  return right.chunk.startLine <= left.chunk.endLine + 2;
}

function mergeExcerpt(leftExcerpt, rightExcerpt) {
  if (leftExcerpt.includes(rightExcerpt)) {
    return leftExcerpt;
  }

  if (rightExcerpt.includes(leftExcerpt)) {
    return rightExcerpt;
  }

  return `${leftExcerpt}\n...\n${rightExcerpt}`;
}

function mergeWhy(leftWhy, rightWhy) {
  return {
    tokenScore: Number(Math.max(leftWhy.tokenScore, rightWhy.tokenScore).toFixed(3)),
    pathScore: Number(Math.max(leftWhy.pathScore, rightWhy.pathScore).toFixed(3)),
    coverageScore: Number(Math.max(leftWhy.coverageScore, rightWhy.coverageScore).toFixed(3)),
    phraseScore: Number(Math.max(leftWhy.phraseScore, rightWhy.phraseScore).toFixed(3)),
    densityScore: Number(Math.max(leftWhy.densityScore, rightWhy.densityScore).toFixed(3)),
    retrievalBias: Number(Math.max(leftWhy.retrievalBias, rightWhy.retrievalBias).toFixed(3)),
    matchedTerms: uniqueArray([...(leftWhy.matchedTerms ?? []), ...(rightWhy.matchedTerms ?? [])]),
    phraseHits: uniqueArray([...(leftWhy.phraseHits ?? []), ...(rightWhy.phraseHits ?? [])]),
    pathHits: uniqueArray([...(leftWhy.pathHits ?? []), ...(rightWhy.pathHits ?? [])]),
  };
}

function uniqueArray(values) {
  return [...new Set(values)];
}

function formatWhy(why, explanationLevel) {
  if (explanationLevel === "terse") {
    return {
      tokenScore: why.tokenScore,
      pathScore: why.pathScore,
      coverageScore: why.coverageScore,
      phraseScore: why.phraseScore,
      densityScore: why.densityScore,
      retrievalBias: why.retrievalBias,
      matchedTerms: why.matchedTerms,
    };
  }

  return why;
}

function normalizeExtensionFilter(value) {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9.]/g, "");
  if (!normalized) {
    return null;
  }

  return normalized.startsWith(".") ? normalized : `.${normalized}`;
}

function normalizePathFilter(value) {
  const normalized = value.trim().replace(/^\/+|\/+$/g, "");
  return normalized ? normalized.split(path.sep).join("/") : null;
}

function normalizeLimitFilter(value) {
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return null;
  }

  return Math.min(parsed, 20);
}

function normalizeMinScoreFilter(value) {
  const parsed = Number.parseFloat(value.trim());
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return Math.min(parsed, 100);
}

function normalizeExcerptFilter(value) {
  const normalized = value.trim().toLowerCase();
  if (normalized === "raw" || normalized === "highlighted") {
    return normalized;
  }

  return null;
}

function normalizeHighlightFilter(value) {
  const normalized = value.trim().toLowerCase();
  if (normalized === "plain" || normalized === "brackets" || normalized === "ansi" || normalized === "tags") {
    return normalized;
  }

  return null;
}

function normalizeThemeFilter(value) {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return normalized || null;
}

function normalizeExplainFilter(value) {
  const normalized = value.trim().toLowerCase();
  if (normalized === "terse" || normalized === "verbose") {
    return normalized;
  }

  return null;
}

async function loadIgnoreRules(rootDir) {
  const ignorePath = path.join(rootDir, IGNORE_FILE_NAME);

  try {
    const content = await fs.readFile(ignorePath, "utf8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch {
    return [];
  }
}

function shouldIgnorePath(relativePath, entryName, isDirectory, ignoreRules) {
  if (DEFAULT_IGNORE_DIRS.has(entryName)) {
    return true;
  }

  const normalizedPath = relativePath.split(path.sep).join("/");

  for (const rule of ignoreRules) {
    const normalizedRule = rule.replace(/\/+$/, "");

    if (rule.endsWith("/")) {
      if (normalizedPath === normalizedRule || normalizedPath.startsWith(`${normalizedRule}/`)) {
        return true;
      }
      continue;
    }

    if (normalizedPath === normalizedRule) {
      return true;
    }

    if (isDirectory && entryName === normalizedRule) {
      return true;
    }

    if (!isDirectory && entryName === normalizedRule) {
      return true;
    }

    if (normalizedPath.startsWith(`${normalizedRule}/`)) {
      return true;
    }
  }

  return false;
}

function serializeDocument(document) {
  return {
    path: document.path,
    chunk: document.chunk,
    content: document.content,
    tokens: Object.fromEntries(document.tokens),
  };
}

function hydrateDocuments(documents) {
  return documents.map((document) => ({
    path: document.path,
    chunk: document.chunk,
    content: document.content,
    tokens: new Map(Object.entries(document.tokens)),
  }));
}

function groupDocumentsByPath(documents) {
  const grouped = new Map();

  for (const document of documents) {
    const existing = grouped.get(document.path) ?? [];
    existing.push(document);
    grouped.set(document.path, existing);
  }

  return grouped;
}

function chunkDocument(filePath, content) {
  const lines = content.split("\n");
  if (lines.length <= CHUNK_SIZE_LINES) {
    return [
      {
        path: filePath,
        chunk: { startLine: 1, endLine: Math.max(lines.length, 1) },
        content: content.trim(),
        tokens: tokenize(`${filePath}\n${content}`),
      },
    ];
  }

  const splitPoints = findChunkSplitPoints(lines);
  const documents = [];
  const step = CHUNK_SIZE_LINES - CHUNK_OVERLAP_LINES;

  for (let start = 0; start < lines.length; start += step) {
    let end = Math.min(lines.length, start + CHUNK_SIZE_LINES);
    const forcedEnd = splitPoints.find((lineNumber) => lineNumber > start + 1 && lineNumber < end);
    if (forcedEnd) {
      end = forcedEnd - 1;
    }
    const chunkContent = lines.slice(start, end).join("\n").trim();

    if (!chunkContent) {
      if (forcedEnd) {
        start = forcedEnd - step - 1;
      }
      continue;
    }

    documents.push({
      path: filePath,
      chunk: { startLine: start + 1, endLine: end },
      content: chunkContent,
      tokens: tokenize(`${filePath}\n${chunkContent}`),
    });

    if (forcedEnd) {
      start = forcedEnd - step - 1;
    }

    if (end === lines.length) {
      break;
    }
  }

  return documents;
}

function findChunkSplitPoints(lines) {
  const splitPoints = [];
  let optionRunLength = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const isOptionLine = /^\s{0,2}--[a-z0-9-]+/.test(line);

    if (/^(Usage:|Notes:)$/i.test(trimmed)) {
      splitPoints.push(index + 1);
    }

    if (isOptionLine) {
      optionRunLength += 1;
    } else {
      if (optionRunLength >= 3) {
        splitPoints.push(index + 1);
      }
      optionRunLength = 0;
    }
  }

  return [...new Set(splitPoints)].sort((left, right) => left - right);
}

function countUniqueFiles(documents) {
  return new Set(documents.map((document) => document.path)).size;
}

export function expandQueryTokens(query) {
  const baseTokens = tokenize(query);
  const expanded = new Map(baseTokens);

  for (const token of baseTokens.keys()) {
    for (const variant of buildTokenVariants(token)) {
      expanded.set(variant, Math.max(expanded.get(variant) ?? 0, 1));
    }
  }

  return expanded;
}

function buildTokenVariants(token) {
  const variants = new Set([token]);

  if (token.endsWith("ing") && token.length > 5) {
    variants.add(token.slice(0, -3));
    variants.add(`${token.slice(0, -3)}e`);
  }

  if (token.endsWith("ed") && token.length > 4) {
    variants.add(token.slice(0, -2));
  }

  if (token.endsWith("es") && token.length > 4) {
    variants.add(token.slice(0, -2));
  }

  if (token.endsWith("s") && token.length > 3) {
    variants.add(token.slice(0, -1));
  }

  return variants;
}
