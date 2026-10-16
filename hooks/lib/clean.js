// Text scrubbing for transcript content before it is sent to the Morph API.
//
// Claude Code wraps a lot of machinery around the real conversation: system
// reminders, slash-command envelopes, line-numbered file dumps, multi-hundred
// KB tool results. None of it helps a summary and all of it costs budget, so
// it is stripped or trimmed here. Every function is pure and never throws.

const MAX_RESULT_CHARS = parseInt(process.env.MORPH_COMPACT_MAX_RESULT_CHARS || "3000", 10);
const MAX_TOOL_INPUT_CHARS = parseInt(process.env.MORPH_COMPACT_MAX_TOOL_INPUT_CHARS || "400", 10);

// The sentinel the install skill writes into CLAUDE.md. A continuation message
// that only carries it says nothing about the conversation.
export const SENTINEL = "Summary of previous conversation in SessionStart hook";

// Terminal colour / style codes that leak in through command output.
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** Clean a user-authored text block. Returns "" when nothing useful is left. */
export function cleanUserText(text) {
  let t = text.replace(ANSI, "");
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  t = t.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "");
  // `<command-name>/x</command-name><command-message>..</command-message>
  // <command-args>y</command-args>` becomes the `/x y` the user typed.
  t = t.replace(
    /<command-name>([\s\S]*?)<\/command-name>\s*(?:<command-message>[\s\S]*?<\/command-message>)?\s*(?:<command-args>([\s\S]*?)<\/command-args>)?/g,
    (_, name, args) => `${name.trim()} ${(args || "").trim()}`.trim(),
  );
  t = t.replace(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/g, (_, out) =>
    out.trim() ? `[command output]: ${truncate(out.trim(), MAX_RESULT_CHARS)}` : "",
  );
  t = t.trim();
  if (!t) return "";
  // Post-compaction continuation message that carries only the sentinel.
  if (t.startsWith("This session is being continued") && t.includes(SENTINEL)) return "";
  return t;
}

/** Render a tool_use block as one short line: `[tool: Name] {input}`. */
export function describeToolUse(block) {
  const name = block.name || "unknown";
  let input = "";
  if (block.input && typeof block.input === "object") {
    try {
      input = JSON.stringify(block.input);
    } catch {
      input = "";
    }
  }
  return input ? `[tool: ${name}] ${truncate(input, MAX_TOOL_INPUT_CHARS)}` : `[tool: ${name}]`;
}

/** Clean one tool_result text payload. */
export function cleanToolResult(text) {
  let t = stripLineNumbers(text.replace(ANSI, "")).trim();
  if (!t) return "";
  return `[result]: ${truncate(t, MAX_RESULT_CHARS)}`;
}

/**
 * The Read tool prefixes every line with `<n>\t`. When most lines of a result
 * carry that prefix, drop it: the numbers are useless to a summary and add
 * roughly 5% to every file dump.
 */
export function stripLineNumbers(text) {
  const lines = text.split("\n");
  if (lines.length < 3) return text;
  const numbered = lines.filter((l) => /^\s*\d+\t/.test(l)).length;
  if (numbered < lines.length * 0.8) return text;
  return lines.map((l) => l.replace(/^\s*\d+\t/, "")).join("\n");
}

/** Keep the head and tail of an oversized string and mark the gap. */
export function truncate(text, max) {
  if (!Number.isFinite(max) || max <= 0 || text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  const dropped = text.length - head - tail;
  return `${text.slice(0, head)}\n… [${dropped} chars truncated] …\n${text.slice(text.length - tail)}`;
}
