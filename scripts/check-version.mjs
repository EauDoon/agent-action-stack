#!/usr/bin/env node
/**
 * Release consistency check.
 *
 * `package.json` "version" is the single source of truth. This script fails
 * when package-lock.json, CHANGELOG.md, the release-readiness pin list, or an
 * optional release tag disagree with it:
 *
 *   node scripts/check-version.mjs [--tag vX.Y.Z] [--notes <file>]
 *
 * `--notes` writes the CHANGELOG section for the package version, which the
 * release workflow publishes as the GitHub Release notes.
 *
 * bin/ must never import this module: the integration proof's offline replay
 * copies only bin/aas.mjs, scripts/bootstrap.mjs, and stack-lock.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntrypoint } from "./bootstrap.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPOSITORY_URL = "https://github.com/EauDoon/agent-action-stack";
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASED_HEADING = /^\[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})$/;
const LINK_DEFINITION = /^\[([^\]]+)\]:\s+(\S+)\s*$/;
export const CHANGELOG_CATEGORIES = Object.freeze(["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"]);

export class UsageError extends Error {}

/** @returns {[number, number, number]|null} */
export function parseSemver(value) {
  const match = typeof value === "string" ? SEMVER.exec(value) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function isCalendarDate(value) {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Split a Keep a Changelog document into its H2 sections and link
 * definitions. Fenced code blocks are skipped so an example heading inside
 * one is not read as structure.
 */
export function parseChangelog(text) {
  const lines = String(text).split(/\r?\n/);
  const sections = [];
  const links = new Map();
  const stray = [];
  let current = null;
  let fenced = false;
  lines.forEach((line, index) => {
    if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) {
      if (current) current.body.push(line);
      return;
    }
    const link = LINK_DEFINITION.exec(line);
    if (link) {
      links.set(link[1], { url: link[2], line: index + 1 });
      return;
    }
    const h2 = /^## (.*)$/.exec(line);
    if (h2) {
      current = { title: h2[1].trim(), line: index + 1, headings: [], bullets: 0, body: [] };
      sections.push(current);
      return;
    }
    const h3 = /^### (.*)$/.exec(line);
    if (h3 && !current) {
      stray.push({ title: h3[1].trim(), line: index + 1 });
      return;
    }
    if (!current) return;
    if (h3) current.headings.push({ title: h3[1].trim(), line: index + 1 });
    if (/^[-*] \S/.test(line)) current.bullets += 1;
    current.body.push(line);
  });
  for (const section of sections) {
    const released = RELEASED_HEADING.exec(section.title);
    section.label = section.title === "[Unreleased]" ? "Unreleased" : released?.[1] ?? null;
    section.date = released?.[2] ?? null;
    section.text = `${section.body.join("\n").trim()}\n`;
  }
  return { sections, links, stray };
}

/** The body of one released section, ready to publish as release notes. */
export function releaseNotes(changelog, version) {
  const section = parseChangelog(changelog).sections.find((entry) => entry.label === version);
  if (!section) throw new Error(`CHANGELOG.md has no section for ${version}.`);
  return section.text;
}

/**
 * @param {{pkg: any, lock: any, changelog: string, readiness: string, stackLock: any, tag?: string|null}} inputs
 * @returns {string[]} Every inconsistency found; empty means consistent.
 */
export function checkReleaseConsistency({ pkg, lock, changelog, readiness, stackLock, tag = null }) {
  const problems = [];
  const version = pkg?.version;
  if (parseSemver(version) === null) {
    problems.push(`package.json version ${JSON.stringify(version)} is not X.Y.Z.`);
  }
  if (lock?.version !== version) {
    problems.push(`package-lock.json version ${JSON.stringify(lock?.version)} does not match package.json ${version}.`);
  }
  if (lock?.packages?.[""]?.version !== version) {
    problems.push(`package-lock.json packages[""].version ${JSON.stringify(lock?.packages?.[""]?.version)} does not match package.json ${version}.`);
  }

  const { sections, links, stray } = parseChangelog(changelog);
  for (const heading of stray) {
    problems.push(`CHANGELOG.md:${heading.line} has "### ${heading.title}" outside a version section.`);
  }
  if (sections[0]?.title !== "[Unreleased]") {
    problems.push("CHANGELOG.md must open with a \"## [Unreleased]\" section.");
  }
  const released = [];
  sections.forEach((section, index) => {
    if (index > 0) {
      if (section.date === null) {
        problems.push(`CHANGELOG.md:${section.line} "## ${section.title}" is not "## [X.Y.Z] - YYYY-MM-DD".`);
      } else if (parseSemver(section.label) === null || !isCalendarDate(section.date)) {
        problems.push(`CHANGELOG.md:${section.line} "## ${section.title}" has an invalid version or date.`);
      } else {
        released.push(section);
      }
    }
    const seen = new Set();
    for (const heading of section.headings) {
      if (!CHANGELOG_CATEGORIES.includes(heading.title)) {
        problems.push(`CHANGELOG.md:${heading.line} "### ${heading.title}" is not one of ${CHANGELOG_CATEGORIES.join(", ")}.`);
      }
      if (seen.has(heading.title)) {
        problems.push(`CHANGELOG.md:${heading.line} repeats "### ${heading.title}" inside "## ${section.title}".`);
      }
      seen.add(heading.title);
    }
  });
  for (let index = 1; index < released.length; index += 1) {
    const newer = released[index - 1];
    const older = released[index];
    if (compareSemver(newer.label, older.label) <= 0) {
      problems.push(`CHANGELOG.md:${older.line} ${older.label} must be older than ${newer.label} above it; released sections run newest first without repeats.`);
    }
  }

  // Every heading resolves to a link, and released links name their tags.
  for (const section of sections) {
    if (section.label === null) continue;
    const link = links.get(section.label);
    if (!link) {
      problems.push(`CHANGELOG.md has no [${section.label}] link definition.`);
      continue;
    }
    if (!link.url.startsWith(`${REPOSITORY_URL}/`)) {
      problems.push(`CHANGELOG.md:${link.line} [${section.label}] must link into ${REPOSITORY_URL}.`);
      continue;
    }
    const position = released.indexOf(section);
    let expected = null;
    if (section.label === "Unreleased" && released.length > 0) {
      expected = `${REPOSITORY_URL}/compare/v${released[0].label}...HEAD`;
    } else if (position >= 0) {
      const previous = released[position + 1];
      expected = previous
        ? `${REPOSITORY_URL}/compare/v${previous.label}...v${section.label}`
        : `${REPOSITORY_URL}/releases/tag/v${section.label}`;
    }
    if (expected !== null && link.url !== expected) {
      problems.push(`CHANGELOG.md:${link.line} [${section.label}] should be ${expected}.`);
    }
  }

  if (released.length > 0 && released[0].label !== version) {
    problems.push(`CHANGELOG.md newest release ${released[0].label} does not match package.json ${version}.`);
  }

  const components = Array.isArray(stackLock?.components) ? stackLock.components : [];
  if (components.length === 0) problems.push("stack-lock.json lists no components.");
  for (const component of components) {
    if (typeof component?.commit !== "string" || !String(readiness).includes(component.commit)) {
      problems.push(`docs/release-readiness.md does not list the ${component?.name ?? "unnamed"} pin ${component?.commit}.`);
    }
  }

  if (tag !== null) {
    if (tag !== `v${version}`) {
      problems.push(`Tag ${tag} does not match package.json version ${version} (expected v${version}).`);
    }
    const section = released.find((entry) => entry.label === version);
    if (!section) {
      problems.push(`CHANGELOG.md has no released "## [${version}] - YYYY-MM-DD" section for tag ${tag}.`);
    } else if (section.bullets === 0) {
      problems.push(`CHANGELOG.md section ${version} has no entries to publish.`);
    }
  }
  return problems;
}

export function loadReleaseInputs(projectRoot = root) {
  const read = (path) => readFileSync(join(projectRoot, path), "utf8");
  return {
    pkg: JSON.parse(read("package.json")),
    lock: JSON.parse(read("package-lock.json")),
    changelog: read("CHANGELOG.md"),
    readiness: read("docs/release-readiness.md"),
    stackLock: JSON.parse(read("stack-lock.json")),
  };
}

export function parseCheckArgs(args) {
  const options = { tag: null, notes: null };
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    const key = name === "--tag" ? "tag" : name === "--notes" ? "notes" : null;
    const value = args[index + 1];
    if (key === null) throw new UsageError(`Unsupported option: ${name}`);
    if (options[key] !== null) throw new UsageError(`Duplicate option: ${name}`);
    if (value === undefined || value.startsWith("--") || value.trim() === "") throw new UsageError(`Missing value for ${name}`);
    options[key] = value;
    index += 1;
  }
  return options;
}

export function main(args = process.argv.slice(2)) {
  let options;
  try {
    options = parseCheckArgs(args);
  } catch (error) {
    process.stderr.write(`${error.message}\nUsage: node scripts/check-version.mjs [--tag vX.Y.Z] [--notes <file>]\n`);
    process.exitCode = 2;
    return;
  }
  const inputs = loadReleaseInputs(root);
  const problems = checkReleaseConsistency({ ...inputs, tag: options.tag });
  if (problems.length === 0 && options.notes !== null) {
    try {
      writeFileSync(options.notes, releaseNotes(inputs.changelog, inputs.pkg.version));
    } catch (error) {
      problems.push(`Cannot write release notes: ${error.message}`);
    }
  }
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`version: ${problem}\n`);
    process.exitCode = 1;
    return;
  }
  const tagged = options.tag === null ? "" : `, tag ${options.tag}`;
  process.stdout.write(`version: ${inputs.pkg.version} consistent (package, lock, changelog, release pins${tagged})\n`);
}

if (isEntrypoint(import.meta.url)) main();
