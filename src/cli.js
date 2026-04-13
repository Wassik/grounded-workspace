#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  buildIndex,
  parseQuery,
  loadDocuments,
  scanWorkspace,
  getIndexFreshness,
  rankDocuments,
  saveIndex,
  expandQueryTokens,
  synthesizeAnswer,
} from "./indexer.js";
import {
  buildInvestigationSummary,
  deriveInvestigationConfidence,
  deriveInvestigationGaps,
  deriveInvestigationQueries,
  detectInvestigationIntent,
  formatInvestigateExportManifest,
  formatInvestigateOutput,
  mergeInvestigationHits,
  rankInvestigationFiles,
  resolveInvestigateOutputFormat,
  resolveInvestigateOutputPath,
  selectInvestigationEvidence,
  serializeInvestigatePayload,
  validateInvestigateOptions,
  writeInvestigateOutput,
} from "./investigate.js";
import {
  applyProfileDefaults,
  formatProfilesOutput,
  getEmptyDefaults,
  listProfiles,
  loadEnvDefaults,
  loadThemeConfig,
  loadUserDefaults,
  mergeProfiles,
  resolveCommandDefaults,
  resolveCommandDefaultSources,
  selectCommandDefaults,
} from "./profiles.js";
import {
  applyCliDefaultsToQuery,
  applyConfiguredThemeDefaults,
  applyOutputDefaultsToQuery,
  defaultsFromFormat,
  formatAskOutput,
  formatIndexOutput,
  formatJsonOutput,
  normalizePreviewDefaultFlag,
  resolveColorMode,
  resolveEffectiveAskOutputDefaults,
  resolveEffectiveAskOutputSources,
  resolveOutputFormat,
  resolveThemeAliasesInQuery,
} from "./rendering.js";
export {
  buildInvestigationSummary,
  deriveInvestigationConfidence,
  deriveInvestigationGaps,
  deriveInvestigationQueries,
  detectInvestigationIntent,
  formatInvestigateExportManifest,
  formatInvestigateOutput,
  mergeInvestigationHits,
  rankInvestigationFiles,
  resolveInvestigateOutputFormat,
  resolveInvestigateOutputPath,
  selectInvestigationEvidence,
  serializeInvestigatePayload,
  validateInvestigateOptions,
  writeInvestigateOutput,
} from "./investigate.js";

export {
  applyProfileDefaults,
  formatProfilesOutput,
  getEmptyDefaults,
  listProfiles,
  loadEnvDefaults,
  loadThemeConfig,
  loadUserDefaults,
  mergeProfiles,
  resolveCommandDefaults,
  resolveCommandDefaultSources,
  selectCommandDefaults,
} from "./profiles.js";
export {
  applyCliDefaultsToQuery,
  applyConfiguredThemeDefaults,
  applyOutputDefaultsToQuery,
  defaultsFromFormat,
  formatAskOutput,
  formatIndexOutput,
  formatJsonOutput,
  normalizePreviewDefaultFlag,
  resolveColorMode,
  resolveEffectiveAskOutputDefaults,
  resolveEffectiveAskOutputSources,
  resolveOutputFormat,
  resolveThemeAliasesInQuery,
} from "./rendering.js";

export async function main() {
  const [, , command, ...args] = process.argv;
  const workingDir = process.cwd();

  if (!command || command === "help" || command === "--help") {
    printHelp();
    process.exit(0);
  }

  if (command === "index" || command === "refresh") {
    const { positionalArgs, json, format, indexOptions } = parseCliOptions(args);
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
    const runIndex = async () => {
      const incremental = command === "refresh" ? true : indexOptions.incremental;
      const index = await buildIndex(targetDir, { incremental });
      const indexPath = await saveIndex(targetDir, index);
      return {
        root: targetDir,
        indexPath,
        generatedAt: index.generatedAt,
        filesIndexed: index.filesIndexed,
        chunksIndexed: index.chunksIndexed,
        incremental: index.incremental,
        command,
        indexedFiles: index.files,
        files: [...new Set(index.documents.map((document) => document.path))],
      };
    };

    const renderIndexPayload = (payload) => {
      if (outputFormat === "json") {
        return formatJsonOutput(payload, { pretty: !(command === "refresh" && indexOptions.watch) });
      }
      return formatIndexOutput(payload, outputFormat);
    };

    const initialPayload = await runIndex();
    process.stdout.write(renderIndexPayload(initialPayload));

    if (!(command === "refresh" && indexOptions.watch)) {
      return;
    }

    let latestPayload = initialPayload;
    let staleSince = null;
    let refreshInFlight = false;
    const intervalMs = Math.max(250, (indexOptions.watchIntervalSeconds ?? 2) * 1000);
    const debounceMs = Math.max(0, (indexOptions.watchDebounceSeconds ?? 1) * 1000);
    setInterval(async () => {
      if (refreshInFlight) {
        return;
      }
      try {
        const freshness = await getIndexFreshness(targetDir, {
          generatedAt: latestPayload.generatedAt,
          files: latestPayload.indexedFiles ?? null,
        });
        if (freshness.status !== "stale") {
          staleSince = null;
          return;
        }
        if (staleSince === null) {
          staleSince = Date.now();
          return;
        }
        if (Date.now() - staleSince < debounceMs) {
          return;
        }
        refreshInFlight = true;
        latestPayload = await runIndex();
        staleSince = null;
        process.stdout.write(`\n${renderIndexPayload(latestPayload)}`);
      } catch (error) {
        process.stderr.write(`refresh watch error: ${error.message}\n`);
      } finally {
        refreshInFlight = false;
      }
    }, intervalMs);
    return;
  }

  if (command === "profiles") {
    const { positionalArgs, json, format, previewDefaults } = parseCliOptions(args);
    const targetDir = path.resolve(positionalArgs[0] ?? workingDir);
    const userConfig = await loadUserDefaults();
    const envConfig = loadEnvDefaults();
    const themeConfig = await loadThemeConfig(targetDir);
    const availableProfiles = mergeProfiles(themeConfig.profiles, userConfig.profiles);
    const previewAskDefaults = previewDefaults.ask;
    const previewIndexDefaults = previewDefaults.index;
    const resolvedEnvAskDefaults = applyProfileDefaults(selectCommandDefaults(envConfig, "ask"), availableProfiles);
    const resolvedUserAskDefaults = applyProfileDefaults(selectCommandDefaults(userConfig, "ask"), availableProfiles);
    const activeAskDefaults = resolveCommandDefaults({
      command: "ask",
      userConfig,
      envConfig,
      cliDefaults: previewAskDefaults,
      availableProfiles,
    });
    const activeIndexDefaults = resolveCommandDefaults({
      command: "index",
      userConfig,
      envConfig,
      cliDefaults: previewIndexDefaults,
      availableProfiles,
    });
    const activeAskSources = resolveCommandDefaultSources({
      command: "ask",
      userConfig,
      envConfig,
      cliDefaults: previewAskDefaults,
      availableProfiles,
    });
    const activeIndexSources = resolveCommandDefaultSources({
      command: "index",
      userConfig,
      envConfig,
      cliDefaults: previewIndexDefaults,
      availableProfiles,
    });
    const payload = {
      root: targetDir,
      profiles: listProfiles({ userProfiles: userConfig.profiles, workspaceProfiles: themeConfig.profiles }),
      activeDefaults: {
        ask: activeAskDefaults,
        index: activeIndexDefaults,
      },
      activeDefaultSources: {
        ask: activeAskSources,
        index: activeIndexSources,
      },
      effectiveOutputDefaults: {
        text: resolveEffectiveAskOutputDefaults({
          commandDefaults: activeAskDefaults,
          themeConfig,
          outputFormat: "text",
          colorMode: resolveColorMode({
            cliDefaults: previewAskDefaults,
            envDefaults: resolvedEnvAskDefaults,
            userDefaults: resolvedUserAskDefaults,
            fallback: "NO_COLOR" in process.env ? "never" : "auto",
          }),
          isTTY: process.stdout.isTTY,
          term: process.env.TERM ?? "",
        }),
        json: resolveEffectiveAskOutputDefaults({
          commandDefaults: activeAskDefaults,
          themeConfig,
          outputFormat: "json",
          colorMode: resolveColorMode({
            cliDefaults: previewAskDefaults,
            envDefaults: resolvedEnvAskDefaults,
            userDefaults: resolvedUserAskDefaults,
            fallback: "NO_COLOR" in process.env ? "never" : "auto",
          }),
          isTTY: process.stdout.isTTY,
          term: process.env.TERM ?? "",
        }),
        markdown: resolveEffectiveAskOutputDefaults({
          commandDefaults: activeAskDefaults,
          themeConfig,
          outputFormat: "markdown",
          colorMode: resolveColorMode({
            cliDefaults: previewAskDefaults,
            envDefaults: resolvedEnvAskDefaults,
            userDefaults: resolvedUserAskDefaults,
            fallback: "NO_COLOR" in process.env ? "never" : "auto",
          }),
          isTTY: process.stdout.isTTY,
          term: process.env.TERM ?? "",
        }),
        html: resolveEffectiveAskOutputDefaults({
          commandDefaults: activeAskDefaults,
          themeConfig,
          outputFormat: "html",
          colorMode: resolveColorMode({
            cliDefaults: previewAskDefaults,
            envDefaults: resolvedEnvAskDefaults,
            userDefaults: resolvedUserAskDefaults,
            fallback: "NO_COLOR" in process.env ? "never" : "auto",
          }),
          isTTY: process.stdout.isTTY,
          term: process.env.TERM ?? "",
        }),
      },
      effectiveOutputSources: {
        text: resolveEffectiveAskOutputSources({
          commandDefaults: activeAskDefaults,
          commandSources: activeAskSources,
          themeConfig,
          outputFormat: "text",
          colorMode: resolveColorMode({
            cliDefaults: previewAskDefaults,
            envDefaults: resolvedEnvAskDefaults,
            userDefaults: resolvedUserAskDefaults,
            fallback: "NO_COLOR" in process.env ? "never" : "auto",
          }),
          isTTY: process.stdout.isTTY,
          term: process.env.TERM ?? "",
        }),
        json: resolveEffectiveAskOutputSources({
          commandDefaults: activeAskDefaults,
          commandSources: activeAskSources,
          themeConfig,
          outputFormat: "json",
          colorMode: resolveColorMode({
            cliDefaults: previewAskDefaults,
            envDefaults: resolvedEnvAskDefaults,
            userDefaults: resolvedUserAskDefaults,
            fallback: "NO_COLOR" in process.env ? "never" : "auto",
          }),
          isTTY: process.stdout.isTTY,
          term: process.env.TERM ?? "",
        }),
        markdown: resolveEffectiveAskOutputSources({
          commandDefaults: activeAskDefaults,
          commandSources: activeAskSources,
          themeConfig,
          outputFormat: "markdown",
          colorMode: resolveColorMode({
            cliDefaults: previewAskDefaults,
            envDefaults: resolvedEnvAskDefaults,
            userDefaults: resolvedUserAskDefaults,
            fallback: "NO_COLOR" in process.env ? "never" : "auto",
          }),
          isTTY: process.stdout.isTTY,
          term: process.env.TERM ?? "",
        }),
        html: resolveEffectiveAskOutputSources({
          commandDefaults: activeAskDefaults,
          commandSources: activeAskSources,
          themeConfig,
          outputFormat: "html",
          colorMode: resolveColorMode({
            cliDefaults: previewAskDefaults,
            envDefaults: resolvedEnvAskDefaults,
            userDefaults: resolvedUserAskDefaults,
            fallback: "NO_COLOR" in process.env ? "never" : "auto",
          }),
          isTTY: process.stdout.isTTY,
          term: process.env.TERM ?? "",
        }),
      },
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

  if (command === "investigate") {
    const { positionalArgs, json, format, investigateOptions } = parseCliOptions(args);
    const targetDir = path.resolve(positionalArgs[0] ?? workingDir);
    const question = positionalArgs.slice(1).join(" ").trim();
    validateInvestigateOptions(investigateOptions);
    const refresh = {
      requested: !investigateOptions.live && (investigateOptions.refreshIndex || investigateOptions.refreshIfStale),
      mode: investigateOptions.refreshIndex ? "always" : investigateOptions.refreshIfStale ? "if-stale" : "none",
      performed: false,
      indexMode: null,
      reason: null,
    };
    const sourceMode = investigateOptions.live ? "live-forced" : "auto";

    if (!question) {
      throw new Error("Question required. Usage: grounded-workspace investigate <dir> <question>");
    }

    if (investigateOptions.refreshIndex && !investigateOptions.live) {
      const refreshedIndex = await buildIndex(targetDir, { incremental: true });
      await saveIndex(targetDir, refreshedIndex);
      refresh.performed = true;
      refresh.indexMode = refreshedIndex.incremental?.enabled ? "incremental" : "full";
      refresh.reason = "forced by --refresh-index";
    }

    let documents;
    let source;
    let sourceReason;
    let indexPath;
    let indexedFiles;
    let generatedAt;

    if (investigateOptions.live) {
      documents = await scanWorkspace(targetDir);
      source = "scan";
      sourceReason = "forced live scan";
      indexPath = path.join(targetDir, ".grounded-workspace-index.json");
      indexedFiles = null;
      generatedAt = null;
    } else {
      ({ documents, source, sourceReason, indexPath, files: indexedFiles, generatedAt } = await loadDocuments(targetDir));
    }

    if (investigateOptions.refreshIfStale && !investigateOptions.live && source === "index") {
      const initialFreshness = await getIndexFreshness(targetDir, { generatedAt, files: indexedFiles });
      if (initialFreshness.status === "stale") {
        const refreshedIndex = await buildIndex(targetDir, { incremental: true });
        await saveIndex(targetDir, refreshedIndex);
        ({ documents, source, sourceReason, indexPath, files: indexedFiles, generatedAt } = await loadDocuments(targetDir));
        refresh.performed = true;
        refresh.indexMode = refreshedIndex.incremental?.enabled ? "incremental" : "full";
        refresh.reason = "saved index was stale";
      } else {
        refresh.reason = "saved index was already fresh";
      }
    } else if (investigateOptions.refreshIfStale && !investigateOptions.live && source !== "index") {
      refresh.reason = "using a live scan";
    }
    const themeConfig = await loadThemeConfig(targetDir);
    const queries = deriveInvestigationQueries(question);
    const intent = detectInvestigationIntent(question);
    const results = queries.map((query) => ({
      query,
      matches: rankDocuments(documents, query, 4, {
        ansiThemes: themeConfig.themes,
        wrapperThemes: themeConfig.wrappers,
      }),
    }));
    const mergedEvidence = mergeInvestigationHits(results);
    const keyFiles = rankInvestigationFiles(mergedEvidence, investigateOptions.maxFiles, intent);
    const evidence = selectInvestigationEvidence(mergedEvidence, keyFiles, investigateOptions.maxEvidence, intent);
    const summary = buildInvestigationSummary({ question, keyFiles, evidence });
    const freshness = source === "index" ? await getIndexFreshness(targetDir, { generatedAt, files: indexedFiles }) : { status: "live", reason: "using a live scan", latestFilePath: null, latestFileMtime: null };
    const initialConfidence = deriveInvestigationConfidence({ keyFiles, evidence, gaps: [] });
    const gaps = deriveInvestigationGaps({ queries, results, keyFiles, evidence, intent, confidence: initialConfidence, freshness, source, sourceReason, root: targetDir });
    const confidence = deriveInvestigationConfidence({ keyFiles, evidence, gaps });
    const payload = {
      root: targetDir,
      question,
      source,
      sourceReason,
      sourceMode: source === "index" ? "index" : sourceMode === "live-forced" ? "live-forced" : "scan",
      indexPath,
      generatedAt,
      freshness,
      refresh,
      intent,
      queries,
      summary,
      confidence,
      keyFiles,
      evidence,
      gaps,
    };

    const effectiveInvestigateFormat = resolveInvestigateOutputFormat({ json, format, outputFile: investigateOptions.outputFile });
    const jsonPayload = serializeInvestigatePayload(payload, investigateOptions);

    if (investigateOptions.metadataFile) {
      const metadataPath = await writeInvestigateOutput(investigateOptions.metadataFile, `${JSON.stringify(jsonPayload, null, 2)}\n`, "json");
      if (!investigateOptions.outputFile && effectiveInvestigateFormat !== "json") {
        payload.metadataPath = metadataPath;
      }
      investigateOptions.metadataPath = metadataPath;
    }

    if (effectiveInvestigateFormat === "json") {
      if (investigateOptions.outputFile) {
        const writtenPath = await writeInvestigateOutput(investigateOptions.outputFile, `${JSON.stringify(jsonPayload, null, 2)}\n`, effectiveInvestigateFormat);
        process.stdout.write(formatInvestigateExportManifest({
          reportPath: writtenPath,
          metadataPath: investigateOptions.metadataPath,
          asJson: investigateOptions.manifestJson,
        }));
        return;
      }
      writeOutput(jsonPayload, true);
      return;
    }

    const renderedOutput = formatInvestigateOutput(payload, effectiveInvestigateFormat);
    if (investigateOptions.outputFile) {
      const writtenPath = await writeInvestigateOutput(investigateOptions.outputFile, renderedOutput, effectiveInvestigateFormat);
      process.stdout.write(formatInvestigateExportManifest({
        reportPath: writtenPath,
        metadataPath: investigateOptions.metadataPath,
        asJson: investigateOptions.manifestJson,
      }));
      return;
    }
    process.stdout.write(renderedOutput);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function printHelp() {
  process.stdout.write(`grounded-workspace

Usage:
  grounded-workspace index [dir] [--json] [--incremental]
  grounded-workspace refresh [dir] [--json] [--watch] [--watch-interval <seconds>] [--watch-debounce <seconds>]
  grounded-workspace profiles [dir] [--json] [--format <mode>] [--ask-format <mode>] [--ask-highlight <mode>] [--ask-theme <mode>]
  grounded-workspace ask [dir] <question> [--json] [--profile <name>] [--format <mode>] [--color <mode>] [--explain <mode>] [--excerpt <mode>] [--highlight <mode>] [--theme <mode>]
  grounded-workspace investigate [dir] <question> [--json] [--max-files <count>] [--max-evidence <count>] [--include-raw] [--refresh-index] [--refresh-if-stale] [--live] [--output-file <path>] [--metadata-file <path>] [--manifest-json]

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
  --max-files <n>   cap investigate key files
  --max-evidence <n> cap investigate evidence blocks
  --incremental     reuse unchanged files from the saved index when rebuilding
  --watch           keep refreshing incrementally when the saved index becomes stale
  --watch-interval <seconds> poll interval for refresh watch mode
  --watch-debounce <seconds> require staleness to persist before a watched refresh runs
  --include-raw     include raw and highlighted excerpts in investigate json output
  --refresh-index   rebuild the saved index before investigate runs
  --refresh-if-stale rebuild the saved index only when the current saved index is stale
  --live            bypass the saved index and run investigate from a live scan only
  --output-file <path> write the investigate report to a file instead of stdout
  --metadata-file <path> write investigate metadata json to a companion file
  --manifest-json   emit export paths as json when writing investigate files
  --ask-* / --index-* preview hypothetical defaults in the profiles command without changing config

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
  const previewDefaults = {
    ask: getEmptyDefaults(),
    index: getEmptyDefaults(),
  };
  const indexOptions = {
    incremental: false,
    watch: false,
    watchIntervalSeconds: 2,
    watchDebounceSeconds: 1,
  };
  const investigateOptions = {
    maxFiles: 3,
    maxEvidence: 4,
    includeRaw: false,
    refreshIndex: false,
    refreshIfStale: false,
    live: false,
    outputFile: null,
    metadataFile: null,
    manifestJson: false,
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

    if (arg === "--max-files") {
      investigateOptions.maxFiles = normalizeLimitedPositiveInteger(args[index + 1]) ?? investigateOptions.maxFiles;
      index += 1;
      continue;
    }

    if (arg === "--incremental") {
      indexOptions.incremental = true;
      continue;
    }

    if (arg === "--watch") {
      indexOptions.watch = true;
      continue;
    }

    if (arg === "--watch-interval") {
      indexOptions.watchIntervalSeconds = normalizePositiveInteger(args[index + 1]) ?? indexOptions.watchIntervalSeconds;
      index += 1;
      continue;
    }

    if (arg === "--watch-debounce") {
      indexOptions.watchDebounceSeconds = normalizePositiveInteger(args[index + 1]) ?? indexOptions.watchDebounceSeconds;
      index += 1;
      continue;
    }

    if (arg === "--max-evidence") {
      investigateOptions.maxEvidence = normalizeLimitedPositiveInteger(args[index + 1]) ?? investigateOptions.maxEvidence;
      index += 1;
      continue;
    }

    if (arg === "--include-raw") {
      investigateOptions.includeRaw = true;
      continue;
    }

    if (arg === "--refresh-index") {
      investigateOptions.refreshIndex = true;
      continue;
    }

    if (arg === "--refresh-if-stale") {
      investigateOptions.refreshIfStale = true;
      continue;
    }

    if (arg === "--live") {
      investigateOptions.live = true;
      continue;
    }

    if (arg === "--output-file") {
      investigateOptions.outputFile = args[index + 1]?.trim() || null;
      index += 1;
      continue;
    }

    if (arg === "--metadata-file") {
      investigateOptions.metadataFile = args[index + 1]?.trim() || null;
      index += 1;
      continue;
    }

    if (arg === "--manifest-json") {
      investigateOptions.manifestJson = true;
      continue;
    }

    if (applyPreviewDefaultFlag(previewDefaults, arg, args[index + 1])) {
      index += 1;
      continue;
    }

    positionalArgs.push(arg);
  }

  return { positionalArgs, json: format === "json", format, defaults, previewDefaults, indexOptions, investigateOptions };
}

function applyPreviewDefaultFlag(previewDefaults, flag, value) {
  return (
    applyCommandDefaultFlag(previewDefaults.ask, "ask", flag, value) ||
    applyCommandDefaultFlag(previewDefaults.index, "index", flag, value)
  );
}

function applyCommandDefaultFlag(defaults, command, flag, value) {
  if (flag === `--${command}-profile`) {
    defaults.profile = normalizeProfileName(value);
    return true;
  }

  return normalizePreviewDefaultFlag(defaults, command, flag, value);
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

function normalizePositiveInteger(value) {
  const parsed = Number.parseInt(value?.trim() ?? "", 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return null;
  }

  return parsed;
}

function normalizeLimitedPositiveInteger(value, max = 20) {
  const parsed = normalizePositiveInteger(value);
  if (parsed === null) {
    return null;
  }

  return Math.min(parsed, max);
}

function writeOutput(payload, json) {
  if (json) {
    process.stdout.write(formatJsonOutput(payload));
    return;
  }

  process.stdout.write(formatJsonOutput(payload));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
