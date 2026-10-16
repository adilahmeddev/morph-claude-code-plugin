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

export async function compact(messages) {
  if (messages.length === 0) return "Empty session - no prior context.";

  const lastUserMsg = messages.findLast((m) => m.role === "user");

  const result = await getClient().compact({
    messages,
    query: lastUserMsg?.content,
    compressionRatio: COMPACT_RATIO,
    preserveRecent: COMPACT_PRESERVE_RECENT,
    includeMarkers: true,
  });

  return result.output;
}
