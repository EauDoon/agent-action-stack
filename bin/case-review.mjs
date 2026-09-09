import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PATHS, isValidRunId, summarizeRun } from "./aas.mjs";

export function listCasePage({ outputRoot = DEFAULT_PATHS.outputRoot, before = null, limit = 25 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("History limit must be an integer from 1 to 50.");
  if (before !== null && (!isValidRunId(before) || before.length > 200)) throw new Error("Invalid history cursor.");
  let entries;
  try { entries = readdirSync(join(outputRoot, "runs"), { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return { cases: [], next_cursor: null, scanned: 0, unavailable: [] }; throw error; }
  const ids = entries.filter((entry) => entry.isDirectory() && isValidRunId(entry.name) && (!before || entry.name < before))
    .map((entry) => entry.name).sort().reverse();
  const candidates = ids.slice(0, limit);
  const cases = [], unavailable = [];
  for (const runId of candidates) {
    try { cases.push(summarizeRun(runId, { outputRoot })); }
    catch { unavailable.push(runId); }
  }
  return { cases, next_cursor: ids.length > limit ? candidates.at(-1) : null, scanned: candidates.length, unavailable };
}

export function parseCasePageArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--json") continue;
    if (!["--before", "--limit"].includes(key) || i + 1 >= args.length || Object.hasOwn(result, key.slice(2))) throw new Error("Usage: aas cases [--before run-id] [--limit 1..50] [--json]");
    const value = args[++i];
    if (key === "--limit" && !/^[1-9][0-9]?$/.test(value)) throw new Error("Invalid history limit.");
    result[key.slice(2)] = key === "--limit" ? Number(value) : value;
  }
  return result;
}
