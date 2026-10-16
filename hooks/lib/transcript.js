import { readFile } from "node:fs/promises";

function extractText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts = [];
  for (const block of content) {
    switch (block.type) {
      case "text":
        if (block.text) parts.push(block.text);
        break;
      case "tool_use":
        if (block.name) parts.push(`[tool: ${block.name}]`);
        break;
      case "tool_result": {
        // tool_result carries its payload in `content` (string | block[]);
        // `input` only exists on tool_use blocks.
        const c = block.content;
        if (typeof c === "string") {
          if (c) parts.push(`[result]: ${c}`);
        } else if (Array.isArray(c)) {
          for (const inner of c) {
            if (inner?.type === "text" && inner.text) {
              parts.push(`[result]: ${inner.text}`);
            }
          }
        }
        break;
      }
    }
  }
  return parts.join("\n");
}

export async function parseTranscript(path) {
  const text = await readFile(path, "utf-8");
  const messages = [];

  // Transcripts written on Windows may use CRLF line endings.
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let tl;
    try {
      tl = JSON.parse(line);
    } catch {
      continue;
    }

    if (!tl.message?.content) continue;
    const extracted = extractText(tl.message.content);
    if (!extracted) continue;

    messages.push({ role: tl.message.role, content: extracted });
  }

  return messages;
}
