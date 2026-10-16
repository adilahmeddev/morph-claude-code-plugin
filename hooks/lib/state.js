import { join } from "node:path";
import { tmpdir } from "node:os";
import { access, readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises";

export const STATE_DIR = join(tmpdir(), "compact-hook");

export function stateFile(sessionId) {
  // Session ids are UUIDs, but never trust them as raw path segments
  // (Windows rejects `:`, `*`, `?`, `<`, `>`, `|`, `"` in file names).
  return join(STATE_DIR, String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_"));
}

/**
 * Where the last summary injected into a session is kept after the state
 * file has been consumed. The next PreCompact for the same session reads it
 * and compacts only what happened since, so summaries accumulate instead of
 * re-processing the whole transcript every time.
 */
export function prevSummaryFile(sessionId) {
  return `${stateFile(sessionId)}.prev-summary.txt`;
}

/** Full, untruncated summary when it exceeded the injection budget. */
export function fullSummaryFile(sessionId) {
  return `${stateFile(sessionId)}.full-summary.txt`;
}

export async function readText(path) {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

export async function writeText(path, data) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(path, data, "utf-8");
}

export function log(msg) {
  process.stderr.write(`[morph-compact] ${msg}\n`);
}

export async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and parse a state file. Returns null when the file is missing or
 * corrupt; a corrupt file is removed so it cannot poison later hooks.
 */
export async function readState(path) {
  let raw;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw.replace(/^﻿/, ""));
  } catch (e) {
    log(`state file corrupt (${e.message}), discarding: ${path}`);
    await unlink(path).catch(() => {});
    return null;
  }
}

/**
 * Write a state file atomically (temp file + rename) so a hook that is
 * killed mid-write never leaves a half-written JSON file behind.
 */
export async function writeState(path, state) {
  await mkdir(STATE_DIR, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state), "utf-8");
  try {
    await rename(tmp, path);
  } catch (e) {
    // Windows can refuse a rename while another process holds the target
    // open (e.g. antivirus scan). Fall back to a direct write.
    await unlink(tmp).catch(() => {});
    await writeFile(path, JSON.stringify(state), "utf-8");
  }
}

export function emitContext(hookEventName, data) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName,
        additionalContext: data,
      },
    }) + "\n",
  );
}
