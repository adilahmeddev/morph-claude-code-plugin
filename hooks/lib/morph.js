import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { CompactClient } from "@morphllm/morphsdk";

// Keep the SDK timeout comfortably below the PreCompact hook timeout set in
// hooks.json so the catch block in pre-compact.js always gets to run.
const COMPACT_TIMEOUT = parseInt(process.env.MORPH_COMPACT_TIMEOUT || "60000", 10);
const COMPACT_PRESERVE_RECENT = parseInt(
  process.env.MORPH_COMPACT_PRESERVE_RECENT || "1",
  10,
);
const COMPACT_RATIO = parseFloat(process.env.MORPH_COMPACT_RATIO || "0.3");

// Upper bound on the summary handed back to Claude Code. Hook output above a
// few tens of KB is not inlined into the session: Claude Code writes it to a
// file and shows a 2KB preview, which defeats the purpose. 40K chars is
// roughly 10K tokens, in line with what native compaction produces.
export const MAX_CONTEXT_CHARS = parseInt(process.env.MORPH_COMPACT_MAX_CONTEXT_CHARS || "40000", 10);

// homedir() is %USERPROFILE% on Windows, matching what `~` resolves to in the
// install skill.
export const MORPH_STATE_DIR = join(homedir(), ".claude", "morph");
const ENV_FILE = join(MORPH_STATE_DIR, ".env");

function loadApiKey() {
  const envKey = process.env.MORPH_API_KEY;
  if (envKey) return envKey.trim();

  try {
    // Strip a UTF-8 BOM (PowerShell / Notepad can add one) and accept CRLF.
    const text = readFileSync(ENV_FILE, "utf-8").replace(/^﻿/, "");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?MORPH_API_KEY\s*=\s*(.+?)\s*$/);
      if (m && m[1]) return m[1].replace(/^["']|["']$/g, "");
    }
  } catch {}

  throw new Error(
    "Morph API key not found. Run /morph-compact:install to configure it, " +
    "or set MORPH_API_KEY environment variable.",
  );
}

let client;
function getClient() {
  // Lazy so a missing key surfaces inside the caller's try/catch and is
  // written to the state file, instead of throwing at module load.
  if (!client) {
    client = new CompactClient({
      timeout: COMPACT_TIMEOUT,
      morphApiKey: loadApiKey(),
    });
  }
  return client;
}

const QUERY_MESSAGES = 3;
const QUERY_CHARS = 2000;

/**
 * Pick the text to condition compaction on: the last few things the user
 * actually asked, newest first, skipping slash commands, tool results and the
 * carried-over summary. A single "yes, do that" is a poor query on its own;
 * together with the two requests before it the intent is usually clear.
 */
export function pickQuery(messages) {
  const picked = [];
  for (let i = messages.length - 1; i >= 0 && picked.length < QUERY_MESSAGES; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (m.content.startsWith("/")) continue;
    if (m.content.startsWith("[result]")) continue;
    if (m.content.startsWith("[command output]")) continue;
    if (m.content.startsWith("Summary of the conversation before")) continue;
    picked.push(m.content.slice(0, QUERY_CHARS));
  }
  if (picked.length === 0) return undefined;
  return picked.join("\n").slice(0, QUERY_CHARS);
}

/**
 * Choose the compression ratio so the output fits the context budget. The
 * configured ratio is a ceiling; on a large transcript the budget wins.
 */
export function pickRatio(inputChars) {
  if (inputChars <= 0) return COMPACT_RATIO;
  const budgetRatio = MAX_CONTEXT_CHARS / inputChars;
  return Math.min(1, Math.max(0.05, Math.min(COMPACT_RATIO, budgetRatio)));
}

/**
 * Morph drops lines and leaves a `(filtered N lines)` marker per gap, which
 * on a chatty transcript yields long runs of one-line markers and blank
 * lines. Fold each run into a single marker so the budget goes to content.
 */
export function tidy(output) {
  const out = [];
  let filtered = 0;
  let blank = false;
  const flush = () => {
    if (filtered > 0) out.push(`(filtered ${filtered} lines)`);
    filtered = 0;
  };
  for (const line of output.split("\n")) {
    const m = line.match(/^\s*\(filtered (\d+) lines?\)\s*$/);
    if (m) {
      filtered += parseInt(m[1], 10);
      continue;
    }
    if (!line.trim()) {
      blank = true;
      continue;
    }
    flush();
    if (blank && out.length) out.push("");
    blank = false;
    out.push(line);
  }
  flush();
  return out.join("\n");
}

/**
 * Compact `messages`. Returns `{ output, ratio, usage }` where `usage` is the
 * API's own accounting (tokens in/out, achieved ratio, processing time).
 */
export async function compact(messages) {
  if (messages.length === 0) {
    return { output: "Empty session - no prior context.", ratio: 1, usage: null };
  }

  const inputChars = messages.reduce((n, m) => n + m.content.length, 0);
  const ratio = pickRatio(inputChars);

  const result = await getClient().compact({
    messages,
    query: pickQuery(messages),
    compressionRatio: ratio,
    preserveRecent: COMPACT_PRESERVE_RECENT,
    includeMarkers: true,
  });

  return { output: tidy(result.output), ratio, usage: result.usage ?? null };
}
