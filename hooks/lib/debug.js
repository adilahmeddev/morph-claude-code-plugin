import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { STATE_DIR, log } from "./state.js";

// Debug mode is gated on MORPH_COMPACT_DEBUG (any value other than empty,
// "0" or "false"). When enabled, each hook persists its raw stdin, the data
// it exchanged with the Morph API, and the context it handed back to Claude
// Code, so a bad summary can be reproduced and inspected after the fact.
//
// Files land in MORPH_COMPACT_DEBUG_DIR, or <tmp>/compact-hook/debug by
// default, under one folder per session:
//
//   precompact-input.json        hook stdin (session_id, transcript_path, ...)
//   precompact-messages.json     parsed transcript sent to the Morph API
//   precompact-summary.txt       summary returned by the Morph API
//   precompact-error.txt         error message, when compaction failed
//   sessionstart-input.json      hook stdin
//   sessionstart-context.txt     additionalContext injected into the session

const raw = (process.env.MORPH_COMPACT_DEBUG || "").trim().toLowerCase();
export const DEBUG = raw !== "" && raw !== "0" && raw !== "false";

const DEBUG_ROOT = process.env.MORPH_COMPACT_DEBUG_DIR || join(STATE_DIR, "debug");

function sessionDir(sessionId) {
  return join(DEBUG_ROOT, String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_"));
}

/**
 * Persist one debug artifact. No-op unless debug mode is on. Never throws:
 * a failed debug write must not break the hook it is observing.
 */
export async function debugDump(sessionId, name, data) {
  if (!DEBUG) return;
  const dir = sessionDir(sessionId);
  const file = join(dir, name);
  try {
    await mkdir(dir, { recursive: true });
    const body = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    await writeFile(file, body, "utf-8");
    log(`debug: wrote ${file}`);
  } catch (e) {
    log(`debug: failed to write ${file} — ${e.message}`);
  }
}
