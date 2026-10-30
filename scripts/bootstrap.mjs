#!/usr/bin/env node
/**
 * Prepare the three public stack libraries from the reviewed component lock.
 * This script never accesses private repositories.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = join(root, "stack-lock.json");

/**
 * True when the module at `metaUrl` is the script Node was asked to run.
 *
 * Node realpaths the main module before it builds `import.meta.url`, but
 * `process.argv[1]` keeps the path as typed. Comparing the two directly fails
 * whenever the script is reached through a link (an npm bin symlink, `npm
 * link`, a macOS /tmp checkout, a Windows junction), and the entrypoint then
 * exits 0 without running. Both sides are resolved with `realpathSync.native`
 * so Windows short names and drive-letter case compare equal too.
 *
 * @param {string} metaUrl The caller's `import.meta.url`.
 * @param {string|undefined} [argv1] The script path Node received.
 * @returns {boolean}
 */
export function isEntrypoint(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync.native(argv1) === realpathSync.native(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

/** Full-stack floor: the pinned MandateBound package declares engines >=22.12.0. */
export const MIN_FULL_STACK_NODE = Object.freeze([22, 12, 0]);

/**
 * @param {string} value
 * @returns {[number, number, number]|null}
 */
export function parseNodeVersion(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersionTuples(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

/**
 * Reject runtimes below the full-stack floor before any clone, install, or
 * build side effect. Accepts an explicit version string so callers and tests
 * can exercise the boundary without switching runtimes.
 */
export function assertFullStackNodeVersion({ version = process.versions.node } = {}) {
  const parsed = parseNodeVersion(version);
  if (parsed === null || compareVersionTuples(parsed, MIN_FULL_STACK_NODE) < 0) {
    const minimum = MIN_FULL_STACK_NODE.join(".");
    throw new Error(
      `agent-action-stack full-stack workflow requires Node.js ${minimum}+ (pinned mandatebound declares engines >=${minimum}); running on ${typeof version === "string" ? version.trim() || "an unreadable version" : "an unreadable version"}. Use Node.js ${minimum} or newer for bootstrap, demo, and GUI runs.`,
    );
  }
  return parsed;
}

/**
 * The dependency root must be a real directory. A symlink is followed by
 * checkout and provenance reads, so bootstrap and demo would use another tree.
 */
export function assertDependencyDirectory(depsDir) {
  let stat;
  try {
    stat = lstatSync(depsDir);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Dependency directory must be a regular directory.");
  }
}

function normalizeRemote(value) {
  return value.trim().replace(/\.git$/, "").replace(/\/$/, "").toLowerCase();
}

function executable(name) {
  if (process.platform === "win32" && name === "npm") return "npm.cmd";
  return name;
}

export function exec(command, args, opts = {}) {
  return spawnSync(executable(command), args, {
    encoding: "utf8",
    shell: false,
    ...opts,
  });
}

function requireCommand(command, args, opts = {}, run = exec) {
  const result = run(command, args, opts);
  if (result.error || result.status !== 0) {
    const detail = result.error?.code ?? `exit ${result.status ?? "unknown"}`;
    // Keep the tool's own explanation; "exit 128" alone does not say whether
    // the network, a path length, or permissions failed.
    const said = typeof result.stderr === "string" ? result.stderr.replace(/\s+/g, " ").trim().slice(0, 300) : "";
    throw new Error(`Command failed: ${command} ${args.join(" ")} (${detail})${said ? `: ${said}` : ""}`);
  }
  return result;
}

export function loadComponentLock(path = lockPath) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read component lock: ${error.message}`);
  }
  if (value?.schema_version !== "agent-action-stack.lock/v1" || !Array.isArray(value.components)) {
    throw new Error("Component lock has an unsupported schema.");
  }
  if (value.components.length !== 3) {
    throw new Error("Component lock must contain exactly three components.");
  }
  const names = new Set();
  const required = new Map([
    ["constitutional-agent-testbench", "https://github.com/EauDoon/constitutional-agent-testbench.git"],
    ["consequence-rail", "https://github.com/EauDoon/consequence-rail.git"],
    ["mandatebound", "https://github.com/EauDoon/mandatebound.git"],
  ]);
  for (const component of value.components) {
    if (!component || typeof component !== "object" || typeof component.name !== "string" || names.has(component.name)) {
      throw new Error("Component lock contains an invalid or duplicate component.");
    }
    if (!/^https:\/\/github\.com\/EauDoon\/[a-z0-9-]+\.git$/.test(component.repository)) {
      throw new Error(`Component ${component.name} has an invalid public repository URL.`);
    }
    if (!required.has(component.name) || component.repository !== required.get(component.name)) {
      throw new Error(`Component ${component.name} is not one of the reviewed public dependencies.`);
    }
    if (!/^[0-9a-f]{40}$/.test(component.commit)) {
      throw new Error(`Component ${component.name} has an invalid commit SHA.`);
    }
    if (!Array.isArray(component.expected_entrypoints) || component.expected_entrypoints.length === 0 || component.expected_entrypoints.some((item) => typeof item !== "string" || item.length === 0 || item.startsWith("/") || item.includes("..") || item.includes("\\"))) {
      throw new Error(`Component ${component.name} has invalid entrypoints.`);
    }
    if (component.post_build_entrypoints !== undefined && (!Array.isArray(component.post_build_entrypoints) || component.post_build_entrypoints.some((item) => typeof item !== "string" || item.length === 0 || item.startsWith("/") || item.includes("..") || item.includes("\\")))) {
      throw new Error(`Component ${component.name} has invalid post-build entrypoints.`);
    }
    // `install` and `build` are dispatched by exact string match below, so an
    // unrecognised value would skip the step and still report success.
    for (const [field, allowed] of [["install", ["npm-ci"]], ["build", ["npm-run-build"]]]) {
      if (component[field] !== undefined && !allowed.includes(component[field])) {
        throw new Error(`Component ${component.name} has an unsupported ${field} step: ${String(component[field])}`);
      }
    }
    names.add(component.name);
  }
  if (names.size !== required.size || [...required.keys()].some((name) => !names.has(name))) {
    throw new Error("Component lock is missing a reviewed public dependency.");
  }
  return value.components;
}

function shortCommit(commit) {
  return typeof commit === "string" && commit !== "" ? commit.slice(0, 7) : "unknown";
}

/**
 * Read the commit a checkout is detached at straight from `.git/HEAD`, without
 * spawning git. Returns the 40-hex SHA, or null when there is no readable Git
 * metadata (an offline verifier copy), `.git` is not a plain directory, or
 * HEAD names a branch. Never throws.
 *
 * @param {string} target
 * @returns {string|null}
 */
export function readCheckoutCommit(target) {
  try {
    const gitDir = join(target, ".git");
    const dirStat = lstatSync(gitDir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return null;
    const headPath = join(gitDir, "HEAD");
    const headStat = lstatSync(headPath);
    if (!headStat.isFile() || headStat.isSymbolicLink() || headStat.size > 4096) return null;
    const match = /^([0-9a-f]{40})\s*$/.exec(readFileSync(headPath, "utf8"));
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Classify a dependency checkout against its lock record without throwing.
 *
 * States, checked in this order: `missing` (absent), `unusable` (not a regular
 * directory, no Git metadata, or git cannot read it), `substituted` (origin
 * differs from the lock), `dirty` (local changes), `attached` (on a branch),
 * `stale` (a clean, detached, origin-matched checkout at another commit, the
 * one state `npm run bootstrap:update` repairs in place),
 * `missing-entrypoints`, and `ready`.
 *
 * @returns {{state: string, target: string, name: string, commit: string|null, locked_commit: string, origin: string|null, detached: boolean|null, clean: boolean|null, missing_entrypoints: string[], detail: string|null}}
 */
export function classifyDependency(target, component, { command = exec } = {}) {
  const base = {
    target,
    name: component.name,
    commit: null,
    locked_commit: component.commit,
    origin: null,
    detached: null,
    clean: null,
    missing_entrypoints: [],
    detail: null,
  };
  let listing;
  try {
    listing = lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT") return { ...base, state: "missing" };
    return { ...base, state: "unusable", detail: "not-readable" };
  }
  if (listing.isSymbolicLink() || !listing.isDirectory()) return { ...base, state: "unusable", detail: "not-directory" };
  if (!existsSync(join(target, ".git"))) return { ...base, state: "unusable", detail: "no-git" };
  const origin = command("git", ["-C", target, "config", "--get", "remote.origin.url"]);
  const head = command("git", ["-C", target, "rev-parse", "HEAD"]);
  const symbolic = command("git", ["-C", target, "symbolic-ref", "--quiet", "--short", "HEAD"]);
  const status = command("git", ["-C", target, "status", "--porcelain"]);
  if (origin.error || origin.status !== 0 || head.error || head.status !== 0 || status.error || status.status !== 0) {
    return { ...base, state: "unusable", detail: "git-failed" };
  }
  const observed = {
    ...base,
    origin: origin.stdout.trim(),
    commit: head.stdout.trim(),
    clean: status.stdout.trim() === "",
    detached: symbolic.status !== 0,
  };
  if (normalizeRemote(observed.origin) !== normalizeRemote(component.repository)) return { ...observed, state: "substituted" };
  if (!observed.clean) return { ...observed, state: "dirty" };
  if (!observed.detached) return { ...observed, state: "attached" };
  if (observed.commit !== component.commit) return { ...observed, state: "stale" };
  const missing = component.expected_entrypoints.filter((entrypoint) => !existsSync(join(target, entrypoint)));
  if (missing.length > 0) return { ...observed, state: "missing-entrypoints", missing_entrypoints: missing };
  return { ...observed, state: "ready" };
}

/** The refusal for a classified checkout, or null when it is usable as is. */
export function dependencyRefusal(classified) {
  const { name, state, detail } = classified;
  const remove = `Remove deps/${name} and run npm run bootstrap.`;
  switch (state) {
    case "missing":
    case "ready":
      return null;
    case "unusable":
      if (detail === "not-directory") return `Refusing pre-existing dependency that is not a regular directory: ${name}. ${remove}`;
      if (detail === "no-git") return `Refusing pre-existing dependency without Git metadata: ${name}. ${remove}`;
      return `Refusing unusable pre-existing dependency: ${name}. Remove deps/${name} and rerun npm run bootstrap.`;
    case "substituted":
      return `Pre-existing dependency origin does not match the lock: ${name}. ${remove}`;
    case "dirty":
      return `Pre-existing dependency has local changes: ${name}. ${remove}`;
    case "attached":
      return `Pre-existing dependency is not detached at the locked commit: ${name}. ${remove}`;
    case "stale":
      return `Pre-existing dependency commit does not match the lock: ${name} (checkout ${shortCommit(classified.commit)}, lock ${shortCommit(classified.locked_commit)}). Run npm run bootstrap:update to move this clean checkout to the locked commit, or remove deps/${name} and run npm run bootstrap.`;
    case "missing-entrypoints":
      return `Pre-existing dependency is missing expected entrypoints: ${name} (${classified.missing_entrypoints.join(", ")}). Run npm run bootstrap to rebuild it, or remove deps/${name} and run npm run bootstrap.`;
    default:
      return `Refusing pre-existing dependency in an unknown state: ${name}. ${remove}`;
  }
}

export function inspectDependencyDirectory(target, component, { command = exec } = {}) {
  const classified = classifyDependency(target, component, { command });
  if (classified.state === "missing") return { exists: false, target };
  const refusal = dependencyRefusal(classified);
  if (refusal !== null) throw new Error(refusal);
  return {
    exists: true,
    target,
    origin: classified.origin,
    commit: classified.commit,
    detached: classified.detached,
    clean: classified.clean,
    entrypoints: component.expected_entrypoints,
  };
}

const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * Move a finished staging checkout into place. On Windows a freshly written
 * .git can be held briefly by antivirus or the search indexer, so a rename
 * that fails with EPERM, EBUSY, or EACCES is retried up to three times.
 */
export function moveIntoPlace(staging, target, { rename = renameSync, retries = 3, delayMs = 100 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rename(staging, target);
      return;
    } catch (error) {
      if (attempt >= retries || !RENAME_RETRY_CODES.has(error?.code)) throw error;
      sleepSync(delayMs);
    }
  }
}

/**
 * Clone one component at its pinned commit. The clone is built in a hidden
 * sibling directory and moved to `target` only after checkout succeeds, so a
 * failed or interrupted fetch can never leave a half-initialized repository
 * where the next bootstrap would refuse it.
 *
 * The staging name (`.tmp-` plus six characters) is shorter than every
 * component name. Git for Windows refuses object paths over 260 characters,
 * so a longer staging path would make the clone fail in a deep checkout
 * where cloning straight into `target` succeeds.
 */
function cloneAtCommit(target, component, { command = exec } = {}) {
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, ".tmp-"));
  try {
    requireCommand("git", ["init", "--quiet", staging], {}, command);
    requireCommand("git", ["-C", staging, "remote", "add", "origin", component.repository], {}, command);
    requireCommand("git", ["-C", staging, "fetch", "--depth", "1", "origin", component.commit], {}, command);
    requireCommand("git", ["-C", staging, "checkout", "--detach", "--quiet", component.commit], {}, command);
    moveIntoPlace(staging, target);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(`Could not prepare ${component.name} at ${component.commit}: ${error.message}. Nothing was left in deps/; rerun npm run bootstrap.`);
  }
}

export function npmInvocation(args, { platform = process.platform, npmExecPath = process.env.npm_execpath, nodeExecPath = process.execPath } = {}) {
  if (platform === "win32") {
    if (!npmExecPath) {
      throw new Error("Unable to locate the npm CLI. Run bootstrap through npm run bootstrap.");
    }
    return { command: nodeExecPath, args: [npmExecPath, ...args] };
  }
  return { command: "npm", args };
}

function runNpm(target, args, command = exec) {
  const invocation = npmInvocation(args);
  requireCommand(invocation.command, invocation.args, { cwd: target, stdio: "inherit" }, command);
}

/**
 * Move a clean, detached, origin-matched checkout to the locked commit in
 * place. A failed fetch changes nothing; git's own explanation is reported.
 */
function updateCheckout(target, component, previous, { command = exec } = {}) {
  try {
    requireCommand("git", ["-C", target, "fetch", "--depth", "1", "origin", component.commit], {}, command);
    requireCommand("git", ["-C", target, "checkout", "--detach", "--quiet", component.commit], {}, command);
  } catch (error) {
    throw new Error(`Could not update ${component.name} from ${previous} to ${component.commit}: ${error.message}. deps/${component.name} was left at ${previous}.`);
  }
}

export function prepareDependencies({ root: projectRoot = root, deps = join(projectRoot, "deps"), components = loadComponentLock(join(projectRoot, "stack-lock.json")), nodeVersion, command = exec, update = false } = {}) {
  assertFullStackNodeVersion(nodeVersion === undefined ? {} : { version: nodeVersion });
  mkdirSync(deps, { recursive: true });
  assertDependencyDirectory(deps);
  const prepared = [];
  for (const component of components) {
    const target = join(deps, component.name);
    const classified = classifyDependency(target, component, { command });
    let updatedFrom = null;
    if (classified.state === "missing") {
      cloneAtCommit(target, component, { command });
    } else if (classified.state === "stale" && update) {
      updateCheckout(target, component, classified.commit, { command });
      updatedFrom = classified.commit;
    } else {
      const refusal = dependencyRefusal(classified);
      if (refusal !== null) throw new Error(refusal);
    }
    inspectDependencyDirectory(target, component, { command });
    if (component.install === "npm-ci") {
      runNpm(target, ["ci", "--ignore-scripts"], command);
    }
    if (component.build === "npm-run-build") {
      runNpm(target, ["run", "build"], command);
    }
    const state = inspectDependencyDirectory(target, {
      ...component,
      expected_entrypoints: [...component.expected_entrypoints, ...(component.post_build_entrypoints ?? [])],
    }, { command });
    prepared.push(updatedFrom === null ? state : { ...state, updated_from: updatedFrom });
  }
  return prepared;
}

export const BOOTSTRAP_USAGE = `Usage: npm run bootstrap
       npm run bootstrap:update
       node scripts/bootstrap.mjs [--update]

Prepare deps/ at the commits stack-lock.json pins: clone a missing component,
check an existing one, run npm ci --ignore-scripts and the build for
MandateBound, then verify every entrypoint.

Options:
  --update    Move a clean, detached checkout of the locked repository whose
              commit differs from the lock to the locked commit in place
              (git fetch --depth 1 origin <commit>, then a detached checkout).
              Checkouts with local changes, another origin, or a branch are
              still refused. npm run bootstrap:update passes this option.
  -h, --help  Show this help without running anything.

On Windows, run bootstrap through npm (npm run bootstrap or
npm run bootstrap:update) so it can locate the npm CLI for MandateBound.

Exit codes: 0 prepared, 1 refused or failed, 2 usage error.
`;

/**
 * Parse bootstrap arguments. Returns null for help.
 *
 * @param {string[]} argv
 * @returns {{update: boolean}|null}
 */
export function parseBootstrapArgs(argv) {
  let update = false;
  for (const token of argv) {
    if (token === "--help" || token === "-h") return null;
    if (token === "--update" && !update) update = true;
    else throw new Error(token === "--update" ? "Duplicate bootstrap option: --update" : `Unsupported bootstrap argument: ${token}`);
  }
  return { update };
}

export function main(argv = process.argv.slice(2), options = {}) {
  // The 0.3.0 signature was main(options); keep accepting it.
  if (!Array.isArray(argv)) {
    options = argv ?? {};
    argv = [];
  }
  let parsed;
  try {
    parsed = parseBootstrapArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n${BOOTSTRAP_USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (parsed === null) {
    process.stdout.write(BOOTSTRAP_USAGE);
    process.exitCode = 0;
    return;
  }
  let prepared;
  try {
    prepared = prepareDependencies({ ...options, update: parsed.update || options.update === true });
  } catch (error) {
    process.stderr.write(`bootstrap failed: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  for (const item of prepared) {
    const name = item.target.split(/[\\/]/).pop();
    const updated = item.updated_from ? ` (updated from ${item.updated_from})` : "";
    process.stdout.write(`deps/${name}: ${item.commit} detached clean${updated}\n`);
  }
  process.stdout.write("Bootstrap complete.\n");
}

if (isEntrypoint(import.meta.url)) main();
