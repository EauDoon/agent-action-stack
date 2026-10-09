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

export function inspectDependencyDirectory(target, component, { command = exec } = {}) {
  if (!existsSync(target)) return { exists: false, target };
  const listing = lstatSync(target);
  if (listing.isSymbolicLink() || !listing.isDirectory()) {
    throw new Error(`Refusing pre-existing dependency that is not a regular directory: ${component.name}`);
  }
  if (!existsSync(join(target, ".git"))) {
    throw new Error(`Refusing pre-existing dependency without Git metadata: ${component.name}`);
  }
  const origin = command("git", ["-C", target, "config", "--get", "remote.origin.url"]);
  const head = command("git", ["-C", target, "rev-parse", "HEAD"]);
  const symbolic = command("git", ["-C", target, "symbolic-ref", "--quiet", "--short", "HEAD"]);
  const status = command("git", ["-C", target, "status", "--porcelain"]);
  if (origin.error || origin.status !== 0 || head.error || head.status !== 0 || status.error || status.status !== 0) {
    throw new Error(`Refusing unusable pre-existing dependency: ${component.name}. Remove deps/${component.name} and rerun npm run bootstrap.`);
  }
  const actualOrigin = origin.stdout.trim();
  const actualHead = head.stdout.trim();
  const clean = status.stdout.trim() === "";
  const detached = symbolic.status !== 0;
  const missing = component.expected_entrypoints.filter((entrypoint) => !existsSync(join(target, entrypoint)));
  if (normalizeRemote(actualOrigin) !== normalizeRemote(component.repository)) {
    throw new Error(`Pre-existing dependency origin does not match the lock: ${component.name}`);
  }
  if (actualHead !== component.commit) {
    throw new Error(`Pre-existing dependency commit does not match the lock: ${component.name}`);
  }
  if (!detached) {
    throw new Error(`Pre-existing dependency is not detached at the locked commit: ${component.name}`);
  }
  if (!clean) {
    throw new Error(`Pre-existing dependency has local changes: ${component.name}`);
  }
  if (missing.length > 0) {
    throw new Error(`Pre-existing dependency is missing expected entrypoints: ${component.name}`);
  }
  return {
    exists: true,
    target,
    origin: actualOrigin,
    commit: actualHead,
    detached,
    clean,
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

export function prepareDependencies({ root: projectRoot = root, deps = join(projectRoot, "deps"), components = loadComponentLock(join(projectRoot, "stack-lock.json")), nodeVersion, command = exec } = {}) {
  assertFullStackNodeVersion(nodeVersion === undefined ? {} : { version: nodeVersion });
  mkdirSync(deps, { recursive: true });
  assertDependencyDirectory(deps);
  const prepared = [];
  for (const component of components) {
    const target = join(deps, component.name);
    const existing = inspectDependencyDirectory(target, component, { command });
    if (!existing.exists) {
      cloneAtCommit(target, component, { command });
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
    prepared.push(state);
  }
  return prepared;
}

export function main(options = {}) {
  let prepared;
  try {
    prepared = prepareDependencies(options);
  } catch (error) {
    process.stderr.write(`bootstrap failed: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  for (const item of prepared) process.stdout.write(`deps/${item.target.split(/[\\/]/).pop()}: ${item.commit} detached clean\n`);
  process.stdout.write("Bootstrap complete.\n");
}

if (isEntrypoint(import.meta.url)) main();
