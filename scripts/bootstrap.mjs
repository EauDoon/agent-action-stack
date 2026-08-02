#!/usr/bin/env node
/**
 * Prepare the three public stack libraries from the reviewed component lock.
 * This script never accesses private repositories.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = join(root, "stack-lock.json");

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

function requireCommand(command, args, opts = {}) {
  const result = exec(command, args, opts);
  if (result.error || result.status !== 0) {
    const detail = result.error?.code ?? `exit ${result.status ?? "unknown"}`;
    throw new Error(`Command failed: ${command} ${args.join(" ")} (${detail})`);
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
    ["constitutional-agent-testbench", "https://github.com/oonyl/constitutional-agent-testbench.git"],
    ["consequence-rail", "https://github.com/oonyl/consequence-rail.git"],
    ["mandatebound", "https://github.com/oonyl/mandatebound.git"],
  ]);
  for (const component of value.components) {
    if (!component || typeof component !== "object" || typeof component.name !== "string" || names.has(component.name)) {
      throw new Error("Component lock contains an invalid or duplicate component.");
    }
    if (!/^https:\/\/github\.com\/oonyl\/[a-z0-9-]+\.git$/.test(component.repository)) {
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
    names.add(component.name);
  }
  if (names.size !== required.size || [...required.keys()].some((name) => !names.has(name))) {
    throw new Error("Component lock is missing a reviewed public dependency.");
  }
  return value.components;
}

export function inspectDependencyDirectory(target, component, { command = exec } = {}) {
  if (!existsSync(target)) return { exists: false, target };
  if (!existsSync(join(target, ".git"))) {
    throw new Error(`Refusing pre-existing dependency without Git metadata: ${component.name}`);
  }
  const origin = command("git", ["-C", target, "config", "--get", "remote.origin.url"]);
  const head = command("git", ["-C", target, "rev-parse", "HEAD"]);
  const symbolic = command("git", ["-C", target, "symbolic-ref", "--quiet", "--short", "HEAD"]);
  const status = command("git", ["-C", target, "status", "--porcelain"]);
  if (origin.error || origin.status !== 0 || head.error || head.status !== 0 || status.error || status.status !== 0) {
    throw new Error(`Refusing unusable pre-existing dependency: ${component.name}`);
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

function cloneAtCommit(target, component) {
  mkdirSync(dirname(target), { recursive: true });
  requireCommand("git", ["init", "--quiet", target]);
  requireCommand("git", ["-C", target, "remote", "add", "origin", component.repository]);
  requireCommand("git", ["-C", target, "fetch", "--depth", "1", "origin", component.commit]);
  requireCommand("git", ["-C", target, "checkout", "--detach", "--quiet", component.commit]);
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

function runNpm(target, args) {
  const invocation = npmInvocation(args);
  requireCommand(invocation.command, invocation.args, { cwd: target, stdio: "inherit" });
}

export function prepareDependencies({ root: projectRoot = root, deps = join(projectRoot, "deps"), components = loadComponentLock(join(projectRoot, "stack-lock.json")) } = {}) {
  mkdirSync(deps, { recursive: true });
  const prepared = [];
  for (const component of components) {
    const target = join(deps, component.name);
    const existing = inspectDependencyDirectory(target, component);
    if (!existing.exists) {
      cloneAtCommit(target, component);
    }
    inspectDependencyDirectory(target, component);
    if (component.install === "npm-ci") {
      runNpm(target, ["ci", "--ignore-scripts"]);
    }
    if (component.build === "npm-run-build") {
      runNpm(target, ["run", "build"]);
    }
    const state = inspectDependencyDirectory(target, {
      ...component,
      expected_entrypoints: [...component.expected_entrypoints, ...(component.post_build_entrypoints ?? [])],
    });
    prepared.push(state);
  }
  return prepared;
}

export function main() {
  const prepared = prepareDependencies();
  for (const item of prepared) process.stdout.write(`deps/${item.target.split(/[\\/]/).pop()}: ${item.commit} detached clean\n`);
  process.stdout.write("Bootstrap complete.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
