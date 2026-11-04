#!/usr/bin/env node
/**
 * init-architecture.mjs — reusable Next.js Clean Architecture generator.
 *
 *   node init-architecture.mjs                    Initialize the architecture in the current Next.js project
 *   node init-architecture.mjs my-app --create    Create a new Next.js project, then initialize it
 *   node init-architecture.mjs --feature orders   Generate a feature module (repeatable / comma separated)
 *
 * Zero dependencies. Requires Node.js >= 18.17. Run with --help for every option.
 *
 * Safety guarantees:
 *   - Existing files are never overwritten. Missing files are created, existing ones are skipped.
 *   - The few existing files that must change (tsconfig.json, package.json scripts, root layout,
 *     ESLint config, .gitignore, globals.css, AI rule files) are backed up to
 *     .architecture-backup/<timestamp>/ first and every change is reported.
 *   - Existing dependencies are never reinstalled, upgraded or downgraded.
 *   - Re-running any command is safe (idempotent).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

const GENERATOR_VERSION = "1.0.0";
const MANAGED_START = "<!-- architecture:start -->";
const MANAGED_END = "<!-- architecture:end -->";
const BACKUP_DIR_NAME = ".architecture-backup";
const DEFAULT_INIT_FEATURES = ["auth", "dashboard"];
const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"];
const RESERVED_FEATURE_NAMES = new Set([
  "api", "app", "client", "config", "constructor", "features", "index", "infrastructure",
  "lib", "node-modules", "prototype", "proto", "server", "shared", "store", "styles", "test",
]);

/** Runtime libraries. `spec` pins the major version the generated code is written against. */
const RUNTIME_DEPENDENCIES = [
  { name: "@reduxjs/toolkit", spec: "@reduxjs/toolkit@2", minMajor: 2 },
  { name: "react-redux", spec: "react-redux@9", minMajor: 9 },
  { name: "zod", spec: "zod@4", minMajor: 3 },
  { name: "react-hook-form", spec: "react-hook-form@7", minMajor: 7 },
  { name: "@hookform/resolvers", spec: "@hookform/resolvers" },
  { name: "server-only", spec: "server-only" },
];
const DEV_DEPENDENCIES = [
  { name: "vitest", spec: "vitest" },
  // Pinned to the Vite line Vitest itself uses, so the React plugin and Vitest share one Vite.
  { name: "vite", spec: "vite", rangeFrom: "vitest" },
  { name: "@vitejs/plugin-react", spec: "@vitejs/plugin-react" },
  { name: "jsdom", spec: "jsdom" },
  { name: "@testing-library/react", spec: "@testing-library/react" },
  { name: "@testing-library/dom", spec: "@testing-library/dom" },
  { name: "@testing-library/jest-dom", spec: "@testing-library/jest-dom" },
  { name: "@testing-library/user-event", spec: "@testing-library/user-event" },
  { name: "prettier", spec: "prettier" },
  { name: "eslint-config-prettier", spec: "eslint-config-prettier" },
];
const TAILWIND_DEPENDENCIES = [
  { name: "tailwindcss", spec: "tailwindcss@4" },
  { name: "@tailwindcss/postcss", spec: "@tailwindcss/postcss@4" },
  { name: "postcss", spec: "postcss" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Console helpers
// ─────────────────────────────────────────────────────────────────────────────

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : String(text));
const color = { bold: paint(1), dim: paint(2), red: paint(31), green: paint(32), yellow: paint(33), cyan: paint(36) };
const log = {
  step: (message) => console.log(`\n${color.bold(color.cyan("■"))} ${color.bold(message)}`),
  info: (message) => console.log(`  ${color.dim("·")} ${message}`),
  ok: (message) => console.log(`  ${color.green("✓")} ${message}`),
  warn: (message) => console.log(`  ${color.yellow("!")} ${message}`),
};

class CliError extends Error {}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const HELP = `
${color.bold("init-architecture")} v${GENERATOR_VERSION} — Next.js Clean Architecture generator

${color.bold("Usage")}
  node init-architecture.mjs                       Initialize the current Next.js project
  node init-architecture.mjs <name> --create       Create a new Next.js project and initialize it
  node init-architecture.mjs --feature <name>      Generate a feature (repeat or comma-separate)

${color.bold("Options")}
  --create              Create a new project with create-next-app first
  --feature <name>      Feature to generate, e.g. --feature orders --feature user-profile
  --entity <name>       Entity name for a single generated feature (default: singular of feature)
  --layered             Add domain/application/infrastructure/presentation layers to the feature
  --features <list>     Features generated during init (default: ${DEFAULT_INIT_FEATURES.join(",")}; "none" to skip)
  --pm <npm|pnpm|yarn|bun>  Force a package manager (default: auto-detect)
  --cwd <dir>           Project directory (default: current directory)
  --strict              Turn on TypeScript strict mode in an existing project if it is off
  --skip-install        Do not install dependencies
  --dry-run             Show what would change without writing anything
  -h, --help            Show this help
  -v, --version         Show the generator version
`;

function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        create: { type: "boolean", default: false },
        feature: { type: "string", multiple: true },
        entity: { type: "string" },
        layered: { type: "boolean", default: false },
        features: { type: "string" },
        pm: { type: "string" },
        cwd: { type: "string" },
        strict: { type: "boolean", default: false },
        "skip-install": { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (error) {
    throw new CliError(`${error.message}\nRun with --help for usage.`);
  }
  const { values, positionals } = parsed;
  const splitList = (list) =>
    (list ?? []).flatMap((item) => item.split(",")).map((item) => item.trim()).filter(Boolean);

  const features = splitList(values.feature);
  if (values.feature !== undefined && features.length === 0) {
    throw new CliError("--feature needs a name, e.g. --feature orders");
  }
  if (values.entity && features.length !== 1) {
    throw new CliError("--entity can only be used together with exactly one --feature.");
  }
  if (values.pm && !PACKAGE_MANAGERS.includes(values.pm)) {
    throw new CliError(`Unknown package manager "${values.pm}". Use one of: ${PACKAGE_MANAGERS.join(", ")}.`);
  }
  if (!values.create && positionals.length > 0) {
    throw new CliError(`Unexpected argument "${positionals[0]}". Did you mean: node init-architecture.mjs ${positionals[0]} --create ?`);
  }
  if (values.create && positionals.length !== 1) {
    throw new CliError("--create needs exactly one project name, e.g. node init-architecture.mjs my-app --create");
  }

  let initFeatures = DEFAULT_INIT_FEATURES;
  if (values.features !== undefined) {
    initFeatures = values.features.trim() === "none" ? [] : splitList([values.features]);
  }

  return {
    help: values.help,
    version: values.version,
    create: values.create,
    projectName: positionals[0],
    features,
    entity: values.entity,
    layered: values.layered,
    initFeatures,
    pm: values.pm,
    cwd: path.resolve(values.cwd ?? process.cwd()),
    strict: values.strict,
    skipInstall: values["skip-install"],
    dryRun: values["dry-run"],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// File system helpers (every write goes through these)
// ─────────────────────────────────────────────────────────────────────────────

const toPosix = (value) => value.split(path.sep).join("/");

function createContext(root, options) {
  return {
    root,
    options,
    dryRun: options.dryRun,
    baseDir: "src",
    appDir: "src/app",
    pm: "npm",
    pkg: null,
    isNewProject: false,
    skipProviderIntegration: false,
    formatAlso: [],
    backupStamp: new Date().toISOString().replace(/[:.]/g, "-"),
    report: { created: [], modified: [], skipped: [], warnings: [], manual: [] },
  };
}

/** Resolve a project-relative path and refuse anything that escapes the project root. */
function resolveInside(ctx, rel) {
  const absolute = path.resolve(ctx.root, rel);
  const relative = path.relative(ctx.root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new CliError(`Refusing to touch a path outside the project: ${rel}`);
  }
  return absolute;
}

/** Path inside the source base directory ("src" or "." for projects without src/). */
const inSrc = (ctx, ...parts) => path.posix.join(ctx.baseDir, ...parts);
const fileExists = (ctx, rel) => fs.existsSync(resolveInside(ctx, rel));
const readFile = (ctx, rel) => fs.readFileSync(resolveInside(ctx, rel), "utf8");

function warn(ctx, message) {
  ctx.report.warnings.push(message);
  log.warn(message);
}

function manual(ctx, message) {
  ctx.report.manual.push(message);
}

/** Create a file only if it does not exist yet. Never overwrites. */
function writeNew(ctx, rel, content) {
  const target = resolveInside(ctx, rel);
  if (fs.existsSync(target)) {
    ctx.report.skipped.push(toPosix(rel));
    return false;
  }
  const body = content === "" || content.endsWith("\n") ? content : `${content}\n`;
  if (!ctx.dryRun) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body, { flag: "wx" });
  }
  ctx.report.created.push(toPosix(rel));
  return true;
}

/** Modify an existing file after backing it up. No-op when content is unchanged. */
function modifyFile(ctx, rel, nextContent, reason) {
  const target = resolveInside(ctx, rel);
  const current = fs.readFileSync(target, "utf8");
  if (current === nextContent) return false;
  if (!ctx.dryRun) {
    backupFile(ctx, rel);
    fs.writeFileSync(target, nextContent);
  }
  ctx.report.modified.push(`${toPosix(rel)} — ${reason}`);
  return true;
}

function backupFile(ctx, rel) {
  const destination = path.join(ctx.root, BACKUP_DIR_NAME, ctx.backupStamp, rel);
  if (fs.existsSync(destination)) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(resolveInside(ctx, rel), destination);
}

/** Ensure a directory exists. Adds .gitkeep only when the directory would otherwise be empty. */
function ensureDir(ctx, rel) {
  const target = resolveInside(ctx, rel);
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) return;
  writeNew(ctx, path.posix.join(rel, ".gitkeep"), "");
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Parse JSON with comments and trailing commas (tsconfig style). */
function parseJsonc(text) {
  let output = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (inString) {
      output += char;
      if (char === "\\") {
        output += next ?? "";
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
      output += char;
    } else if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      output += "\n";
    } else if (char === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
    } else {
      output += char;
    }
  }
  return JSON.parse(output.replace(/,(\s*[}\]])/g, "$1"));
}

function detectIndent(text) {
  const match = text.match(/^[ \t]+(?=")/m);
  return match ? match[0] : "  ";
}

const isWindows = process.platform === "win32";

/** On Windows, commands run through cmd.exe (for npm.cmd etc.); quote arguments with special characters. */
function shellSafe(args) {
  return isWindows ? args.map((arg) => (/[\s^|<>&()*]/.test(arg) ? `"${arg}"` : arg)) : args;
}

function run(command, args, cwd) {
  log.info(color.dim(`$ ${command} ${args.join(" ")}`));
  const result = spawnSync(command, shellSafe(args), { cwd, stdio: "inherit", shell: isWindows });
  if (result.error) throw new CliError(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) throw new CliError(`Command failed (exit ${result.status}): ${command} ${args.join(" ")}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Project detection
// ─────────────────────────────────────────────────────────────────────────────

function loadPackageJson(ctx) {
  const file = path.join(ctx.root, "package.json");
  if (!fs.existsSync(file)) {
    throw new CliError(`No package.json in ${ctx.root}. Run inside a Next.js project, or use: node init-architecture.mjs my-app --create`);
  }
  ctx.pkg = readJsonFile(file);
  return ctx.pkg;
}

const allDependencies = (pkg) => ({ ...pkg.dependencies, ...pkg.devDependencies });

function detectPackageManager(root, override) {
  if (override) return override;
  const lockfiles = [
    ["pnpm-lock.yaml", "pnpm"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ];
  // Walk up a few levels so workspaces/monorepos use the root lockfile's package manager.
  let dir = root;
  for (let depth = 0; depth < 4; depth += 1) {
    for (const [file, pm] of lockfiles) {
      if (fs.existsSync(path.join(dir, file))) return pm;
    }
    const pkgFile = path.join(dir, "package.json");
    if (fs.existsSync(pkgFile)) {
      const field = readJsonFile(pkgFile).packageManager;
      const fromField = typeof field === "string" ? field.split("@")[0] : null;
      if (PACKAGE_MANAGERS.includes(fromField)) return fromField;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const agent = process.env.npm_config_user_agent ?? "";
  return PACKAGE_MANAGERS.find((pm) => agent.startsWith(`${pm}/`)) ?? "npm";
}

/** Installed major version (node_modules first, then the declared range). */
function installedMajor(ctx, name) {
  const installed = path.join(ctx.root, "node_modules", name, "package.json");
  const version = fs.existsSync(installed)
    ? readJsonFile(installed).version
    : allDependencies(ctx.pkg)[name];
  const match = String(version ?? "").match(/(\d+)(?:\.\d+)*/);
  return match ? Number(match[1]) : null;
}

function detectProject(ctx) {
  log.step("Analyzing project");
  const pkg = loadPackageJson(ctx);
  const deps = allDependencies(pkg);

  if (!deps.next) {
    throw new CliError("This is not a Next.js project (no \"next\" dependency). Use --create to start a new one.");
  }
  if (!fs.existsSync(path.join(ctx.root, "tsconfig.json"))) {
    throw new CliError("No tsconfig.json found. The architecture is TypeScript-only — add TypeScript first (create any .ts file and run next dev), then re-run.");
  }

  ctx.pm = detectPackageManager(ctx.root, ctx.options.pm);

  if (fs.existsSync(path.join(ctx.root, "src", "app"))) ctx.baseDir = "src";
  else if (fs.existsSync(path.join(ctx.root, "app"))) ctx.baseDir = ".";
  else ctx.baseDir = "src";
  ctx.appDir = inSrc(ctx, "app");

  const nextMajor = installedMajor(ctx, "next");
  log.ok(`Next.js ${nextMajor ?? "?"} · package manager: ${ctx.pm} · source dir: ${ctx.baseDir === "." ? "(project root)" : ctx.baseDir}/`);
  if (nextMajor !== null && nextMajor < 14) {
    warn(ctx, `Next.js ${nextMajor} detected. The generated code targets the App Router on Next.js 14+.`);
  }
  if (!fs.existsSync(resolveInside(ctx, ctx.appDir))) {
    const hasPages = ["pages", "src/pages"].some((dir) => fs.existsSync(path.join(ctx.root, dir)));
    if (hasPages) warn(ctx, `Pages Router detected. An App Router directory will be added at ${ctx.appDir}/ alongside it.`);
  }

  validateTsconfigAlias(ctx);
  detectGitState(ctx);
  detectForeignStore(ctx);
}

function validateTsconfigAlias(ctx) {
  let tsconfig;
  try {
    tsconfig = parseJsonc(readFile(ctx, "tsconfig.json"));
  } catch {
    warn(ctx, "tsconfig.json could not be parsed; alias and strict-mode checks skipped.");
    return;
  }
  const expected = ctx.baseDir === "." ? "./*" : `./${ctx.baseDir}/*`;
  const current = tsconfig.compilerOptions?.paths?.["@/*"];
  if (current && !current.map((entry) => entry.replace(/^\.?\/?/, "./")).includes(expected)) {
    throw new CliError(`tsconfig.json maps "@/*" to ${JSON.stringify(current)}, but the generated code needs "${expected}". Align the alias first, then re-run.`);
  }
}

function detectGitState(ctx) {
  const result = spawnSync("git", ["status", "--porcelain"], { cwd: ctx.root, encoding: "utf8" });
  if (result.status !== 0) {
    warn(ctx, "Not a git repository — modified files are still backed up to .architecture-backup/.");
  } else if (result.stdout.trim()) {
    warn(ctx, "Uncommitted changes detected. Consider committing first so the generator's changes are easy to review.");
  }
}

/** Detect a Redux store the user already has, so we never mount a second Provider. */
function detectForeignStore(ctx) {
  const ours = path.join(ctx.root, inSrc(ctx, "store", "store.ts"));
  const ignore = new Set(["node_modules", ".next", ".git", BACKUP_DIR_NAME, "dist", "build", "out", "coverage"]);
  const scanRoot = path.join(ctx.root, ctx.baseDir);
  if (!fs.existsSync(scanRoot)) return;
  const stack = [scanRoot];
  let scanned = 0;
  while (stack.length > 0 && scanned < 5000) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ignore.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name) && full !== ours) {
        scanned += 1;
        const text = fs.readFileSync(full, "utf8");
        if (/\b(configureStore|legacy_createStore|createStore)\s*\(/.test(text)) {
          ctx.skipProviderIntegration = true;
          const rel = toPosix(path.relative(ctx.root, full));
          warn(ctx, `Existing Redux store found in ${rel}. The new store is generated but NOT mounted, to avoid two stores.`);
          manual(ctx, `Merge your store in ${rel} into ${inSrc(ctx, "store/store.ts")} (add your reducers to rootReducer), then wrap the root layout with <Providers>.`);
          return;
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

function installArgs(pm, specs, dev) {
  const devFlag = { npm: "--save-dev", pnpm: "-D", yarn: "-D", bun: "-d" }[pm];
  const verb = pm === "npm" ? "install" : "add";
  return [pm, [verb, ...(dev ? [devFlag] : []), ...specs]];
}

// Minimal semver (enough for npm peer ranges: ^ ~ >= <= > < = x * || and hyphen ranges).
function parseVersion(version) {
  const match = String(version).trim().replace(/^[=v]+/, "").match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(-[0-9A-Za-z.-]+)?/);
  return match ? { parts: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)], prerelease: Boolean(match[4]) } : null;
}

function compareParts(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function satisfiesComparator(parts, comparator) {
  const match = comparator.match(/^(\^|~|>=|<=|>|<|=)?\s*v?([\dxX*]+)(?:\.([\dxX*]+))?(?:\.([\dxX*]+))?/);
  if (!match) return comparator === "" || comparator === "*" || comparator === "latest";
  const [, op = "", ...raw] = match;
  const wildcard = (value) => value === undefined || /^[xX*]$/.test(value);
  const known = raw.findIndex(wildcard);
  const precision = known === -1 ? 3 : known; // number of concrete parts
  const base = raw.map((value) => (wildcard(value) ? 0 : Number(value)));
  if (precision === 0) return true;
  const upperForPrecision = () => {
    const upper = [...base];
    upper[precision - 1] += 1;
    for (let i = precision; i < 3; i += 1) upper[i] = 0;
    return upper;
  };
  const cmp = compareParts(parts, base);
  switch (op) {
    case "^": {
      const index = base[0] > 0 || precision === 1 ? 0 : base[1] > 0 || precision === 2 ? 1 : 2;
      const upper = [0, 0, 0];
      for (let i = 0; i < index; i += 1) upper[i] = base[i];
      upper[index] = base[index] + 1;
      return cmp >= 0 && compareParts(parts, upper) < 0;
    }
    case "~": {
      const upper = precision === 1 ? [base[0] + 1, 0, 0] : [base[0], base[1] + 1, 0];
      return cmp >= 0 && compareParts(parts, upper) < 0;
    }
    case ">=": return cmp >= 0;
    case ">": return precision < 3 ? compareParts(parts, upperForPrecision()) >= 0 : cmp > 0;
    case "<=": return precision < 3 ? compareParts(parts, upperForPrecision()) < 0 : cmp <= 0;
    case "<": return cmp < 0;
    default: return precision < 3 ? cmp >= 0 && compareParts(parts, upperForPrecision()) < 0 : cmp === 0;
  }
}

function satisfies(version, range) {
  const parsed = parseVersion(version);
  if (!parsed) return true; // unknown formats (workspace:, git, tags) are not ours to judge
  return String(range).split("||").some((set) => {
    const hyphen = set.trim().match(/^(\S+)\s+-\s+(\S+)$/);
    const comparators = hyphen ? [`>=${hyphen[1]}`, `<=${hyphen[2]}`] : set.trim().replace(/(\^|~|>=|<=|>|<|=)\s+/g, "$1").split(/\s+/);
    return comparators.every((comparator) => satisfiesComparator(parsed.parts, comparator));
  });
}

function installedVersion(ctx, name) {
  const file = path.join(ctx.root, "node_modules", name, "package.json");
  return fs.existsSync(file) ? readJsonFile(file).version : null;
}

/**
 * Picks the newest stable version of `spec` whose peer dependencies accept the versions already
 * installed in the project (e.g. avoids a test runner that rejects the project's @types/node).
 */
const npmViewCache = new Map();

function npmView(ctx, spec, field) {
  const key = `${spec} ${field}`;
  if (!npmViewCache.has(key)) npmViewCache.set(key, npmViewUncached(ctx, spec, field));
  return npmViewCache.get(key);
}

function npmViewUncached(ctx, spec, field) {
  const result = spawnSync("npm", shellSafe(["view", spec, field, "--json"]), {
    cwd: ctx.root,
    encoding: "utf8",
    shell: isWindows,
  });
  if (result.status !== 0 || !result.stdout.trim()) return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

/**
 * Lists versions of `dep` (newest first, latest patch of each minor line) whose peer dependencies
 * accept what the project already has installed — e.g. skips a test runner that rejects the
 * project's @types/node. Returns [] when the registry cannot be queried.
 */
function compatibleVersions(ctx, dep, known, limit = 3) {
  let range = dep.spec.slice(dep.name.length + 1) || "x";
  if (dep.rangeFrom && known.has(dep.rangeFrom)) {
    const parentDeps = npmView(ctx, `${dep.rangeFrom}@${known.get(dep.rangeFrom)}`, "dependencies") ?? {};
    if (parentDeps[dep.name]) range = parentDeps[dep.name];
  }
  // List every version ("x") and filter locally, so no range characters reach the shell.
  const listed = npmView(ctx, `${dep.name}@x`, "version");
  if (listed === undefined) return [];
  const versions = (Array.isArray(listed) ? listed : [listed])
    .filter((version) => parseVersion(version) && !parseVersion(version).prerelease && satisfies(version, range))
    .sort((a, b) => compareParts(parseVersion(b).parts, parseVersion(a).parts));

  const result = [];
  const seenMinors = new Set();
  for (const version of versions.slice(0, 60)) {
    const [major, minor] = parseVersion(version).parts;
    if (seenMinors.has(`${major}.${minor}`)) continue;
    const peers = npmView(ctx, `${dep.name}@${version}`, "peerDependencies") ?? {};
    const conflict = Object.entries(peers).some(([peer, peerRange]) => {
      const installed = known.get(peer);
      return installed && !satisfies(installed, peerRange);
    });
    if (conflict) continue;
    seenMinors.add(`${major}.${minor}`);
    result.push(version);
    if (result.length >= limit) break;
  }
  return result;
}

function specOf(entry) {
  return entry.candidates.length > 0 ? `${entry.dep.name}@${entry.candidates[entry.index]}` : entry.dep.spec;
}

/** npm only: ask npm to resolve the batch without installing; step down a package if resolution fails. */
function settleNpmBatch(ctx, entries, dev) {
  const resolves = () => {
    const [command, args] = installArgs("npm", entries.map(specOf), dev);
    const result = spawnSync(command, shellSafe([...args, "--dry-run", "--no-audit", "--no-fund"]), {
      cwd: ctx.root,
      encoding: "utf8",
      shell: isWindows,
    });
    return result.status === 0;
  };
  if (resolves()) return;
  for (const entry of entries) {
    while (entry.index < entry.candidates.length - 1) {
      entry.index += 1;
      if (resolves()) {
        log.info(`${entry.dep.name}: using ${entry.candidates[entry.index]} — newer releases do not resolve with this project`);
        return;
      }
    }
    entry.index = 0;
  }
}

function installDependencies(ctx) {
  log.step("Dependencies");
  const deps = allDependencies(ctx.pkg);
  const missing = { runtime: [], dev: [] };

  const consider = (list, bucket) => {
    for (const dep of list) {
      if (deps[dep.name]) {
        const major = installedMajor(ctx, dep.name);
        if (dep.minMajor && major !== null && major < dep.minMajor) {
          warn(ctx, `${dep.name} v${major} is installed but the generated code needs v${dep.minMajor}+. Left untouched — upgrade manually: ${ctx.pm} ${ctx.pm === "npm" ? "install" : "add"} ${dep.spec}`);
        }
        continue;
      }
      missing[bucket].push(dep);
    }
  };
  consider(RUNTIME_DEPENDENCIES, "runtime");
  consider(DEV_DEPENDENCIES, "dev");
  ctx.tailwindAdded = !deps.tailwindcss;
  if (ctx.tailwindAdded) consider(TAILWIND_DEPENDENCIES, "dev");

  const willInstall = !ctx.dryRun && !ctx.options.skipInstall;

  // Brand-new projects only: align @types/node with the running Node.js major (create-next-app
  // pins an older one, which newer test tooling rejects). Existing projects are never touched.
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const typesNodeMajor = deps["@types/node"] ? installedMajor(ctx, "@types/node") : null;
  if (ctx.isNewProject && willInstall && typesNodeMajor !== null && typesNodeMajor < nodeMajor) {
    run(...installArgs(ctx.pm, [`@types/node@${nodeMajor}`], true), ctx.root);
    log.ok(`@types/node aligned with Node.js ${nodeMajor} (new project).`);
  }

  if (missing.runtime.length === 0 && missing.dev.length === 0) {
    log.ok("All required packages are already installed.");
    return;
  }

  const known = new Map();
  for (const name of Object.keys(deps)) {
    const version = installedVersion(ctx, name);
    if (version) known.set(name, version);
  }
  if (willInstall) log.info("Selecting versions compatible with the installed packages…");

  for (const [bucket, dev] of [["runtime", false], ["dev", true]]) {
    if (missing[bucket].length === 0) continue;
    // Pick versions; if npm has to step a package down, re-pick the packages that depend on it.
    const pinned = new Map();
    let entries = [];
    for (let round = 0; round < 3; round += 1) {
      const roundKnown = new Map(known);
      entries = missing[bucket].map((dep) => {
        const candidates = pinned.has(dep.name)
          ? [pinned.get(dep.name)]
          : willInstall
            ? compatibleVersions(ctx, dep, roundKnown)
            : [];
        if (candidates.length > 0) roundKnown.set(dep.name, candidates[0]);
        return { dep, candidates, index: 0 };
      });
      if (!willInstall || ctx.pm !== "npm") break;
      settleNpmBatch(ctx, entries, dev);
      const steppedDown = entries.filter((entry) => entry.index > 0);
      if (steppedDown.length === 0) break;
      for (const entry of steppedDown) pinned.set(entry.dep.name, entry.candidates[entry.index]);
    }
    for (const entry of entries) {
      if (entry.candidates.length > 0) known.set(entry.dep.name, entry.candidates[entry.index]);
    }
    const [command, args] = installArgs(ctx.pm, entries.map(specOf), dev);
    if (!willInstall) {
      log.info(`Would run: ${command} ${args.join(" ")}`);
      if (ctx.options.skipInstall && !ctx.dryRun) manual(ctx, `Install dependencies: ${command} ${args.join(" ")}`);
    } else {
      run(command, args, ctx.root);
    }
  }
  if (willInstall) loadPackageJson(ctx);
}

// ─────────────────────────────────────────────────────────────────────────────
// Config integration (tsconfig, package.json, ESLint, Prettier, Vitest, Tailwind)
// ─────────────────────────────────────────────────────────────────────────────

function configureTsconfig(ctx) {
  const rel = "tsconfig.json";
  const text = readFile(ctx, rel);
  let json;
  try {
    json = parseJsonc(text);
  } catch {
    manual(ctx, `tsconfig.json: ensure "strict": true and "paths": { "@/*": ["./${ctx.baseDir === "." ? "" : `${ctx.baseDir}/`}*"] }.`);
    return;
  }
  json.compilerOptions ??= {};
  const options = json.compilerOptions;
  const reasons = [];

  if (options.strict !== true) {
    if (ctx.isNewProject || ctx.options.strict) {
      options.strict = true;
      reasons.push("enabled strict mode");
    } else {
      warn(ctx, "TypeScript strict mode is off. Re-run with --strict to enable it (existing code may need type fixes).");
    }
  }
  options.paths ??= {};
  if (!options.paths["@/*"]) {
    options.paths["@/*"] = [ctx.baseDir === "." ? "./*" : `./${ctx.baseDir}/*`];
    reasons.push('added "@/*" alias');
  }
  if (reasons.length > 0) {
    if (/\/\/|\/\*/.test(text.replace(/"(?:\\.|[^"\\])*"/g, ""))) {
      warn(ctx, "tsconfig.json comments were removed while updating it (original kept in the backup).");
    }
    modifyFile(ctx, rel, `${JSON.stringify(json, null, detectIndent(text))}\n`, reasons.join(", "));
  }
}

function configurePackageScripts(ctx) {
  const rel = "package.json";
  const text = readFile(ctx, rel);
  const pkg = JSON.parse(text);
  pkg.scripts ??= {};
  // `next typegen` (Next.js 15.5+) generates route types such as LayoutProps before tsc runs.
  const nextVersion = parseVersion(installedVersion(ctx, "next") ?? "")?.parts ?? [0, 0, 0];
  const hasTypegen = compareParts(nextVersion, [15, 5, 0]) >= 0;
  const wanted = {
    lint: "eslint .",
    typecheck: hasTypegen ? "next typegen && tsc --noEmit" : "tsc --noEmit",
    test: "vitest run",
    "test:watch": "vitest",
    format: "prettier --write .",
    "format:check": "prettier --check .",
  };
  const added = [];
  for (const [name, command] of Object.entries(wanted)) {
    if (pkg.scripts[name] === undefined) {
      pkg.scripts[name] = command;
      added.push(name);
    }
  }
  if (added.length > 0) {
    modifyFile(ctx, rel, `${JSON.stringify(pkg, null, detectIndent(text))}\n`, `added scripts: ${added.join(", ")}`);
  }
}

function configurePrettier(ctx) {
  const configs = [
    ".prettierrc", ".prettierrc.json", ".prettierrc.yml", ".prettierrc.yaml", ".prettierrc.json5",
    ".prettierrc.js", ".prettierrc.cjs", ".prettierrc.mjs", ".prettierrc.toml",
    "prettier.config.js", "prettier.config.cjs", "prettier.config.mjs", "prettier.config.ts",
  ];
  const hasConfig = configs.some((file) => fileExists(ctx, file)) || ctx.pkg.prettier !== undefined;
  if (!hasConfig) writeNew(ctx, ".prettierrc.json", templates.prettierConfig());
  writeNew(ctx, ".prettierignore", templates.prettierIgnore());
}

function configureVitest(ctx) {
  const existing = ["vitest.config.ts", "vitest.config.mts", "vitest.config.js", "vitest.config.mjs"].find((file) => fileExists(ctx, file));
  if (existing) {
    ctx.report.skipped.push(existing);
    if (readFile(ctx, existing).includes("test/setup")) return;
    manual(ctx, `Vitest config ${existing} already exists — make sure it uses jsdom, the "@" alias and setupFiles: ["./${inSrc(ctx, "test/setup.ts")}"].`);
  } else {
    writeNew(ctx, "vitest.config.mts", templates.vitestConfig(ctx));
  }
  if (["jest.config.js", "jest.config.ts", "jest.config.mjs", "jest.config.cjs"].some((file) => fileExists(ctx, file))) {
    warn(ctx, "Jest config found. Vitest was added alongside it; the existing \"test\" script was left unchanged.");
  }
}

function configureEslint(ctx) {
  const flatConfigs = ["eslint.config.mjs", "eslint.config.js", "eslint.config.ts", "eslint.config.mts"];
  const legacyConfigs = [".eslintrc", ".eslintrc.json", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.yml", ".eslintrc.yaml"];
  const flat = flatConfigs.find((file) => fileExists(ctx, file));
  const legacy = legacyConfigs.find((file) => fileExists(ctx, file));

  if (!flat) {
    if (legacy) manual(ctx, `Legacy ESLint config ${legacy} detected — add "prettier" to "extends" and port eslint.architecture.mjs rules manually.`);
    else warn(ctx, "No ESLint config found — architecture lint rules were not wired up.");
    return;
  }

  writeNew(ctx, "eslint.architecture.mjs", templates.eslintArchitecture(ctx));
  const text = readFile(ctx, flat);
  if (text.includes("eslint.architecture")) return;

  const exportMatch = text.match(/export\s+default\s+([A-Za-z_$][\w$]*)\s*;?/);
  if (!exportMatch) {
    manual(ctx, `Add to ${flat}: import architectureConfig from "./eslint.architecture.mjs"; and spread ...architectureConfig at the end of the exported config array.`);
    return;
  }
  const importLine = 'import architectureConfig from "./eslint.architecture.mjs";';
  let next = insertAfterImports(text, importLine);
  next = next.replace(
    exportMatch[0],
    `const configWithArchitecture = [...${exportMatch[1]}, ...architectureConfig];\n\nexport default configWithArchitecture;`,
  );
  modifyFile(ctx, flat, next, "added architecture boundary rules + Prettier compatibility");
}

function configureTailwind(ctx) {
  if (!ctx.tailwindAdded) return;
  const postcssConfigs = ["postcss.config.mjs", "postcss.config.js", "postcss.config.cjs", ".postcssrc", ".postcssrc.json"];
  if (!postcssConfigs.some((file) => fileExists(ctx, file))) {
    writeNew(ctx, "postcss.config.mjs", templates.postcssConfig());
  } else {
    manual(ctx, 'Add "@tailwindcss/postcss": {} to your PostCSS plugins.');
  }
  const globals = inSrc(ctx, "app/globals.css");
  if (fileExists(ctx, globals)) {
    const css = readFile(ctx, globals);
    if (!/@import\s+["']tailwindcss["']|@tailwind\s+base/.test(css)) {
      modifyFile(ctx, globals, `@import "tailwindcss";\n\n${css}`, "added Tailwind import");
    }
  } else {
    writeNew(ctx, globals, '@import "tailwindcss";\n');
    manual(ctx, `Import ./globals.css in ${ctx.appDir}/layout.tsx.`);
  }
}

function configureGitignore(ctx) {
  const line = `${BACKUP_DIR_NAME}/`;
  if (!fileExists(ctx, ".gitignore")) {
    writeNew(ctx, ".gitignore", `node_modules/\n.next/\n.env*.local\n${line}\n`);
    return;
  }
  const text = readFile(ctx, ".gitignore");
  const entries = text.split(/\r?\n/).map((entry) => entry.trim());
  const additions = [];
  if (!entries.includes(line) && !entries.includes(BACKUP_DIR_NAME)) additions.push(`# init-architecture backups\n${line}`);
  // create-next-app ignores ".env*", which would also hide the committed template.
  if (entries.includes(".env*") && !entries.includes("!.env.example")) {
    additions.push("# keep the environment template in git\n!.env.example");
  }
  if (additions.length > 0) {
    modifyFile(ctx, ".gitignore", `${text.replace(/\s*$/, "")}\n\n${additions.join("\n\n")}\n`, "ignored backups, kept .env.example");
  }
}

function insertAfterImports(source, statement) {
  const importPattern = /^import\s[\s\S]*?from\s*["'][^"']+["'];?[^\S\n]*$|^import\s*["'][^"']+["'];?[^\S\n]*$/gm;
  let lastEnd = -1;
  for (const match of source.matchAll(importPattern)) lastEnd = match.index + match[0].length;
  if (lastEnd === -1) {
    const directive = source.match(/^\s*["']use (client|server)["'];?\s*\n/);
    const at = directive ? directive[0].length : 0;
    return `${source.slice(0, at)}${statement}\n${source.slice(at)}`;
  }
  return `${source.slice(0, lastEnd)}\n${statement}${source.slice(lastEnd)}`;
}

/** Wrap {children} in the root layout with <Providers>. Never guesses: ambiguous layouts get manual steps. */
function integrateProviders(ctx) {
  const candidates = ["layout.tsx", "layout.jsx", "layout.js"].map((file) => `${ctx.appDir}/${file}`);
  const layout = candidates.find((file) => fileExists(ctx, file));
  if (!layout) {
    writeNew(ctx, `${ctx.appDir}/layout.tsx`, templates.rootLayout(ctx));
    return;
  }
  if (ctx.skipProviderIntegration) return;
  const source = readFile(ctx, layout);
  if (/<Providers[\s>]/.test(source) || /<StoreProvider[\s>]/.test(source)) {
    log.ok(`${layout} already renders the providers.`);
    return;
  }
  // Only look at the JSX between <body ...> and </body>; `{ children }` also appears in the props.
  const bodyOpen = source.search(/<body[\s>]/);
  const bodyContentStart = bodyOpen === -1 ? -1 : source.indexOf(">", bodyOpen) + 1;
  const bodyClose = source.indexOf("</body>", bodyContentStart);
  const bodyContent = bodyOpen === -1 || bodyClose === -1 ? "" : source.slice(bodyContentStart, bodyClose);
  const childrenInBody = bodyContent.match(/\{\s*children\s*\}/g) ?? [];
  if (childrenInBody.length !== 1) {
    manual(ctx, `Wrap {children} inside <body> of ${layout} with <Providers> (import { Providers } from "./providers").`);
    return;
  }
  const wrappedBody = bodyContent.replace(/\{\s*children\s*\}/, "<Providers>{children}</Providers>");
  const withProviders = `${source.slice(0, bodyContentStart)}${wrappedBody}${source.slice(bodyClose)}`;
  const next = insertAfterImports(withProviders, 'import { Providers } from "./providers";');
  if (modifyFile(ctx, layout, next, "wrapped {children} with <Providers>") && ctx.isNewProject) {
    ctx.formatAlso.push(layout);
  }
}

/** Insert or refresh a marked block inside AI rule files, preserving user content around it. */
function writeManagedBlock(ctx, rel, body, frontmatter = "") {
  const block = `${MANAGED_START}\n${body.trim()}\n${MANAGED_END}`;
  if (!fileExists(ctx, rel)) {
    writeNew(ctx, rel, `${frontmatter}${block}\n`);
    return;
  }
  let current = readFile(ctx, rel);
  const start = current.indexOf(MANAGED_START);
  const end = current.indexOf(MANAGED_END);
  let next;
  if (start !== -1 && end > start) {
    next = `${current.slice(0, start)}${block}${current.slice(end + MANAGED_END.length)}`;
  } else {
    if (frontmatter && !current.startsWith("---")) current = `${frontmatter}${current}`;
    next = `${current.replace(/\s*$/, "")}\n\n${block}\n`;
  }
  modifyFile(ctx, rel, next, start !== -1 ? "refreshed architecture rules" : "appended architecture rules");
}

function writeAgentRules(ctx) {
  const body = templates.agentRules(ctx);
  writeManagedBlock(ctx, "AGENTS.md", body);
  const claude = fileExists(ctx, "CLAUDE.md") ? readFile(ctx, "CLAUDE.md") : "";
  if (/^@AGENTS\.md\s*$/m.test(claude) && !claude.includes(MANAGED_START)) {
    log.ok("CLAUDE.md already imports @AGENTS.md — rules are shared.");
  } else {
    writeManagedBlock(ctx, "CLAUDE.md", body);
  }
  writeManagedBlock(
    ctx,
    ".cursor/rules/architecture.mdc",
    body,
    "---\ndescription: Project architecture, folder structure and coding conventions\nglobs:\nalwaysApply: true\n---\n\n",
  );
  writeManagedBlock(ctx, ".github/copilot-instructions.md", body);
}

function formatCreatedFiles(ctx) {
  if (ctx.dryRun) return;
  const prettierBin = path.join(ctx.root, "node_modules", "prettier", "bin", "prettier.cjs");
  if (!fs.existsSync(prettierBin)) return;
  const files = [...ctx.report.created, ...ctx.formatAlso].filter((file) => /\.(tsx?|mts|mjs|json|css)$/.test(file));
  if (files.length === 0) return;
  const result = spawnSync(process.execPath, [prettierBin, "--write", "--log-level", "warn", ...files], { cwd: ctx.root, stdio: "inherit" });
  if (result.status !== 0) warn(ctx, "Prettier could not format some generated files.");
}

// ─────────────────────────────────────────────────────────────────────────────
// Architecture scaffolding
// ─────────────────────────────────────────────────────────────────────────────

function scaffoldArchitecture(ctx) {
  log.step("Scaffolding architecture");
  const files = {
    // app/
    [`${ctx.appDir}/providers.tsx`]: templates.appProviders(),
    [`${ctx.appDir}/loading.tsx`]: templates.appLoading(),
    [`${ctx.appDir}/error.tsx`]: templates.appError(),
    [`${ctx.appDir}/api/health/route.ts`]: templates.healthRoute(),
    // store/
    [inSrc(ctx, "store/base-api.ts")]: templates.baseApi(),
    [inSrc(ctx, "store/root-reducer.ts")]: templates.rootReducer(),
    [inSrc(ctx, "store/store.ts")]: templates.store(),
    [inSrc(ctx, "store/hooks.ts")]: templates.storeHooks(),
    [inSrc(ctx, "store/provider.tsx")]: templates.storeProvider(),
    // config/
    [inSrc(ctx, "config/env.ts")]: templates.serverEnv(),
    [inSrc(ctx, "config/public-env.ts")]: templates.publicEnv(),
    [inSrc(ctx, "config/routes.ts")]: templates.routes(),
    [inSrc(ctx, "config/site.ts")]: templates.site(ctx),
    // shared/
    [inSrc(ctx, "shared/constants/locale.ts")]: templates.localeConstants(),
    [inSrc(ctx, "shared/types/common.ts")]: templates.commonTypes(),
    [inSrc(ctx, "shared/schemas/common.schema.ts")]: templates.commonSchemas(),
    [inSrc(ctx, "shared/lib/cn.ts")]: templates.cn(),
    [inSrc(ctx, "shared/hooks/use-debounced-value.ts")]: templates.useDebouncedValue(),
    [inSrc(ctx, "shared/components/ui/button.tsx")]: templates.button(),
    [inSrc(ctx, "shared/components/ui/button.test.tsx")]: templates.buttonTest(),
    [inSrc(ctx, "shared/components/forms/form-field.tsx")]: templates.formField(),
    [inSrc(ctx, "shared/components/forms/text-input.tsx")]: templates.textInput(),
    [inSrc(ctx, "shared/components/layout/container.tsx")]: templates.container(),
    [inSrc(ctx, "shared/components/feedback/spinner.tsx")]: templates.spinner(),
    [inSrc(ctx, "shared/components/feedback/alert.tsx")]: templates.alert(),
    // infrastructure/
    [inSrc(ctx, "infrastructure/http/http-error.ts")]: templates.httpError(),
    [inSrc(ctx, "infrastructure/http/http-client.ts")]: templates.httpClient(),
    [inSrc(ctx, "infrastructure/http/server-api-client.ts")]: templates.serverApiClient(),
    [inSrc(ctx, "infrastructure/auth/session.ts")]: templates.session(),
    [inSrc(ctx, "infrastructure/logging/logger.ts")]: templates.logger(),
    // test/
    [inSrc(ctx, "test/setup.ts")]: templates.testSetup(),
    [inSrc(ctx, "test/render.tsx")]: templates.testRender(),
    // root
    ".env.example": templates.envExample(),
  };

  for (const [name, [source, test]] of Object.entries(templates.sharedUtils())) {
    files[inSrc(ctx, `shared/utils/${name}.ts`)] = source;
    files[inSrc(ctx, `shared/utils/${name}.test.ts`)] = test;
  }

  if (!fileExists(ctx, `${ctx.appDir}/page.tsx`) && !fileExists(ctx, `${ctx.appDir}/page.jsx`) && !fileExists(ctx, `${ctx.appDir}/page.js`)) {
    files[`${ctx.appDir}/page.tsx`] = templates.appPage();
  }

  for (const [rel, content] of Object.entries(files)) writeNew(ctx, rel, content);

  for (const dir of ["infrastructure/database", "infrastructure/storage", "styles"]) {
    ensureDir(ctx, inSrc(ctx, dir));
  }
  log.ok("Core folders and starter files ready.");
}

function initArchitecture(ctx) {
  detectProject(ctx);
  installDependencies(ctx);

  log.step("Configuring tooling");
  configureTsconfig(ctx);
  configurePackageScripts(ctx);
  configurePrettier(ctx);
  configureVitest(ctx);
  configureEslint(ctx);
  configureTailwind(ctx);
  configureGitignore(ctx);
  log.ok("Tooling configured.");

  scaffoldArchitecture(ctx);

  log.step("Integrating Redux provider");
  integrateProviders(ctx);

  log.step("Writing AI coding rules");
  writeAgentRules(ctx);
  log.ok("AGENTS.md, CLAUDE.md, .cursor/rules/architecture.mdc, .github/copilot-instructions.md");

  ctx.initialized = true;
  const features = [...new Set([...ctx.options.initFeatures, ...ctx.options.features])];
  for (const feature of features) generateFeature(ctx, feature, ctx.options.features.includes(feature) ? ctx.options : {});

  formatCreatedFiles(ctx);
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature generator
// ─────────────────────────────────────────────────────────────────────────────

function splitWords(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

function singularize(word) {
  if (word.length > 3 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (/(ss|us|is)$/.test(word)) return word;
  if (/(ses|xes|zes|ches|shes)$/.test(word)) return word.slice(0, -2);
  if (word.length > 1 && word.endsWith("s")) return word.slice(0, -1);
  return word;
}

const pascalOf = (words) => words.map((word) => word[0].toUpperCase() + word.slice(1)).join("");
const camelOf = (words) => {
  const pascal = pascalOf(words);
  return pascal[0].toLowerCase() + pascal.slice(1);
};

/** Validate and normalize a feature name. Rejects anything that could escape the features folder. */
function normalizeFeatureName(raw) {
  if (typeof raw !== "string" || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(raw)) {
    throw new CliError(`Invalid feature name "${raw}". Use letters, numbers and dashes, starting with a letter (e.g. orders, user-profile).`);
  }
  const kebab = splitWords(raw).join("-");
  if (kebab.length > 40) throw new CliError(`Feature name "${raw}" is too long (max 40 characters).`);
  if (RESERVED_FEATURE_NAMES.has(kebab)) throw new CliError(`"${kebab}" is a reserved name and cannot be used as a feature.`);
  return kebab;
}

function featureNames(kebab, entityOverride) {
  const words = kebab.split("-");
  const entityWords = entityOverride
    ? splitWords(normalizeFeatureName(entityOverride))
    : [...words.slice(0, -1), singularize(words[words.length - 1])];
  const pascal = pascalOf(words);
  const entityPascal = pascalOf(entityWords);
  return {
    kebab,
    camel: camelOf(words),
    pascal,
    entityCamel: camelOf(entityWords),
    entityPascal,
    // "getOrders" for plural features, "getDashboardList" when singular === plural.
    listPascal: entityPascal === pascal ? `${pascal}List` : pascal,
  };
}

function generateFeature(ctx, rawName, options = {}) {
  const kebab = normalizeFeatureName(rawName);
  log.step(`Feature: ${kebab}`);

  if (!ctx.initialized) {
    detectFeatureContext(ctx);
  }

  const names = featureNames(kebab, options.entity);
  const dir = inSrc(ctx, "features", kebab);
  const featureFiles = kebab === "auth" ? templates.authFeature(names) : templates.genericFeature(names);
  const before = ctx.report.created.length;

  for (const [rel, content] of Object.entries(featureFiles)) writeNew(ctx, path.posix.join(dir, rel), content);
  for (const sub of ["components", "hooks", "utils", "tests"]) ensureDir(ctx, path.posix.join(dir, sub));

  if (options.layered) {
    for (const layer of ["domain", "application", "infrastructure", "presentation"]) ensureDir(ctx, path.posix.join(dir, layer));
    writeNew(ctx, path.posix.join(dir, "ARCHITECTURE.md"), templates.layeredReadme(names));
  }

  const created = ctx.report.created.length - before;
  if (created === 0) log.ok(`${dir} already complete — nothing changed.`);
  else log.ok(`${dir} — ${created} file(s) created, existing files untouched.`);
}

/** For `--feature` runs: locate the project and verify init has been done. */
function detectFeatureContext(ctx) {
  loadPackageJson(ctx);
  ctx.pm = detectPackageManager(ctx.root, ctx.options.pm);
  ctx.baseDir = fs.existsSync(path.join(ctx.root, "src")) || !fs.existsSync(path.join(ctx.root, "app")) ? "src" : ".";
  ctx.appDir = inSrc(ctx, "app");
  const required = ["store/root-reducer.ts", "store/base-api.ts"].map((file) => inSrc(ctx, file));
  const missing = required.filter((file) => !fileExists(ctx, file));
  if (missing.length > 0) {
    throw new CliError(`Architecture not initialized (missing ${missing.join(", ")}). Run: node init-architecture.mjs`);
  }
  ctx.initialized = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Project creation
// ─────────────────────────────────────────────────────────────────────────────

function createProject(options) {
  const name = options.projectName;
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name) || name.length > 214) {
    throw new CliError(`Invalid project name "${name}". Use lowercase letters, numbers, ".", "_" and "-".`);
  }
  const target = path.resolve(options.cwd, name);
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
    throw new CliError(`Directory ${target} already exists and is not empty.`);
  }
  const pm = options.pm ?? detectPackageManager(options.cwd, undefined);
  log.step(`Creating Next.js project "${name}" with ${pm}`);
  const args = [
    "--yes", "create-next-app@latest", name,
    "--ts", "--tailwind", "--eslint", "--app", "--src-dir",
    "--import-alias", "@/*", `--use-${pm}`, "--yes",
  ];
  if (options.skipInstall) args.push("--skip-install");
  if (options.dryRun) {
    log.info(`Would run: npx ${args.join(" ")}`);
    return null;
  }
  run("npx", args, options.cwd);
  return { root: target, pm };
}

// ─────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────

function printReport(ctx) {
  const { created, modified, skipped, warnings, manual: manualSteps } = ctx.report;
  const prefix = ctx.dryRun ? "Would create" : "Created";
  console.log(`\n${color.bold("Summary")}${ctx.dryRun ? color.yellow(" (dry run — nothing was written)") : ""}`);
  console.log(`  ${color.green(`${prefix}: ${created.length}`)}  ${color.cyan(`Modified: ${modified.length}`)}  ${color.dim(`Skipped (already existed): ${skipped.length}`)}`);
  if (modified.length > 0) {
    console.log(`\n  ${color.bold("Modified files")}${ctx.dryRun ? "" : color.dim(` (backups: ${BACKUP_DIR_NAME}/${ctx.backupStamp}/)`)}`);
    for (const entry of modified) console.log(`    ${entry}`);
  }
  if (manualSteps.length > 0) {
    console.log(`\n  ${color.bold(color.yellow("Manual steps"))}`);
    for (const entry of manualSteps) console.log(`    - ${entry}`);
  }
  if (warnings.length > 0) {
    console.log(`\n  ${color.bold("Warnings")}`);
    for (const entry of warnings) console.log(`    - ${entry}`);
  }
  const runScript = `${ctx.pm} run`;
  console.log(`\n  ${color.bold("Next")}: ${runScript} typecheck · ${runScript} lint · ${runScript} test · ${runScript} dev`);
  console.log(`  ${color.bold("New feature")}: node init-architecture.mjs --feature <name>\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────────────────────────────────────

const templates = {
  // ── Tooling ────────────────────────────────────────────────────────────────
  prettierConfig: () => `{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all",
  "printWidth": 100
}`,

  prettierIgnore: () => `node_modules
.next
out
build
dist
coverage
next-env.d.ts
package-lock.json
pnpm-lock.yaml
yarn.lock
bun.lock
${BACKUP_DIR_NAME}
# Managed by init-architecture.mjs
AGENTS.md
CLAUDE.md
.cursor
.github/copilot-instructions.md`,

  vitestConfig: (ctx) => `import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./${ctx.baseDir === "." ? "" : ctx.baseDir}", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./${inSrc(ctx, "test/setup.ts")}"],
    include: ["${ctx.baseDir === "." ? "" : `${ctx.baseDir}/`}**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/.next/**"],
    css: false,
  },
});`,

  eslintArchitecture: (ctx) => {
    const base = ctx.baseDir === "." ? "" : `${ctx.baseDir}/`;
    return `/**
 * Architecture boundary rules (generated by init-architecture.mjs).
 * Spread into eslint.config.mjs: export default [...yourConfig, ...architectureConfig];
 */
import prettierConfig from "eslint-config-prettier";

const featureEntryMessage =
  "Import a feature only through its public entry: @/features/<name>, @/features/<name>/client or @/features/<name>/server.";
const layerMessage = "shared/, store/, infrastructure/ and config/ must not depend on features/.";

const architectureConfig = [
  {
    files: ["${base}**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/features/*/*", "!@/features/*/client", "!@/features/*/server"],
              message: featureEntryMessage,
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "${base}shared/**/*.{ts,tsx}",
      "${base}store/**/*.{ts,tsx}",
      "${base}infrastructure/**/*.{ts,tsx}",
      "${base}config/**/*.{ts,tsx}",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["@/features", "@/features/*"], message: layerMessage }] },
      ],
    },
  },
  // Must stay last: turns off stylistic rules that conflict with Prettier.
  prettierConfig,
];

export default architectureConfig;`;
  },

  postcssConfig: () => `const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;`,

  envExample: () => `# Browser-safe values. Only variables prefixed with NEXT_PUBLIC_ reach the client bundle.
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_API_URL=/api

# Server-only values. Never prefix secrets with NEXT_PUBLIC_.
API_BASE_URL=`,

  // ── app/ ───────────────────────────────────────────────────────────────────
  rootLayout: (ctx) => {
    const hasGlobals = fileExists(ctx, `${ctx.appDir}/globals.css`) || ctx.tailwindAdded;
    return `import type { Metadata } from "next";
import type { ReactNode } from "react";
import { siteConfig } from "@/config/site";
import { Providers } from "./providers";
${hasGlobals ? 'import "./globals.css";\n' : ""}
export const metadata: Metadata = {
  title: { default: siteConfig.name, template: \`%s | \${siteConfig.name}\` },
  description: siteConfig.description,
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}`;
  },

  appProviders: () => `"use client";

import type { ReactNode } from "react";
import { StoreProvider } from "@/store/provider";

/** Every client-side provider is composed here, once, and mounted by the root layout. */
export function Providers({ children }: { children: ReactNode }) {
  return <StoreProvider>{children}</StoreProvider>;
}`,

  appPage: () => `import { Container } from "@/shared/components/layout/container";
import { siteConfig } from "@/config/site";

export default function HomePage() {
  return (
    <Container className="py-16">
      <h1 className="text-3xl font-semibold tracking-tight">{siteConfig.name}</h1>
      <p className="mt-2 text-neutral-600">{siteConfig.description}</p>
    </Container>
  );
}`,

  appLoading: () => `import { Spinner } from "@/shared/components/feedback/spinner";

export default function Loading() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <Spinner label="Loading" />
    </div>
  );
}`,

  appError: () => `"use client";

import { useEffect } from "react";
import { Button } from "@/shared/components/ui/button";
import { logger } from "@/infrastructure/logging/logger";

interface RouteErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
  /** Newer Next.js versions: re-fetches and re-renders the segment. Falls back to reset() when absent. */
  retry?: () => void;
}

export default function RouteError({ error, reset, retry }: RouteErrorProps) {
  useEffect(() => {
    logger.error("Unhandled route error", { message: error.message, digest: error.digest });
  }, [error]);

  return (
    <div role="alert" className="flex min-h-[50vh] flex-col items-center justify-center gap-4 p-6 text-center">
      <h2 className="text-xl font-semibold">Something went wrong</h2>
      <p className="max-w-md text-sm text-neutral-600">An unexpected error occurred. Please try again.</p>
      <Button onClick={() => (retry ?? reset)()}>Try again</Button>
    </div>
  );
}`,

  healthRoute: () => `import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({ status: "ok" });
}`,

  // ── store/ ─────────────────────────────────────────────────────────────────
  baseApi: () => `import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";
import { publicEnv } from "@/config/public-env";

/**
 * Single RTK Query API for the whole app. Features add endpoints with
 * \`baseApi.enhanceEndpoints({ addTagTypes: [...] }).injectEndpoints({ ... })\`
 * inside \`features/<name>/api/\` — never add endpoints here.
 */
export const baseApi = createApi({
  reducerPath: "api",
  baseQuery: fetchBaseQuery({ baseUrl: publicEnv.NEXT_PUBLIC_API_URL, credentials: "include" }),
  tagTypes: [],
  endpoints: () => ({}),
});`,

  rootReducer: () => `import { combineSlices } from "@reduxjs/toolkit";
import { baseApi } from "./base-api";

/**
 * Feature slices register themselves lazily with \`slice.injectInto(rootReducer)\` and extend
 * this interface through module augmentation, so reducers load only with the feature that uses them
 * and store.ts never needs editing when a feature is added.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface LazyLoadedSlices {}

export const rootReducer = combineSlices(baseApi).withLazyLoadedSlices<LazyLoadedSlices>();

export type RootState = ReturnType<typeof rootReducer>;`,

  store: () => `import { configureStore } from "@reduxjs/toolkit";
import { baseApi } from "./base-api";
import { rootReducer, type RootState } from "./root-reducer";

/**
 * Creates a new store. Called once per request on the server and once per browser session
 * on the client (see provider.tsx) — never export a module-level store instance.
 */
export function makeStore(preloadedState?: Partial<RootState>) {
  return configureStore({
    reducer: rootReducer,
    preloadedState,
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(baseApi.middleware),
    devTools: process.env.NODE_ENV !== "production",
  });
}

export type AppStore = ReturnType<typeof makeStore>;
export type AppDispatch = AppStore["dispatch"];
export type { RootState };`,

  storeHooks: () => `import { useDispatch, useSelector, useStore } from "react-redux";
import type { AppDispatch, AppStore, RootState } from "./store";

// Use these typed hooks everywhere instead of the plain react-redux hooks.
export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
export const useAppSelector = useSelector.withTypes<RootState>();
export const useAppStore = useStore.withTypes<AppStore>();`,

  storeProvider: () => `"use client";

import { setupListeners } from "@reduxjs/toolkit/query";
import { useEffect, useState, type ReactNode } from "react";
import { Provider } from "react-redux";
import { makeStore } from "./store";

export function StoreProvider({ children }: { children: ReactNode }) {
  // Lazy state initializer: one store per request on the server, one per session in the browser.
  const [store] = useState(() => makeStore());

  // Enables refetchOnFocus / refetchOnReconnect for RTK Query.
  useEffect(() => setupListeners(store.dispatch), [store]);

  return <Provider store={store}>{children}</Provider>;
}`,

  // ── config/ ────────────────────────────────────────────────────────────────
  serverEnv: () => `import "server-only";
import { z } from "zod";

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);

/** Server-only environment. Secrets belong here and must never be imported by client code. */
const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

function parseServerEnv(): ServerEnv {
  const result = serverEnvSchema.safeParse(process.env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => \`\${issue.path.map(String).join(".")}: \${issue.message}\`)
      .join("; ");
    throw new Error(\`Invalid server environment variables — \${details}\`);
  }
  return result.data;
}

export const env = parseServerEnv();`,

  publicEnv: () => `import { z } from "zod";

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);

/** Browser-safe environment. Only NEXT_PUBLIC_* variables, never secrets. */
const publicEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.preprocess(emptyToUndefined, z.string().url().default("http://localhost:3000")),
  NEXT_PUBLIC_API_URL: z.preprocess(emptyToUndefined, z.string().min(1).default("/api")),
});

// Each variable is referenced explicitly so Next.js can inline it into the client bundle.
export const publicEnv = publicEnvSchema.parse({
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
});`,

  routes: () => `/** Central route map. Use these constants instead of hard-coded paths. */
export const routes = {
  home: "/",
  login: "/login",
  dashboard: "/dashboard",
} as const;

export type AppRoute = (typeof routes)[keyof typeof routes];`,

  site: (ctx) => {
    const rawName = typeof ctx.pkg?.name === "string" ? ctx.pkg.name.replace(/^@[^/]+\//, "") : "My App";
    const name = splitWords(rawName).map((word) => word[0].toUpperCase() + word.slice(1)).join(" ") || "My App";
    return `import { publicEnv } from "./public-env";

export const siteConfig = {
  name: ${JSON.stringify(name)},
  description: "Built with Next.js, Redux Toolkit and a feature-based architecture.",
  url: publicEnv.NEXT_PUBLIC_APP_URL,
} as const;`;
  },

  // ── shared/ ────────────────────────────────────────────────────────────────
  localeConstants: () => `/** App-wide formatting defaults used by shared/utils. */
export const DEFAULT_LOCALE = "en-US";
export const DEFAULT_CURRENCY = "USD";`,

  commonTypes: () => `export type Nullable<T> = T | null;

export type Maybe<T> = T | null | undefined;

/** Explicit success/failure result for operations that can fail without throwing. */
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}`,

  commonSchemas: () => `import { z } from "zod";

/** Reusable building blocks. Feature-specific schemas live in features/<name>/schemas. */
export const idSchema = z.string().trim().min(1);

export const emailSchema = z.string().trim().toLowerCase().email("Enter a valid email address");

export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password must be at most 128 characters");

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});`,

  cn: () => `export type ClassValue = string | false | null | undefined;

/** Joins truthy class names: cn("px-4", isActive && "font-bold"). */
export function cn(...classes: ClassValue[]): string {
  return classes.filter(Boolean).join(" ");
}`,

  useDebouncedValue: () => `import { useEffect, useState } from "react";

/** Client hook: returns \`value\` after it has stopped changing for \`delayMs\`. */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}`,

  button: () => `import type { ComponentProps } from "react";
import { Spinner } from "@/shared/components/feedback/spinner";
import { cn } from "@/shared/lib/cn";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

const variantClasses: Record<ButtonVariant, string> = {
  primary: "bg-neutral-900 text-white hover:bg-neutral-700",
  secondary: "border border-neutral-300 bg-white text-neutral-900 hover:bg-neutral-50",
  ghost: "text-neutral-700 hover:bg-neutral-100",
  danger: "bg-red-600 text-white hover:bg-red-500",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-sm",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-6 text-base",
};

export interface ButtonProps extends ComponentProps<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  isLoading?: boolean;
}

export function Button({
  variant = "primary",
  size = "md",
  isLoading = false,
  disabled,
  className,
  children,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || isLoading}
      aria-busy={isLoading || undefined}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...props}
    >
      {isLoading ? <Spinner className="size-4" /> : null}
      {children}
    </button>
  );
}`,

  buttonTest: () => `import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./button";

describe("Button", () => {
  it("calls onClick", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("is disabled while loading", () => {
    render(<Button isLoading>Save</Button>);
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });
});`,

  formField: () => `import type { ReactNode } from "react";

export interface FormFieldProps {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}

/** Label + control + hint/error wrapper. Pair with React Hook Form's \`formState.errors\`. */
export function FormField({ id, label, error, hint, children }: FormFieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-neutral-800">
        {label}
      </label>
      {children}
      {hint && !error ? (
        <p id={\`\${id}-hint\`} className="text-xs text-neutral-500">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={\`\${id}-error\`} role="alert" className="text-xs text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}`,

  textInput: () => `import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { cn } from "@/shared/lib/cn";

export interface TextInputProps extends ComponentPropsWithoutRef<"input"> {
  invalid?: boolean;
}

/** Text input that works with React Hook Form's \`register()\` (forwards its ref). */
export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { className, invalid = false, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        "h-10 rounded-md border border-neutral-300 bg-white px-3 text-sm outline-none focus:border-neutral-900",
        invalid && "border-red-500 focus:border-red-600",
        className,
      )}
      {...props}
    />
  );
});`,

  container: () => `import type { ComponentProps } from "react";
import { cn } from "@/shared/lib/cn";

export function Container({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8", className)} {...props} />;
}`,

  spinner: () => `import { cn } from "@/shared/lib/cn";

export interface SpinnerProps {
  label?: string;
  className?: string;
}

export function Spinner({ label = "Loading", className }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn("inline-block size-5 animate-spin rounded-full border-2 border-current border-t-transparent", className)}
    />
  );
}`,

  alert: () => `import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

type AlertVariant = "info" | "success" | "warning" | "error";

const variantClasses: Record<AlertVariant, string> = {
  info: "border-blue-200 bg-blue-50 text-blue-900",
  success: "border-green-200 bg-green-50 text-green-900",
  warning: "border-amber-200 bg-amber-50 text-amber-900",
  error: "border-red-200 bg-red-50 text-red-900",
};

export interface AlertProps {
  variant?: AlertVariant;
  title?: string;
  children?: ReactNode;
  className?: string;
}

export function Alert({ variant = "info", title, children, className }: AlertProps) {
  return (
    <div
      role={variant === "error" ? "alert" : "status"}
      className={cn("rounded-md border px-4 py-3 text-sm", variantClasses[variant], className)}
    >
      {title ? <p className="font-medium">{title}</p> : null}
      {children ? <div className={title ? "mt-1" : undefined}>{children}</div> : null}
    </div>
  );
}`,

  // ── infrastructure/ ────────────────────────────────────────────────────────
  httpError: () => `export interface HttpErrorDetails {
  status: number;
  url: string;
  body: unknown;
}

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: unknown;

  constructor(message: string, { status, url, body }: HttpErrorDetails) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export function isHttpError(error: unknown): error is HttpError {
  return error instanceof HttpError;
}`,

  httpClient: () => `import type { z } from "zod";
import { HttpError } from "./http-error";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type HeadersFactory = () => HeadersInit | Promise<HeadersInit>;

export interface HttpClientOptions {
  baseUrl: string;
  headers?: HeadersInit | HeadersFactory;
  timeoutMs?: number;
}

export interface RequestOptions<T> extends Omit<RequestInit, "body" | "method"> {
  body?: unknown;
  /** Validates the response body; the request fails with HttpError if it does not match. */
  schema?: z.ZodType<T>;
  timeoutMs?: number;
}

function joinUrl(baseUrl: string, path: string): string {
  return \`\${baseUrl.replace(/\\/+$/, "")}/\${path.replace(/^\\/+/, "")}\`;
}

function isRawBody(body: unknown): body is BodyInit {
  return (
    typeof body === "string" ||
    body instanceof FormData ||
    body instanceof URLSearchParams ||
    body instanceof Blob ||
    body instanceof ArrayBuffer
  );
}

async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("application/json") ? response.json() : response.text();
}

/** Typed fetch wrapper with timeouts, JSON handling and optional Zod response validation. */
export function createHttpClient({ baseUrl, headers: defaultHeaders, timeoutMs: defaultTimeoutMs = 15_000 }: HttpClientOptions) {
  async function request<T>(method: HttpMethod, path: string, options: RequestOptions<T> = {}): Promise<T> {
    const { body, schema, timeoutMs = defaultTimeoutMs, headers, signal, ...init } = options;
    const url = joinUrl(baseUrl, path);

    const finalHeaders = new Headers(typeof defaultHeaders === "function" ? await defaultHeaders() : defaultHeaders);
    new Headers(headers).forEach((value, key) => finalHeaders.set(key, value));
    if (!finalHeaders.has("accept")) finalHeaders.set("accept", "application/json");

    let payload: BodyInit | undefined;
    if (body !== undefined) {
      if (isRawBody(body)) {
        payload = body;
      } else {
        payload = JSON.stringify(body);
        if (!finalHeaders.has("content-type")) finalHeaders.set("content-type", "application/json");
      }
    }

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const response = await fetch(url, {
      ...init,
      method,
      headers: finalHeaders,
      body: payload,
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
    });
    const data = await parseBody(response);

    if (!response.ok) {
      throw new HttpError(\`\${method} \${url} failed with status \${response.status}\`, { status: response.status, url, body: data });
    }
    if (schema) {
      const parsed = schema.safeParse(data);
      if (!parsed.success) {
        throw new HttpError(\`\${method} \${url} returned an unexpected response shape\`, { status: response.status, url, body: data });
      }
      return parsed.data;
    }
    return data as T;
  }

  return {
    request,
    get: <T>(path: string, options?: Omit<RequestOptions<T>, "body">) => request<T>("GET", path, options),
    post: <T>(path: string, options?: RequestOptions<T>) => request<T>("POST", path, options),
    put: <T>(path: string, options?: RequestOptions<T>) => request<T>("PUT", path, options),
    patch: <T>(path: string, options?: RequestOptions<T>) => request<T>("PATCH", path, options),
    delete: <T>(path: string, options?: RequestOptions<T>) => request<T>("DELETE", path, options),
  };
}

export type HttpClient = ReturnType<typeof createHttpClient>;`,

  serverApiClient: () => `import "server-only";
import { env } from "@/config/env";
import { getSessionToken } from "@/infrastructure/auth/session";
import { createHttpClient, type HttpClient } from "./http-client";

/** HTTP client for the backend API, authenticated with the session cookie. Null if API_BASE_URL is unset. */
export function getServerApiClient(): HttpClient | null {
  if (!env.API_BASE_URL) return null;
  return createHttpClient({
    baseUrl: env.API_BASE_URL,
    headers: async (): Promise<Record<string, string>> => {
      const token = await getSessionToken();
      return token ? { authorization: \`Bearer \${token}\` } : {};
    },
  });
}`,

  session: () => `import "server-only";
import { cookies } from "next/headers";

export const SESSION_COOKIE_NAME = "session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export async function getSessionToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(SESSION_COOKIE_NAME)?.value ?? null;
}

/** Only callable from Server Actions and Route Handlers. */
export async function setSessionToken(token: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

/** Only callable from Server Actions and Route Handlers. */
export async function clearSessionToken(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE_NAME);
}`,

  logger: () => `type LogLevel = "debug" | "info" | "warn" | "error";
type LogMeta = Record<string, unknown>;

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const minLevel: LogLevel =
  process.env.NODE_ENV === "production" ? "info" : process.env.NODE_ENV === "test" ? "warn" : "debug";

const writers: Record<LogLevel, (...args: unknown[]) => void> = {
  debug: console.debug,
  info: console.info,
  warn: console.warn,
  error: console.error,
};

function write(level: LogLevel, message: string, meta?: LogMeta): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minLevel]) return;
  // performance.* instead of new Date(): safe inside prerendered / cached components.
  const timestamp = new Date(performance.timeOrigin + performance.now()).toISOString();
  writers[level]({ level, message, timestamp, ...meta });
}

/** Small structured logger usable on server and client. Swap the writers for a real sink later. */
export const logger = {
  debug: (message: string, meta?: LogMeta) => write("debug", message, meta),
  info: (message: string, meta?: LogMeta) => write("info", message, meta),
  warn: (message: string, meta?: LogMeta) => write("warn", message, meta),
  error: (message: string, meta?: LogMeta) => write("error", message, meta),
};`,

  // ── test/ ──────────────────────────────────────────────────────────────────
  testSetup: () => `import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// "server-only" throws outside a React Server environment; tests run server modules directly.
vi.mock("server-only", () => ({}));

afterEach(() => {
  cleanup();
});`,

  testRender: () => `import { render, type RenderOptions } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { Provider } from "react-redux";
import { makeStore, type AppStore, type RootState } from "@/store/store";

interface RenderWithStoreOptions extends Omit<RenderOptions, "wrapper"> {
  preloadedState?: Partial<RootState>;
  store?: AppStore;
}

/** Renders a component inside a fresh Redux store. */
export function renderWithStore(
  ui: ReactElement,
  { preloadedState, store = makeStore(preloadedState), ...options }: RenderWithStoreOptions = {},
) {
  function Wrapper({ children }: { children: ReactNode }) {
    return <Provider store={store}>{children}</Provider>;
  }
  return { store, ...render(ui, { wrapper: Wrapper, ...options }) };
}`,

  // ── shared/utils (source + test pairs) ────────────────────────────────────
  sharedUtils: () => ({
    date: [
      `import { DEFAULT_LOCALE } from "@/shared/constants/locale";

export type DateInput = Date | string | number;

/** Converts input to a valid Date, or null. Never returns an "Invalid Date". */
export function toDate(input: DateInput | null | undefined): Date | null {
  if (input === null || input === undefined || input === "") return null;
  const date = input instanceof Date ? new Date(input.getTime()) : new Date(input);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function isValidDate(input: unknown): boolean {
  return (input instanceof Date || typeof input === "string" || typeof input === "number") && toDate(input) !== null;
}

/**
 * Locale-aware date formatting. Pass \`timeZone\` in options when output must match between
 * server and client rendering.
 */
export function formatDate(
  input: DateInput | null | undefined,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium" },
  locale: string = DEFAULT_LOCALE,
): string {
  const date = toDate(input);
  return date ? new Intl.DateTimeFormat(locale, options).format(date) : "";
}

export function formatDateTime(input: DateInput | null | undefined, locale: string = DEFAULT_LOCALE): string {
  return formatDate(input, { dateStyle: "medium", timeStyle: "short" }, locale);
}

/** YYYY-MM-DD in UTC. */
export function toISODateString(input: DateInput): string {
  const date = toDate(input);
  return date ? date.toISOString().slice(0, 10) : "";
}

const RELATIVE_UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
  ["second", 1],
];

/** "yesterday", "in 3 hours", "2 weeks ago" … */
export function formatRelativeTime(
  input: DateInput,
  now: DateInput = new Date(),
  locale: string = DEFAULT_LOCALE,
): string {
  const date = toDate(input);
  const base = toDate(now);
  if (!date || !base) return "";
  const diffSeconds = Math.round((date.getTime() - base.getTime()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, seconds] of RELATIVE_UNITS) {
    if (Math.abs(diffSeconds) >= seconds || unit === "second") {
      return formatter.format(Math.round(diffSeconds / seconds), unit);
    }
  }
  return "";
}

export function addDays(input: DateInput, days: number): Date | null {
  const date = toDate(input);
  if (!date) return null;
  date.setDate(date.getDate() + days);
  return date;
}

/** Same calendar day in local time. */
export function isSameDay(a: DateInput, b: DateInput): boolean {
  const first = toDate(a);
  const second = toDate(b);
  return (
    first !== null &&
    second !== null &&
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  );
}`,
      `import { describe, expect, it } from "vitest";
import { addDays, formatDate, formatRelativeTime, isSameDay, isValidDate, toDate, toISODateString } from "./date";

describe("date utils", () => {
  it("parses valid input and rejects invalid input", () => {
    expect(toDate("2024-03-15T12:00:00Z")?.toISOString()).toBe("2024-03-15T12:00:00.000Z");
    expect(toDate("not a date")).toBeNull();
    expect(toDate(null)).toBeNull();
    expect(isValidDate("2024-03-15")).toBe(true);
    expect(isValidDate({})).toBe(false);
  });

  it("formats dates with Intl", () => {
    expect(formatDate("2024-03-15T12:00:00Z", { dateStyle: "medium", timeZone: "UTC" }, "en-US")).toBe("Mar 15, 2024");
    expect(formatDate("invalid")).toBe("");
    expect(toISODateString("2024-03-15T23:30:00Z")).toBe("2024-03-15");
  });

  it("formats relative time", () => {
    const now = new Date("2024-03-15T12:00:00Z");
    expect(formatRelativeTime(new Date("2024-03-14T12:00:00Z"), now, "en-US")).toBe("yesterday");
    expect(formatRelativeTime(new Date("2024-03-15T15:00:00Z"), now, "en-US")).toBe("in 3 hours");
  });

  it("adds days and compares calendar days", () => {
    const start = new Date(2024, 0, 31, 10);
    expect(addDays(start, 1)?.getDate()).toBe(1);
    expect(isSameDay(new Date(2024, 2, 15, 1), new Date(2024, 2, 15, 23))).toBe(true);
    expect(isSameDay(new Date(2024, 2, 15), new Date(2024, 2, 16))).toBe(false);
  });
});`,
    ],
    number: [
      `import { DEFAULT_LOCALE } from "@/shared/constants/locale";

const formatterCache = new Map<string, Intl.NumberFormat>();

/** Cached Intl.NumberFormat — creating formatters is expensive. */
export function getNumberFormatter(locale: string = DEFAULT_LOCALE, options: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  const key = \`\${locale}|\${JSON.stringify(options)}\`;
  let formatter = formatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, options);
    formatterCache.set(key, formatter);
  }
  return formatter;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions, locale: string = DEFAULT_LOCALE): string {
  return isFiniteNumber(value) ? getNumberFormatter(locale, options).format(value) : "";
}

/** 1500 → "1.5K" */
export function formatCompactNumber(value: number, locale: string = DEFAULT_LOCALE): string {
  return formatNumber(value, { notation: "compact", maximumFractionDigits: 1 }, locale);
}

/** 0.256 → "25.6%" (input is a ratio). */
export function formatPercent(ratio: number, fractionDigits = 0, locale: string = DEFAULT_LOCALE): string {
  return formatNumber(
    ratio,
    { style: "percent", minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits },
    locale,
  );
}

export function clamp(value: number, min: number, max: number): number {
  if (min > max) throw new RangeError("clamp: min must be less than or equal to max");
  return Math.min(Math.max(value, min), max);
}

/** Rounds half away from zero and absorbs floating point noise (1.005 → 1.01). */
export function roundHalfAwayFromZero(value: number): number {
  const corrected = Number(value.toFixed(8));
  return Math.sign(corrected) * Math.round(Math.abs(corrected)) || 0;
}

export function roundTo(value: number, decimals = 0): number {
  const factor = 10 ** decimals;
  return roundHalfAwayFromZero(value * factor) / factor;
}

/** Parses "1,234.5", " 42 " or 7 into a number; returns null for anything else. */
export function parseNumber(input: unknown): number | null {
  if (typeof input === "number") return Number.isFinite(input) ? input : null;
  if (typeof input !== "string" || input.trim() === "") return null;
  const value = Number(input.trim().replace(/[,_\\s]/g, ""));
  return Number.isFinite(value) ? value : null;
}`,
      `import { describe, expect, it } from "vitest";
import { clamp, formatCompactNumber, formatNumber, formatPercent, parseNumber, roundTo } from "./number";

describe("number utils", () => {
  it("formats numbers", () => {
    expect(formatNumber(1234567.891, { maximumFractionDigits: 2 }, "en-US")).toBe("1,234,567.89");
    expect(formatNumber(Number.NaN)).toBe("");
    expect(formatCompactNumber(1500, "en-US")).toBe("1.5K");
    expect(formatPercent(0.256, 1, "en-US")).toBe("25.6%");
  });

  it("clamps and rounds", () => {
    expect(clamp(15, 0, 10)).toBe(10);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(() => clamp(1, 10, 0)).toThrow(RangeError);
    expect(roundTo(1.005, 2)).toBe(1.01);
    expect(roundTo(-1.005, 2)).toBe(-1.01);
  });

  it("parses numbers safely", () => {
    expect(parseNumber("1,234.5")).toBe(1234.5);
    expect(parseNumber(" 42 ")).toBe(42);
    expect(parseNumber("abc")).toBeNull();
    expect(parseNumber("")).toBeNull();
    expect(parseNumber(Number.POSITIVE_INFINITY)).toBeNull();
  });
});`,
    ],
    currency: [
      `import { DEFAULT_CURRENCY, DEFAULT_LOCALE } from "@/shared/constants/locale";
import { getNumberFormatter, isFiniteNumber, roundHalfAwayFromZero } from "./number";

/** Minor-unit digits for a currency: USD → 2, JPY → 0, KWD → 3. */
export function getCurrencyFractionDigits(currency: string = DEFAULT_CURRENCY): number {
  return getNumberFormatter("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

export function formatCurrency(
  amount: number,
  currency: string = DEFAULT_CURRENCY,
  locale: string = DEFAULT_LOCALE,
  options: Intl.NumberFormatOptions = {},
): string {
  if (!isFiniteNumber(amount)) return "";
  return getNumberFormatter(locale, { style: "currency", currency, ...options }).format(amount);
}

/** 19.99 USD → 1999. Store money as integer minor units to avoid float errors. */
export function toMinorUnits(amount: number, currency: string = DEFAULT_CURRENCY): number {
  return roundHalfAwayFromZero(amount * 10 ** getCurrencyFractionDigits(currency));
}

/** 1999 → 19.99 (USD) */
export function fromMinorUnits(minorUnits: number, currency: string = DEFAULT_CURRENCY): number {
  return minorUnits / 10 ** getCurrencyFractionDigits(currency);
}

export function formatMinorUnits(
  minorUnits: number,
  currency: string = DEFAULT_CURRENCY,
  locale: string = DEFAULT_LOCALE,
): string {
  return formatCurrency(fromMinorUnits(minorUnits, currency), currency, locale);
}`,
      `import { describe, expect, it } from "vitest";
import { formatCurrency, formatMinorUnits, fromMinorUnits, getCurrencyFractionDigits, toMinorUnits } from "./currency";

describe("currency utils", () => {
  it("formats with Intl", () => {
    expect(formatCurrency(1234.5, "USD", "en-US")).toBe("$1,234.50");
    expect(formatCurrency(Number.NaN)).toBe("");
    expect(formatMinorUnits(1999, "EUR", "de-DE")).toMatch(/19,99/);
  });

  it("converts minor units per currency", () => {
    expect(getCurrencyFractionDigits("USD")).toBe(2);
    expect(getCurrencyFractionDigits("JPY")).toBe(0);
    expect(toMinorUnits(19.99, "USD")).toBe(1999);
    expect(toMinorUnits(1.005, "USD")).toBe(101);
    expect(toMinorUnits(500, "JPY")).toBe(500);
    expect(fromMinorUnits(1999, "USD")).toBe(19.99);
  });
});`,
    ],
    string: [
      `function words(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^\\p{L}\\p{N}]+/u)
    .filter(Boolean);
}

export function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === "";
}

export function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** "hELLO wORLD" → "Hello World" */
export function toTitleCase(value: string): string {
  return value
    .toLowerCase()
    .split(/(\\s+)/)
    .map((part) => capitalize(part))
    .join("");
}

/** Shortens text to maxLength characters including the suffix. */
export function truncate(value: string, maxLength: number, suffix = "…"): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= suffix.length) return suffix.slice(0, Math.max(0, maxLength));
  return value.slice(0, maxLength - suffix.length).trimEnd() + suffix;
}

/** "Héllo Wörld! 2024" → "hello-world-2024" */
export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\\u0300-\\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function toKebabCase(value: string): string {
  return words(value).map((word) => word.toLowerCase()).join("-");
}

export function toCamelCase(value: string): string {
  return words(value)
    .map((word, index) => (index === 0 ? word.toLowerCase() : capitalize(word.toLowerCase())))
    .join("");
}

/** "Ada Lovelace" → "AL" */
export function getInitials(name: string, max = 2): string {
  return words(name)
    .slice(0, max)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");
}

export function pluralize(count: number, singular: string, plural = \`\${singular}s\`): string {
  return count === 1 ? singular : plural;
}`,
      `import { describe, expect, it } from "vitest";
import { capitalize, getInitials, isBlank, pluralize, slugify, toCamelCase, toKebabCase, toTitleCase, truncate } from "./string";

describe("string utils", () => {
  it("handles casing", () => {
    expect(capitalize("hello")).toBe("Hello");
    expect(toTitleCase("hELLO wORLD")).toBe("Hello World");
    expect(toKebabCase("userProfileSettings")).toBe("user-profile-settings");
    expect(toCamelCase("user-profile settings")).toBe("userProfileSettings");
  });

  it("truncates, slugifies and checks blanks", () => {
    expect(truncate("Hello world", 8)).toBe("Hello w…");
    expect(truncate("Hi", 8)).toBe("Hi");
    expect(slugify("Héllo Wörld! 2024")).toBe("hello-world-2024");
    expect(isBlank("  ")).toBe(true);
    expect(isBlank("a")).toBe(false);
  });

  it("builds initials and plurals", () => {
    expect(getInitials("Ada Lovelace")).toBe("AL");
    expect(pluralize(1, "item")).toBe("item");
    expect(pluralize(2, "item")).toBe("items");
    expect(pluralize(2, "person", "people")).toBe("people");
  });
});`,
    ],
    validation: [
      `import type { z } from "zod";

export type FieldErrors = Record<string, string[]>;

export type ValidationResult<T> = { success: true; data: T } | { success: false; errors: FieldErrors };

/** Flattens Zod issues into { "field.path": ["message"] }; root-level issues use "_root". */
export function toFieldErrors(error: z.ZodError): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join(".") || "_root";
    (errors[key] ??= []).push(issue.message);
  }
  return errors;
}

/** Validates untrusted input (form data, request bodies, search params) against a schema. */
export function validate<T>(schema: z.ZodType<T>, input: unknown): ValidationResult<T> {
  const result = schema.safeParse(input);
  return result.success ? { success: true, data: result.data } : { success: false, errors: toFieldErrors(result.error) };
}

const EMAIL_PATTERN = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Only allows the given protocols, which blocks "javascript:" and similar URLs. */
export function isUrl(value: string, protocols: readonly string[] = ["http:", "https:"]): boolean {
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}`,
      `import { z } from "zod";
import { describe, expect, it } from "vitest";
import { isEmail, isUrl, isUuid, validate } from "./validation";

describe("validation utils", () => {
  const schema = z.object({ name: z.string().min(1, "Required"), tags: z.array(z.string()) });

  it("returns typed data on success", () => {
    expect(validate(schema, { name: "Ada", tags: [] })).toEqual({ success: true, data: { name: "Ada", tags: [] } });
  });

  it("returns field errors on failure", () => {
    const result = validate(schema, { name: "", tags: [1] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.name).toEqual(["Required"]);
      expect(result.errors["tags.0"]).toHaveLength(1);
    }
  });

  it("checks common formats", () => {
    expect(isEmail("ada@example.com")).toBe(true);
    expect(isEmail("ada@")).toBe(false);
    expect(isUrl("https://example.com")).toBe(true);
    expect(isUrl("javascript:alert(1)")).toBe(false);
    expect(isUuid("3f2504e0-4f89-41d3-9a0c-0305e82c3301")).toBe(true);
    expect(isUuid("123")).toBe(false);
  });
});`,
    ],
    json: [
      `import type { z } from "zod";
import type { Result } from "@/shared/types/common";

/** JSON.parse that never throws. */
export function safeJsonParse<T = unknown>(text: string | null | undefined): Result<T> {
  if (typeof text !== "string") return { ok: false, error: new TypeError("Expected a JSON string") };
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

/** Parses JSON and validates the shape — use for localStorage, query strings and other untrusted JSON. */
export function safeJsonParseWith<T>(text: string | null | undefined, schema: z.ZodType<T>): Result<T> {
  const parsed = safeJsonParse(text);
  if (!parsed.ok) return parsed;
  const result = schema.safeParse(parsed.value);
  return result.success ? { ok: true, value: result.data } : { ok: false, error: new Error(result.error.message) };
}

/** JSON.stringify that never throws (circular references, BigInt). */
export function safeJsonStringify(value: unknown, space?: number): Result<string> {
  try {
    const text = JSON.stringify(value, null, space);
    return text === undefined ? { ok: false, error: new TypeError("Value is not serializable") } : { ok: true, value: text };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}`,
      `import { z } from "zod";
import { describe, expect, it } from "vitest";
import { safeJsonParse, safeJsonParseWith, safeJsonStringify } from "./json";

describe("json utils", () => {
  it("parses valid JSON and reports invalid JSON", () => {
    expect(safeJsonParse('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(safeJsonParse("{oops").ok).toBe(false);
    expect(safeJsonParse(null).ok).toBe(false);
  });

  it("validates parsed JSON against a schema", () => {
    const schema = z.object({ a: z.number() });
    expect(safeJsonParseWith('{"a":1}', schema)).toEqual({ ok: true, value: { a: 1 } });
    expect(safeJsonParseWith('{"a":"1"}', schema).ok).toBe(false);
  });

  it("stringifies without throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(safeJsonStringify({ a: 1 })).toEqual({ ok: true, value: '{"a":1}' });
    expect(safeJsonStringify(circular).ok).toBe(false);
    expect(safeJsonStringify(undefined).ok).toBe(false);
  });
});`,
    ],
    debounce: [
      `export interface DebouncedFunction<Args extends unknown[]> {
  (...args: Args): void;
  /** Drops the pending call. */
  cancel: () => void;
  /** Runs the pending call immediately. */
  flush: () => void;
  pending: () => boolean;
}

/** Delays \`fn\` until \`waitMs\` have passed without another call. Uses the latest arguments. */
export function debounce<Args extends unknown[]>(fn: (...args: Args) => void, waitMs: number): DebouncedFunction<Args> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastArgs: Args | undefined;

  const invoke = () => {
    timer = undefined;
    if (lastArgs) {
      const args = lastArgs;
      lastArgs = undefined;
      fn(...args);
    }
  };

  const debounced = (...args: Args) => {
    lastArgs = args;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(invoke, waitMs);
  };

  return Object.assign(debounced, {
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      lastArgs = undefined;
    },
    flush: () => {
      if (timer === undefined) return;
      clearTimeout(timer);
      invoke();
    },
    pending: () => timer !== undefined,
  });
}`,
      `import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debounce } from "./debounce";

describe("debounce", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("calls once with the latest arguments", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);
    debounced("a");
    debounced("b");
    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledExactlyOnceWith("b");
  });

  it("supports cancel and flush", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);
    debounced(1);
    debounced.cancel();
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();

    debounced(2);
    expect(debounced.pending()).toBe(true);
    debounced.flush();
    expect(fn).toHaveBeenCalledExactlyOnceWith(2);
    expect(debounced.pending()).toBe(false);
  });
});`,
    ],
    file: [
      `export type FileLike = Pick<File, "name" | "size" | "type">;

export interface FileValidationOptions {
  /** Maximum size in bytes. */
  maxSizeBytes?: number;
  /** Mime types, wildcards or extensions: ["image/*", "application/pdf", ".csv"]. */
  accept?: readonly string[];
  allowEmpty?: boolean;
}

export type FileValidationError = "EMPTY_FILE" | "FILE_TOO_LARGE" | "INVALID_TYPE";

export type FileValidationResult = { valid: true } | { valid: false; error: FileValidationError; message: string };

/** "archive.tar.gz" → "gz"; files without an extension (or dotfiles) → "". */
export function getFileExtension(fileName: string): string {
  const index = fileName.lastIndexOf(".");
  return index > 0 ? fileName.slice(index + 1).toLowerCase() : "";
}

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** 1536 → "1.5 KB" */
export function formatFileSize(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), SIZE_UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  return \`\${exponent === 0 ? value : Number(value.toFixed(decimals))} \${SIZE_UNITS[exponent]}\`;
}

export function matchesAccept(file: FileLike, accept: readonly string[]): boolean {
  const mime = file.type.toLowerCase();
  const extension = getFileExtension(file.name);
  return accept.some((rule) => {
    const normalized = rule.trim().toLowerCase();
    if (normalized.startsWith(".")) return normalized.slice(1) === extension;
    if (normalized.endsWith("/*")) return mime.startsWith(normalized.slice(0, -1));
    return normalized === mime;
  });
}

/**
 * Client-side checks improve UX only. Always re-validate uploads on the server — the browser-reported
 * mime type can be spoofed.
 */
export function validateFile(file: FileLike, options: FileValidationOptions = {}): FileValidationResult {
  const { maxSizeBytes, accept, allowEmpty = false } = options;
  if (!allowEmpty && file.size === 0) {
    return { valid: false, error: "EMPTY_FILE", message: "The file is empty." };
  }
  if (maxSizeBytes !== undefined && file.size > maxSizeBytes) {
    return { valid: false, error: "FILE_TOO_LARGE", message: \`The file must be smaller than \${formatFileSize(maxSizeBytes)}.\` };
  }
  if (accept && accept.length > 0 && !matchesAccept(file, accept)) {
    return { valid: false, error: "INVALID_TYPE", message: \`Allowed file types: \${accept.join(", ")}.\` };
  }
  return { valid: true };
}`,
      `import { describe, expect, it } from "vitest";
import { formatFileSize, getFileExtension, validateFile } from "./file";

const png = { name: "photo.PNG", size: 2048, type: "image/png" };

describe("file utils", () => {
  it("reads extensions and formats sizes", () => {
    expect(getFileExtension("archive.tar.gz")).toBe("gz");
    expect(getFileExtension(".env")).toBe("");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(0)).toBe("0 B");
  });

  it("validates size and type", () => {
    expect(validateFile(png, { accept: ["image/*"], maxSizeBytes: 4096 })).toEqual({ valid: true });
    expect(validateFile(png, { accept: [".png"] })).toEqual({ valid: true });
    expect(validateFile(png, { maxSizeBytes: 1024 })).toMatchObject({ valid: false, error: "FILE_TOO_LARGE" });
    expect(validateFile(png, { accept: ["application/pdf", ".csv"] })).toMatchObject({ valid: false, error: "INVALID_TYPE" });
    expect(validateFile({ ...png, size: 0 })).toMatchObject({ valid: false, error: "EMPTY_FILE" });
  });
});`,
    ],
    "query-params": [
      `export type QueryPrimitive = string | number | boolean | null | undefined;
export type QueryParamsInput = Record<string, QueryPrimitive | readonly QueryPrimitive[]>;
/** Shape of Next.js \`searchParams\` in pages and layouts. */
export type SearchParamsRecord = Record<string, string | string[] | undefined>;

const isPresent = (value: QueryPrimitive): value is string | number | boolean =>
  value !== null && value !== undefined && value !== "";

/** { q: "shoes", tags: ["a", "b"], page: null } → "q=shoes&tags=a&tags=b" (empty values are dropped). */
export function buildQueryString(params: QueryParamsInput): string {
  const search = new URLSearchParams();
  for (const [key, raw] of Object.entries(params)) {
    const values: readonly QueryPrimitive[] = Array.isArray(raw) ? raw : [raw as QueryPrimitive];
    for (const value of values) if (isPresent(value)) search.append(key, String(value));
  }
  return search.toString();
}

/** "/products" + { page: 2 } → "/products?page=2" */
export function withQueryString(path: string, params: QueryParamsInput): string {
  const query = buildQueryString(params);
  return query ? \`\${path}\${path.includes("?") ? "&" : "?"}\${query}\` : path;
}

export function parseQueryString(search: string | URLSearchParams): Record<string, string | string[]> {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const result: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    result[key] = values.length > 1 ? values : (values[0] ?? "");
  }
  return result;
}

/** Applies updates to the current query; null/undefined/"" removes a key. */
export function mergeQueryParams(current: string | URLSearchParams, updates: QueryParamsInput): string {
  const params = new URLSearchParams(current);
  for (const [key, raw] of Object.entries(updates)) {
    params.delete(key);
    const values: readonly QueryPrimitive[] = Array.isArray(raw) ? raw : [raw as QueryPrimitive];
    for (const value of values) if (isPresent(value)) params.append(key, String(value));
  }
  return params.toString();
}

export function getStringParam(params: SearchParamsRecord, key: string, fallback?: string): string | undefined {
  const value = params[key];
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first === "" ? fallback : first;
}

export function getNumberParam(params: SearchParamsRecord, key: string, fallback?: number): number | undefined {
  const raw = getStringParam(params, key);
  const value = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function getArrayParam(params: SearchParamsRecord, key: string): string[] {
  const value = params[key];
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).filter((item) => item !== "");
}`,
      `import { describe, expect, it } from "vitest";
import {
  buildQueryString,
  getArrayParam,
  getNumberParam,
  getStringParam,
  mergeQueryParams,
  parseQueryString,
  withQueryString,
} from "./query-params";

describe("query param utils", () => {
  it("builds query strings", () => {
    expect(buildQueryString({ q: "shoes", page: 2, tags: ["a", "b"], empty: "", none: null })).toBe("q=shoes&page=2&tags=a&tags=b");
    expect(withQueryString("/products", { page: 2 })).toBe("/products?page=2");
    expect(withQueryString("/products", {})).toBe("/products");
  });

  it("parses and merges query strings", () => {
    expect(parseQueryString("a=1&a=2&b=3")).toEqual({ a: ["1", "2"], b: "3" });
    expect(mergeQueryParams("?q=a&page=3", { page: null, sort: "asc" })).toBe("q=a&sort=asc");
  });

  it("reads Next.js searchParams safely", () => {
    const params = { q: ["x", "y"], page: "abc", size: "20", tag: "a" };
    expect(getStringParam(params, "q")).toBe("x");
    expect(getStringParam(params, "missing", "default")).toBe("default");
    expect(getNumberParam(params, "page", 1)).toBe(1);
    expect(getNumberParam(params, "size")).toBe(20);
    expect(getArrayParam(params, "tag")).toEqual(["a"]);
  });
});`,
    ],
  }),

  // ── Features ───────────────────────────────────────────────────────────────
  genericFeature: (n) => {
    const { kebab, camel, pascal, entityCamel, entityPascal, listPascal } = n;
    const tag = pascal;
    return {
      [`schemas/${kebab}.schema.ts`]: `import { z } from "zod";

export const ${entityCamel}Schema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.string(),
});

export const ${entityCamel}ListSchema = z.array(${entityCamel}Schema);

export const create${entityPascal}Schema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120, "Name is too long"),
});`,

      [`types/${kebab}.types.ts`]: `import type { z } from "zod";
import type { create${entityPascal}Schema, ${entityCamel}Schema } from "../schemas/${kebab}.schema";

export type ${entityPascal} = z.infer<typeof ${entityCamel}Schema>;
export type Create${entityPascal}Input = z.infer<typeof create${entityPascal}Schema>;

/** Client UI state for this feature (server data lives in RTK Query, not here). */
export interface ${pascal}State {
  selectedId: string | null;
  search: string;
}`,

      [`store/${kebab}.slice.ts`]: `import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { rootReducer } from "@/store/root-reducer";
import type { ${pascal}State } from "../types/${kebab}.types";

const initialState: ${pascal}State = {
  selectedId: null,
  search: "",
};

export const ${camel}Slice = createSlice({
  name: "${camel}",
  initialState,
  reducers: {
    ${entityCamel}Selected(state, action: PayloadAction<string | null>) {
      state.selectedId = action.payload;
    },
    ${camel}SearchChanged(state, action: PayloadAction<string>) {
      state.search = action.payload;
    },
    ${camel}Reset: () => initialState,
  },
  selectors: {
    selectSelected${entityPascal}Id: (state) => state.selectedId,
    select${pascal}Search: (state) => state.search,
  },
});

declare module "@/store/root-reducer" {
  interface LazyLoadedSlices {
    ${camel}: ${pascal}State;
  }
}

// Registers the reducer lazily — only when this feature is first imported.
export const injected${pascal}Slice = ${camel}Slice.injectInto(rootReducer);

export const { ${entityCamel}Selected, ${camel}SearchChanged, ${camel}Reset } = ${camel}Slice.actions;
export const { selectSelected${entityPascal}Id, select${pascal}Search } = injected${pascal}Slice.selectors;`,

      [`api/${kebab}.api.ts`]: `import { baseApi } from "@/store/base-api";
import type { Create${entityPascal}Input, ${entityPascal} } from "../types/${kebab}.types";

const TAG = "${tag}" as const;

export const ${camel}Api = baseApi.enhanceEndpoints({ addTagTypes: [TAG] }).injectEndpoints({
  endpoints: (build) => ({
    get${listPascal}: build.query<${entityPascal}[], void>({
      query: () => "/${kebab}",
      providesTags: (result) => [
        ...(result ?? []).map(({ id }) => ({ type: TAG, id })),
        { type: TAG, id: "LIST" },
      ],
    }),
    get${entityPascal}ById: build.query<${entityPascal}, string>({
      query: (id) => \`/${kebab}/\${encodeURIComponent(id)}\`,
      providesTags: (_result, _error, id) => [{ type: TAG, id }],
    }),
    create${entityPascal}: build.mutation<${entityPascal}, Create${entityPascal}Input>({
      query: (body) => ({ url: "/${kebab}", method: "POST", body }),
      invalidatesTags: [{ type: TAG, id: "LIST" }],
    }),
  }),
});

export const { useGet${listPascal}Query, useGet${entityPascal}ByIdQuery, useCreate${entityPascal}Mutation } = ${camel}Api;`,

      [`services/${kebab}.service.ts`]: `import "server-only";
import { getServerApiClient } from "@/infrastructure/http/server-api-client";
import { logger } from "@/infrastructure/logging/logger";
import { ${entityCamel}ListSchema } from "../schemas/${kebab}.schema";
import type { ${entityPascal} } from "../types/${kebab}.types";

/** Server-side data access for Server Components, Server Actions and Route Handlers. */
export async function get${listPascal}(): Promise<${entityPascal}[]> {
  const client = getServerApiClient();
  if (!client) {
    logger.warn("API_BASE_URL is not set — get${listPascal}() returns an empty list.");
    return [];
  }
  return client.get("/${kebab}", { schema: ${entityCamel}ListSchema });
}`,

      [`hooks/use-${kebab}-selection.ts`]: `import { useCallback } from "react";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { ${entityCamel}Selected, selectSelected${entityPascal}Id } from "../store/${kebab}.slice";

export function use${pascal}Selection() {
  const dispatch = useAppDispatch();
  const selectedId = useAppSelector(selectSelected${entityPascal}Id);
  const select = useCallback((id: string | null) => {
    dispatch(${entityCamel}Selected(id));
  }, [dispatch]);
  return { selectedId, select };
}`,

      [`components/${kebab}-list.tsx`]: `"use client";

import { Alert } from "@/shared/components/feedback/alert";
import { Spinner } from "@/shared/components/feedback/spinner";
import { Button } from "@/shared/components/ui/button";
import { cn } from "@/shared/lib/cn";
import { useGet${listPascal}Query } from "../api/${kebab}.api";
import { use${pascal}Selection } from "../hooks/use-${kebab}-selection";

export function ${pascal}List() {
  const { data: items = [], isLoading, isError, refetch } = useGet${listPascal}Query();
  const { selectedId, select } = use${pascal}Selection();

  if (isLoading) return <Spinner label="Loading ${kebab.replace(/-/g, " ")}" />;

  if (isError) {
    return (
      <Alert variant="error" title="Could not load ${kebab.replace(/-/g, " ")}">
        <Button variant="ghost" size="sm" onClick={() => void refetch()}>
          Retry
        </Button>
      </Alert>
    );
  }

  if (items.length === 0) return <p className="text-sm text-neutral-500">Nothing here yet.</p>;

  return (
    <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200">
      {items.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            aria-pressed={item.id === selectedId}
            onClick={() => select(item.id)}
            className={cn("w-full px-4 py-3 text-left text-sm hover:bg-neutral-50", item.id === selectedId && "bg-neutral-100 font-medium")}
          >
            {item.name}
          </button>
        </li>
      ))}
    </ul>
  );
}`,

      "index.ts": `// Universal public API — safe to import from Server and Client Components.
export * from "./schemas/${kebab}.schema";
export type * from "./types/${kebab}.types";`,

      "client.ts": `"use client";

// Client public API. Server Components may import components from here to render them,
// but must never call the hooks, actions or selectors.
export { ${pascal}List } from "./components/${kebab}-list";
export { use${pascal}Selection } from "./hooks/use-${kebab}-selection";
export {
  ${camel}Api,
  useGet${listPascal}Query,
  useGet${entityPascal}ByIdQuery,
  useCreate${entityPascal}Mutation,
} from "./api/${kebab}.api";
export {
  ${camel}Slice,
  ${entityCamel}Selected,
  ${camel}SearchChanged,
  ${camel}Reset,
  selectSelected${entityPascal}Id,
  select${pascal}Search,
} from "./store/${kebab}.slice";`,

      "server.ts": `import "server-only";

// Server public API — Server Components, Server Actions and Route Handlers only.
export { get${listPascal} } from "./services/${kebab}.service";`,

      [`tests/${kebab}.slice.test.ts`]: `import { describe, expect, it } from "vitest";
import { makeStore } from "@/store/store";
import {
  ${entityCamel}Selected,
  ${camel}Reset,
  ${camel}SearchChanged,
  ${camel}Slice,
  selectSelected${entityPascal}Id,
} from "../store/${kebab}.slice";

describe("${camel}Slice", () => {
  const reducer = ${camel}Slice.reducer;

  it("starts empty", () => {
    expect(reducer(undefined, { type: "@@init" })).toEqual({ selectedId: null, search: "" });
  });

  it("selects, searches and resets", () => {
    let state = reducer(undefined, ${entityCamel}Selected("1"));
    state = reducer(state, ${camel}SearchChanged("abc"));
    expect(state).toEqual({ selectedId: "1", search: "abc" });
    expect(reducer(state, ${camel}Reset())).toEqual({ selectedId: null, search: "" });
  });

  it("is lazily registered in the store", () => {
    const store = makeStore();
    store.dispatch(${entityCamel}Selected("42"));
    expect(selectSelected${entityPascal}Id(store.getState())).toBe("42");
  });
});`,

      [`tests/${kebab}.schema.test.ts`]: `import { describe, expect, it } from "vitest";
import { create${entityPascal}Schema } from "../schemas/${kebab}.schema";

describe("create${entityPascal}Schema", () => {
  it("trims and accepts a valid name", () => {
    expect(create${entityPascal}Schema.parse({ name: "  First  " })).toEqual({ name: "First" });
  });

  it("rejects an empty name", () => {
    expect(create${entityPascal}Schema.safeParse({ name: "   " }).success).toBe(false);
  });
});`,
    };
  },

  authFeature: () => ({
    "schemas/auth.schema.ts": `import { z } from "zod";
import { emailSchema } from "@/shared/schemas/common.schema";

export const userSchema = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  name: z.string().nullish(),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Password is required"),
});`,

    "types/auth.types.ts": `import type { z } from "zod";
import type { loginSchema, userSchema } from "../schemas/auth.schema";

export type User = z.infer<typeof userSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

export interface LoginResponse {
  user: User;
}

export type AuthStatus = "unknown" | "authenticated" | "unauthenticated";

export interface AuthState {
  user: User | null;
  status: AuthStatus;
}`,

    "api/auth.api.ts": `import { baseApi } from "@/store/base-api";
import type { LoginInput, LoginResponse, User } from "../types/auth.types";

const TAG = "Auth" as const;

export const authApi = baseApi.enhanceEndpoints({ addTagTypes: [TAG] }).injectEndpoints({
  endpoints: (build) => ({
    getCurrentUser: build.query<User | null, void>({
      query: () => "/auth/me",
      providesTags: [TAG],
    }),
    login: build.mutation<LoginResponse, LoginInput>({
      query: (body) => ({ url: "/auth/login", method: "POST", body }),
      invalidatesTags: [TAG],
    }),
    logout: build.mutation<void, void>({
      query: () => ({ url: "/auth/logout", method: "POST" }),
      invalidatesTags: [TAG],
    }),
  }),
});

export const { useGetCurrentUserQuery, useLoginMutation, useLogoutMutation } = authApi;`,

    "store/auth.slice.ts": `import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { rootReducer } from "@/store/root-reducer";
import { authApi } from "../api/auth.api";
import type { AuthState, User } from "../types/auth.types";

const initialState: AuthState = {
  user: null,
  status: "unknown",
};

export const authSlice = createSlice({
  name: "auth",
  initialState,
  reducers: {
    sessionStarted(state, action: PayloadAction<User>) {
      state.user = action.payload;
      state.status = "authenticated";
    },
    sessionEnded(state) {
      state.user = null;
      state.status = "unauthenticated";
    },
  },
  extraReducers: (builder) => {
    builder
      .addMatcher(authApi.endpoints.login.matchFulfilled, (state, { payload }) => {
        state.user = payload.user;
        state.status = "authenticated";
      })
      .addMatcher(authApi.endpoints.getCurrentUser.matchFulfilled, (state, { payload }) => {
        state.user = payload;
        state.status = payload ? "authenticated" : "unauthenticated";
      })
      .addMatcher(authApi.endpoints.logout.matchFulfilled, (state) => {
        state.user = null;
        state.status = "unauthenticated";
      });
  },
  selectors: {
    selectCurrentUser: (state) => state.user,
    selectAuthStatus: (state) => state.status,
    selectIsAuthenticated: (state) => state.status === "authenticated",
  },
});

declare module "@/store/root-reducer" {
  interface LazyLoadedSlices {
    auth: AuthState;
  }
}

// Registers the reducer lazily — only when this feature is first imported.
export const injectedAuthSlice = authSlice.injectInto(rootReducer);

export const { sessionStarted, sessionEnded } = authSlice.actions;
export const { selectCurrentUser, selectAuthStatus, selectIsAuthenticated } = injectedAuthSlice.selectors;`,

    "services/auth.service.ts": `import "server-only";
import { getSessionToken } from "@/infrastructure/auth/session";
import { isHttpError } from "@/infrastructure/http/http-error";
import { getServerApiClient } from "@/infrastructure/http/server-api-client";
import { userSchema } from "../schemas/auth.schema";
import type { User } from "../types/auth.types";

/** Current user for Server Components / Route Handlers, or null when signed out. */
export async function getCurrentUser(): Promise<User | null> {
  const token = await getSessionToken();
  if (!token) return null;
  const client = getServerApiClient();
  if (!client) return null;
  try {
    return await client.get("/auth/me", { schema: userSchema, cache: "no-store" });
  } catch (error) {
    if (isHttpError(error) && (error.status === 401 || error.status === 403)) return null;
    throw error;
  }
}`,

    "hooks/use-auth.ts": `import { useAppSelector } from "@/store/hooks";
import { selectAuthStatus, selectCurrentUser } from "../store/auth.slice";

export function useAuth() {
  const user = useAppSelector(selectCurrentUser);
  const status = useAppSelector(selectAuthStatus);
  return { user, status, isAuthenticated: status === "authenticated" };
}`,

    "components/login-form.tsx": `"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Alert } from "@/shared/components/feedback/alert";
import { FormField } from "@/shared/components/forms/form-field";
import { TextInput } from "@/shared/components/forms/text-input";
import { Button } from "@/shared/components/ui/button";
import { useLoginMutation } from "../api/auth.api";
import { loginSchema } from "../schemas/auth.schema";
// Registers the auth reducer so successful logins are stored.
import "../store/auth.slice";
import type { LoginInput, User } from "../types/auth.types";

export interface LoginFormProps {
  onSuccess?: (user: User) => void;
}

export function LoginForm({ onSuccess }: LoginFormProps) {
  const [login, { isLoading, isError }] = useLoginMutation();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  const onSubmit = handleSubmit(async (values) => {
    const result = await login(values);
    if (result.data) onSuccess?.(result.data.user);
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex w-full max-w-sm flex-col gap-4">
      <FormField id="email" label="Email" error={errors.email?.message}>
        <TextInput
          id="email"
          type="email"
          autoComplete="email"
          invalid={Boolean(errors.email)}
          aria-describedby={errors.email ? "email-error" : undefined}
          {...register("email")}
        />
      </FormField>
      <FormField id="password" label="Password" error={errors.password?.message}>
        <TextInput
          id="password"
          type="password"
          autoComplete="current-password"
          invalid={Boolean(errors.password)}
          aria-describedby={errors.password ? "password-error" : undefined}
          {...register("password")}
        />
      </FormField>
      {isError ? <Alert variant="error">Sign-in failed. Check your details and try again.</Alert> : null}
      <Button type="submit" isLoading={isLoading}>
        Sign in
      </Button>
    </form>
  );
}`,

    "index.ts": `// Universal public API — safe to import from Server and Client Components.
export * from "./schemas/auth.schema";
export type * from "./types/auth.types";`,

    "client.ts": `"use client";

// Client public API. Server Components may import components from here to render them,
// but must never call the hooks, actions or selectors.
export { LoginForm } from "./components/login-form";
export { useAuth } from "./hooks/use-auth";
export { authApi, useGetCurrentUserQuery, useLoginMutation, useLogoutMutation } from "./api/auth.api";
export {
  authSlice,
  sessionStarted,
  sessionEnded,
  selectCurrentUser,
  selectAuthStatus,
  selectIsAuthenticated,
} from "./store/auth.slice";`,

    "server.ts": `import "server-only";

// Server public API — Server Components, Server Actions and Route Handlers only.
export { getCurrentUser } from "./services/auth.service";`,

    "tests/auth.slice.test.ts": `import { describe, expect, it } from "vitest";
import { makeStore } from "@/store/store";
import { authSlice, selectIsAuthenticated, sessionEnded, sessionStarted } from "../store/auth.slice";

const user = { id: "1", email: "ada@example.com", name: "Ada" };

describe("authSlice", () => {
  it("starts and ends a session", () => {
    let state = authSlice.reducer(undefined, sessionStarted(user));
    expect(state).toEqual({ user, status: "authenticated" });
    state = authSlice.reducer(state, sessionEnded());
    expect(state).toEqual({ user: null, status: "unauthenticated" });
  });

  it("is lazily registered in the store", () => {
    const store = makeStore();
    expect(selectIsAuthenticated(store.getState())).toBe(false);
    store.dispatch(sessionStarted(user));
    expect(selectIsAuthenticated(store.getState())).toBe(true);
  });
});`,

    "tests/auth.schema.test.ts": `import { describe, expect, it } from "vitest";
import { loginSchema } from "../schemas/auth.schema";

describe("loginSchema", () => {
  it("normalizes the email", () => {
    expect(loginSchema.parse({ email: "  Ada@Example.com ", password: "secret" })).toEqual({
      email: "ada@example.com",
      password: "secret",
    });
  });

  it("rejects invalid input", () => {
    expect(loginSchema.safeParse({ email: "nope", password: "" }).success).toBe(false);
  });
});`,
  }),

  layeredReadme: (n) => `# ${n.pascal} — layered feature

This feature is complex enough to use explicit layers. Dependencies point inward only:
presentation → application → domain, and infrastructure implements interfaces declared in domain.

| Folder | Contains | May import |
| --- | --- | --- |
| \`domain/\` | Entities, value objects, pure business rules, repository interfaces | nothing outside domain |
| \`application/\` | Use cases that orchestrate domain logic | domain |
| \`infrastructure/\` | Repository implementations, API/DB adapters | domain, @/infrastructure |
| \`presentation/\` | Feature components and hooks | application, domain types |

The flat folders (api/, store/, services/, schemas/, types/) still hold RTK Query endpoints, the slice,
server services, Zod schemas and types. Keep public exports in index.ts, client.ts and server.ts.`,

  // ── AI coding rules ────────────────────────────────────────────────────────
  agentRules: (ctx) => {
    const s = ctx.baseDir === "." ? "" : `${ctx.baseDir}/`;
    const runScript = `${ctx.pm} run`;
    return `# Architecture & Coding Rules

These rules apply to every change in this repository. This section is managed by \`init-architecture.mjs\`;
AGENTS.md, CLAUDE.md, .cursor/rules/architecture.mdc and .github/copilot-instructions.md carry the same rules.

## Stack

Next.js App Router · TypeScript (strict) · React Server Components · Redux Toolkit + RTK Query · React Redux ·
Tailwind CSS · Zod · React Hook Form · ESLint + Prettier · Vitest + React Testing Library

## Mandatory rules

- Always analyze existing code before adding a new file. Search for an existing component, hook, util, schema or type first.
- Always reuse existing shared utilities when possible (catalog below).
- Keep business logic inside its owning feature.
- Never duplicate common functions. If two features need the same generic helper, move it to \`${s}shared/\`.
- Never create oversized page components. \`page.tsx\` / \`layout.tsx\` only fetch data and compose feature components.
- Prefer Server Components unless client interaction is needed.
- Use Redux Toolkit only for appropriate global client state.
- Use RTK Query for suitable client-side API state.
- Use local React state for local UI interactions.
- Keep server-side logic separate from browser code.
- Do not expose secrets to client components.
- Use Zod for validating untrusted input.
- Maintain strict TypeScript types.
- Avoid circular imports.
- Preserve existing project functionality.
- Write maintainable, production-quality code.

## Project structure

\`\`\`text
${s}app/              Routes only (layout, page, loading, error, route handlers). Thin.
${s}features/<name>/  Business features — components, hooks, store, api, services, schemas, types, utils, tests
${s}shared/           Generic, business-agnostic code reused by 2+ features (components, hooks, utils, schemas, types, lib, constants)
${s}store/            Redux store factory, root reducer, typed hooks, RTK Query base API, StoreProvider
${s}infrastructure/   External systems: http, auth (session cookies), database, storage, logging
${s}config/           env.ts (server env), public-env.ts (browser env), routes.ts, site.ts
${s}test/             Vitest setup and test helpers
\`\`\`

Where does new code go?
- Used by one feature → inside that feature.
- Generic and used by 2+ features → \`${s}shared/\`.
- Talks to an external system → \`${s}infrastructure/\`.
- Environment, routes, site metadata → \`${s}config/\`.

## Feature boundaries

Every feature exposes three entry points; other code imports only these:
- \`@/features/<name>\` (\`index.ts\`) — schemas and types. Safe everywhere.
- \`@/features/<name>/client\` (\`client.ts\`, "use client") — components, hooks, RTK Query hooks, slice actions and selectors.
  Server Components may import components from it to render them, never call its hooks or actions.
- \`@/features/<name>/server\` (\`server.ts\`, \`server-only\`) — services for Server Components, Server Actions and Route Handlers.

Rules:
- Never deep-import another feature's internals (ESLint enforces this via \`eslint.architecture.mjs\`).
- Use relative imports inside a feature; use \`@/\` imports across folders.
- \`shared/\`, \`store/\`, \`infrastructure/\` and \`config/\` must never import from \`features/\`.
- Features should not depend on each other. If unavoidable, use public entry points only and never create a cycle.
- Generate new features with \`node init-architecture.mjs --feature <name>\` instead of hand-writing the scaffold.
- Simple features stay flat. Only features with real domain rules use \`--layered\` (domain/application/infrastructure/presentation). Do not add layers or abstractions speculatively.

## State management

- Data needed to render a page → fetch in a Server Component through the feature's \`server.ts\`. No Redux needed.
- Client-side server state (mutations, client-fetched or polled data) → RTK Query endpoints injected into \`baseApi\`
  with \`baseApi.enhanceEndpoints({ addTagTypes }).injectEndpoints(...)\` inside \`features/<name>/api/\`.
- Global client state shared by distant components (session, preferences) → a slice in \`features/<name>/store/\`,
  registered lazily with \`slice.injectInto(rootReducer)\` plus \`LazyLoadedSlices\` module augmentation. Never edit \`store.ts\` to add a feature.
- Local UI state (open/closed, hover, input drafts) → \`useState\` / \`useReducer\`. Forms → React Hook Form + \`zodResolver\`.
- The store is created per request (\`useState(() => makeStore())\` in \`StoreProvider\`). Never create a module-level store, and never import \`@/store/*\` into Server Components.
- Use \`useAppDispatch\`, \`useAppSelector\` and \`useAppStore\` from \`@/store/hooks\`, not the raw react-redux hooks.

## Server and client code

- Components are Server Components by default. Put "use client" on the smallest leaf that needs state, effects, event handlers or browser APIs.
- Server-only modules start with \`import "server-only"\` (\`config/env.ts\`, \`infrastructure/auth\`, \`infrastructure/http/server-api-client.ts\`, feature services, \`server.ts\`).
- Secrets live in \`@/config/env\` (server only) and are never prefixed \`NEXT_PUBLIC_\` or passed as props to Client Components.
  Browser-safe values come from \`@/config/public-env\`.
- Validate every untrusted input with Zod: request bodies, form data, search params, cookies, external API responses, env vars.
- Client-side validation is for UX only — always re-validate on the server.
- If \`cacheComponents\` is enabled, wrap request-time data (cookies, headers, uncached fetches) in \`<Suspense>\`
  or cache it with \`"use cache"\`; never read \`new Date()\` / \`Math.random()\` during prerender.

## Shared utilities — reuse, do not reimplement

| Module | Exports |
| --- | --- |
| \`@/shared/utils/date\` | toDate, isValidDate, formatDate, formatDateTime, formatRelativeTime, toISODateString, addDays, isSameDay |
| \`@/shared/utils/currency\` | formatCurrency, toMinorUnits, fromMinorUnits, formatMinorUnits, getCurrencyFractionDigits |
| \`@/shared/utils/number\` | formatNumber, formatCompactNumber, formatPercent, clamp, roundTo, parseNumber, isFiniteNumber |
| \`@/shared/utils/string\` | isBlank, capitalize, toTitleCase, truncate, slugify, toKebabCase, toCamelCase, getInitials, pluralize |
| \`@/shared/utils/validation\` | validate, toFieldErrors, isEmail, isUrl, isUuid |
| \`@/shared/utils/json\` | safeJsonParse, safeJsonParseWith, safeJsonStringify |
| \`@/shared/utils/debounce\` | debounce (with cancel / flush / pending) |
| \`@/shared/utils/file\` | validateFile, matchesAccept, formatFileSize, getFileExtension |
| \`@/shared/utils/query-params\` | buildQueryString, withQueryString, parseQueryString, mergeQueryParams, getStringParam, getNumberParam, getArrayParam |
| \`@/shared/hooks/use-debounced-value\` | useDebouncedValue |
| \`@/shared/lib/cn\` | cn (class name joiner) |
| \`@/shared/schemas/common.schema\` | idSchema, emailSchema, passwordSchema, paginationSchema |
| \`@/shared/components/...\` | ui/Button, forms/FormField, forms/TextInput, layout/Container, feedback/Spinner, feedback/Alert |
| \`@/infrastructure/http/http-client\` | createHttpClient (timeouts, JSON, Zod response validation), HttpError |
| \`@/infrastructure/logging/logger\` | logger.debug/info/warn/error |

Keep shared utilities small, typed, pure and tested. One concern per file; no "helpers.ts" grab-bags.

## Components

- Split a component when it grows past ~150 lines or handles more than one concern.
- Shared UI primitives live in \`${s}shared/components/{ui,forms,layout,feedback}\`; feature-specific UI stays in the feature.
- Style with Tailwind classes; merge classes with \`cn()\`.
- Accessible by default: labels for inputs, semantic elements, keyboard support.

## TypeScript

- No \`any\` (use \`unknown\` and narrow, or Zod), no \`@ts-ignore\`, no non-null assertions to silence errors.
- Derive types from Zod schemas with \`z.infer\` instead of duplicating them.
- Export explicit types for public APIs.

## Naming

- Files and folders: kebab-case. Components: PascalCase. Hooks: \`use-*.ts\` exporting \`useX\`.
- Feature files: \`<feature>.slice.ts\`, \`<feature>.api.ts\`, \`<feature>.service.ts\`, \`<feature>.schema.ts\`, \`<feature>.types.ts\`.

## Testing

- Vitest + React Testing Library. Tests are \`*.test.ts(x)\` next to the code or in \`features/<name>/tests/\`.
- Use \`renderWithStore\` from \`@/test/render\` for components that need Redux.
- Every new shared utility and every reducer gets tests.

## Before finishing a task

Run \`${runScript} typecheck\`, \`${runScript} lint\` and \`${runScript} test\` — all must pass.`;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  if (options.version) {
    console.log(GENERATOR_VERSION);
    return;
  }

  let root = options.cwd;
  let isNewProject = false;
  if (options.create) {
    const created = createProject(options);
    if (!created) {
      console.log(color.yellow("\nDry run: the project would be created, then initialized. Nothing was written."));
      return;
    }
    root = created.root;
    options.pm ??= created.pm;
    isNewProject = true;
  }

  const ctx = createContext(root, options);
  ctx.isNewProject = isNewProject;

  if (options.create || options.features.length === 0) {
    initArchitecture(ctx);
  } else {
    for (const feature of options.features) generateFeature(ctx, feature, options);
    formatCreatedFiles(ctx);
  }

  printReport(ctx);
}

try {
  main();
} catch (error) {
  if (error instanceof CliError) {
    console.error(`\n${color.red("✗")} ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
