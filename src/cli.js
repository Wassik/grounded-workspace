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

function resolveInvestigateOutputFormat({ json = false, format = null, outputFile = null } = {}) {
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
    defaults.theme = normalizeThemeMode(value);
    return true;
  }

  return false;
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

export function formatProfilesOutput(payload, outputFormat = "text") {
  if (outputFormat === "markdown") {
    return formatProfilesMarkdown(payload);
  }

  if (outputFormat === "html") {
    return formatProfilesHtml(payload);
  }

  return formatProfilesText(payload);
}

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

function deriveInvestigationConfidence({ keyFiles = [], evidence = [], gaps = [] } = {}) {
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

function buildInvestigationSummary({ question, keyFiles, evidence = [] }) {
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

function formatProfilesText(payload) {
  const { root, profiles, activeDefaults, activeDefaultSources, effectiveOutputDefaults, effectiveOutputSources } = payload;
  let output = `Available profiles for ${root}\n\n`;
  output += `Active defaults:\n`;
  output += `  ask: ${formatAttributedDefaultsLine(activeDefaults.ask, activeDefaultSources.ask)}\n`;
  output += `  index: ${formatAttributedDefaultsLine(activeDefaults.index, activeDefaultSources.index)}\n\n`;
  output += `Effective ask defaults by output:\n`;
  output += `  text: ${formatAttributedDefaultsLine(effectiveOutputDefaults.text, effectiveOutputSources.text, ["color", "excerpt", "highlight", "theme"])}\n`;
  output += `  json: ${formatAttributedDefaultsLine(effectiveOutputDefaults.json, effectiveOutputSources.json, ["color", "excerpt", "highlight", "theme"])}\n`;
  output += `  markdown: ${formatAttributedDefaultsLine(effectiveOutputDefaults.markdown, effectiveOutputSources.markdown, ["color", "excerpt", "highlight", "theme"])}\n`;
  output += `  html: ${formatAttributedDefaultsLine(effectiveOutputDefaults.html, effectiveOutputSources.html, ["color", "excerpt", "highlight", "theme"])}\n\n`;

  for (const profile of profiles) {
    const extendsLabel = profile.extends ? ` extends ${profile.extends}` : "";
    output += `- ${profile.name} [${profile.source}]${extendsLabel}\n`;
    output += `  format=${profile.resolved.format ?? "-"} color=${profile.resolved.color ?? "-"} explain=${profile.resolved.explain ?? "-"} excerpt=${profile.resolved.excerpt ?? "-"} highlight=${profile.resolved.highlight ?? "-"} theme=${profile.resolved.theme ?? "-"}\n`;
  }

  return output;
}

function formatProfilesMarkdown(payload) {
  const { root, profiles, activeDefaults, activeDefaultSources, effectiveOutputDefaults, effectiveOutputSources } = payload;
  let output = `# grounded-workspace profiles\n\n`;
  output += `Root: \`${root}\`\n\n`;
  output += `## Active defaults\n\n`;
  output += `- ask: ${formatAttributedDefaultsLine(activeDefaults.ask, activeDefaultSources.ask)}\n`;
  output += `- index: ${formatAttributedDefaultsLine(activeDefaults.index, activeDefaultSources.index)}\n\n`;
  output += `## Effective ask defaults by output\n\n`;
  output += `- text: ${formatAttributedDefaultsLine(effectiveOutputDefaults.text, effectiveOutputSources.text, ["color", "excerpt", "highlight", "theme"])}\n`;
  output += `- json: ${formatAttributedDefaultsLine(effectiveOutputDefaults.json, effectiveOutputSources.json, ["color", "excerpt", "highlight", "theme"])}\n`;
  output += `- markdown: ${formatAttributedDefaultsLine(effectiveOutputDefaults.markdown, effectiveOutputSources.markdown, ["color", "excerpt", "highlight", "theme"])}\n`;
  output += `- html: ${formatAttributedDefaultsLine(effectiveOutputDefaults.html, effectiveOutputSources.html, ["color", "excerpt", "highlight", "theme"])}\n\n`;

  for (const profile of profiles) {
    const extendsLabel = profile.extends ? ` extends \`${profile.extends}\`` : "";
    output += `## \`${profile.name}\`\n\n`;
    output += `Source: ${profile.source}${extendsLabel}\n\n`;
    output += `Resolved: format=${profile.resolved.format ?? "-"} color=${profile.resolved.color ?? "-"} explain=${profile.resolved.explain ?? "-"} excerpt=${profile.resolved.excerpt ?? "-"} highlight=${profile.resolved.highlight ?? "-"} theme=${profile.resolved.theme ?? "-"}\n\n`;
  }

  return output;
}

function formatProfilesHtml(payload) {
  const { root, profiles, activeDefaults, activeDefaultSources, effectiveOutputDefaults, effectiveOutputSources } = payload;
  let output = "<!doctype html>\n";
  output += "<html><head><meta charset=\"utf-8\"><title>grounded-workspace profiles</title></head><body>\n";
  output += "<h1>grounded-workspace profiles</h1>\n";
  output += `<p>Root: <code>${escapeHtml(root)}</code></p>\n`;
  output += "<h2>Active defaults</h2>\n";
  output += `<p>ask: ${escapeHtml(formatAttributedDefaultsLine(activeDefaults.ask, activeDefaultSources.ask))}</p>\n`;
  output += `<p>index: ${escapeHtml(formatAttributedDefaultsLine(activeDefaults.index, activeDefaultSources.index))}</p>\n`;
  output += "<h2>Effective ask defaults by output</h2>\n";
  output += `<p>text: ${escapeHtml(formatAttributedDefaultsLine(effectiveOutputDefaults.text, effectiveOutputSources.text, ["color", "excerpt", "highlight", "theme"]))}</p>\n`;
  output += `<p>json: ${escapeHtml(formatAttributedDefaultsLine(effectiveOutputDefaults.json, effectiveOutputSources.json, ["color", "excerpt", "highlight", "theme"]))}</p>\n`;
  output += `<p>markdown: ${escapeHtml(formatAttributedDefaultsLine(effectiveOutputDefaults.markdown, effectiveOutputSources.markdown, ["color", "excerpt", "highlight", "theme"]))}</p>\n`;
  output += `<p>html: ${escapeHtml(formatAttributedDefaultsLine(effectiveOutputDefaults.html, effectiveOutputSources.html, ["color", "excerpt", "highlight", "theme"]))}</p>\n`;

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

function formatAttributedDefaultsLine(values = {}, sources = {}, fields = ["profile", "format", "color", "explain", "excerpt", "highlight", "theme"]) {
  return fields
    .map((field) => `${field}=${values[field] ?? "-"} [${sources[field] ?? "unset"}]`)
    .join(" ");
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

export function resolveCommandDefaults({
  command,
  userConfig = getEmptyDefaultsConfig(),
  envConfig = getEmptyDefaultsConfig(),
  cliDefaults = getEmptyDefaults(),
  availableProfiles = {},
} = {}) {
  const userDefaults = applyProfileDefaults(selectCommandDefaults(userConfig, command), availableProfiles);
  const envDefaults = applyProfileDefaults(selectCommandDefaults(envConfig, command), availableProfiles);
  const resolvedCliDefaults = applyProfileDefaults(cliDefaults, availableProfiles);

  return {
    profile: resolvedCliDefaults.profile ?? envDefaults.profile ?? userDefaults.profile ?? null,
    extends: resolvedCliDefaults.extends ?? envDefaults.extends ?? userDefaults.extends ?? null,
    format: resolvedCliDefaults.format ?? envDefaults.format ?? userDefaults.format ?? null,
    color: resolvedCliDefaults.color ?? envDefaults.color ?? userDefaults.color ?? null,
    explain: resolvedCliDefaults.explain ?? envDefaults.explain ?? userDefaults.explain ?? null,
    excerpt: resolvedCliDefaults.excerpt ?? envDefaults.excerpt ?? userDefaults.excerpt ?? null,
    highlight: resolvedCliDefaults.highlight ?? envDefaults.highlight ?? userDefaults.highlight ?? null,
    theme: resolvedCliDefaults.theme ?? envDefaults.theme ?? userDefaults.theme ?? null,
  };
}

export function resolveCommandDefaultSources({
  command,
  userConfig = getEmptyDefaultsConfig(),
  envConfig = getEmptyDefaultsConfig(),
  cliDefaults = getEmptyDefaults(),
  availableProfiles = {},
} = {}) {
  const userSelected = selectCommandDefaults(userConfig, command);
  const envSelected = selectCommandDefaults(envConfig, command);
  const resolvedUserDefaults = applyProfileDefaults(userSelected, availableProfiles);
  const resolvedEnvDefaults = applyProfileDefaults(envSelected, availableProfiles);
  const resolvedCliDefaults = applyProfileDefaults(cliDefaults, availableProfiles);
  const sources = {};

  for (const field of ["profile", "extends", "format", "color", "explain", "excerpt", "highlight", "theme"]) {
    if (cliDefaults[field] !== null) {
      sources[field] = field === "profile" ? "cli" : resolvedCliDefaults[field] !== cliDefaults[field] ? "cli+profile" : "cli";
      continue;
    }

    if (cliDefaults.profile !== null && field !== "profile" && resolvedCliDefaults[field] !== null) {
      sources[field] = "cli+profile";
      continue;
    }

    if (envSelected[field] !== null) {
      sources[field] = field === "profile" ? "env" : resolvedEnvDefaults[field] !== envSelected[field] ? "env+profile" : "env";
      continue;
    }

    if (envSelected.profile !== null && field !== "profile" && resolvedEnvDefaults[field] !== null) {
      sources[field] = "env+profile";
      continue;
    }

    if (userSelected[field] !== null) {
      sources[field] = field === "profile" ? "user" : resolvedUserDefaults[field] !== userSelected[field] ? "user+profile" : "user";
      continue;
    }

    if (userSelected.profile !== null && field !== "profile" && resolvedUserDefaults[field] !== null) {
      sources[field] = "user+profile";
      continue;
    }

    sources[field] = "unset";
  }

  return sources;
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
    process.stdout.write(formatJsonOutput(payload));
    return;
  }

  process.stdout.write(formatJsonOutput(payload));
}

async function writeInvestigateOutput(outputFile, content, format = "text") {
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

function formatInvestigateExportManifest({ reportPath = null, metadataPath = null, asJson = false } = {}) {
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
