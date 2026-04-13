import fs from "node:fs/promises";
import path from "node:path";

export function getEmptyDefaults() {
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

export function mergeProfiles(baseProfiles = {}, overridingProfiles = {}) {
  return {
    ...baseProfiles,
    ...overridingProfiles,
  };
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

export function formatProfilesOutput(payload, outputFormat = "text") {
  if (outputFormat === "markdown") {
    return formatProfilesMarkdown(payload);
  }

  if (outputFormat === "html") {
    return formatProfilesHtml(payload);
  }

  return formatProfilesText(payload);
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
