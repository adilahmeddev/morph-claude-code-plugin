import { readFile } from "node:fs/promises";
import { cleanUserText, cleanToolResult, describeToolUse } from "./clean.js";

// Claude Code transcripts are JSONL with many entry types. Only `user` and
// `assistant` entries are conversation; everything else is bookkeeping. In
// particular `api-request-blob` entries carry the full request bodies sent to
// the model (system prompt included) and also have a `message` field, so a
// parser that keys on `message.content` alone sends the system prompt to
// Morph dozens of times over.
const CONVERSATION_TYPES = new Set(["user", "assistant"]);

function extractText(role, content) {
  if (!content) return "";
  if (typeof content === "string") {
    return role === "user" ? cleanUserText(content) : content.trim();
  }
  if (!Array.isArray(content)) return "";

  const parts = [];
  for (const block of content) {
    switch (block?.type) {
      case "text": {
        const t = role === "user" ? cleanUserText(block.text || "") : (block.text || "").trim();
        if (t) parts.push(t);
        break;
      }
      case "tool_use":
        parts.push(describeToolUse(block));
        break;
      case "tool_result": {
        // tool_result carries its payload in `content` (string | block[]).
        const c = block.content;
        if (typeof c === "string") {
          const t = cleanToolResult(c);
          if (t) parts.push(t);
        } else if (Array.isArray(c)) {
          for (const inner of c) {
            if (inner?.type === "text" && inner.text) {
              const t = cleanToolResult(inner.text);
              if (t) parts.push(t);
            }
          }
        }
        break;
      }
    }
  }
  return parts.join("\n");
}

function parseLines(text) {
  const entries = [];
  // Transcripts written on Windows may use CRLF line endings.
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Partial trailing line while Claude Code is still writing: skip it.
    }
  }
  return entries;
}

function lastBoundaryIndex(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "system" && e.subtype === "compact_boundary") return i;
  }
  return -1;
}

/**
 * Parse a transcript into Morph-ready `{ role, content }` messages.
 *
 * When the transcript contains a compaction boundary and `previousSummary`
 * (the summary this plugin injected after that compaction) is supplied, only
 * the entries after the boundary are parsed and the summary is prepended.
 * Each compaction then works on a small, recent slice instead of the whole
 * history, and summaries accumulate. Without a previous summary the whole
 * transcript is used so nothing is lost.
 *
 * Returns `{ messages, fromBoundary }`.
 */
export async function parseTranscript(path, { previousSummary } = {}) {
  const entries = parseLines(await readFile(path, "utf-8"));

  let start = 0;
  let fromBoundary = false;
  const boundary = lastBoundaryIndex(entries);
  if (boundary >= 0 && previousSummary) {
    start = boundary + 1;
    fromBoundary = true;
  }

  const messages = [];
  if (fromBoundary) {
    messages.push({
      role: "user",
      content:
        "Summary of the conversation before an earlier compaction:\n" + previousSummary,
    });
  }

  let lastMessageId = null;
  for (let i = start; i < entries.length; i++) {
    const e = entries[i];
    if (!CONVERSATION_TYPES.has(e.type)) continue;
    if (e.isSidechain === true) continue; // subagent traffic
    if (e.isMeta === true) continue; // command envelopes, hook notices
    const msg = e.message;
    if (!msg?.content) continue;

    const role = msg.role === "assistant" ? "assistant" : "user";
    const extracted = extractText(role, msg.content);
    if (!extracted) continue;

    // One assistant turn is logged as several entries sharing `message.id`
    // (text block, tool_use block, ...). Merge them back into one message.
    const id = role === "assistant" ? msg.id : null;
    const prev = messages[messages.length - 1];
    if (id && id === lastMessageId && prev?.role === "assistant") {
      prev.content += "\n" + extracted;
      continue;
    }
    if (prev && prev.role === role && prev.content === extracted) continue; // exact replay

    messages.push({ role, content: extracted });
    lastMessageId = id;
  }

  return { messages, fromBoundary };
}
