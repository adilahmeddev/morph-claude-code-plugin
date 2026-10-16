import { text } from "node:stream/consumers";
import {
  stateFile, prevSummaryFile, fullSummaryFile,
  log, fileExists, readState, writeState, readText, writeText,
} from "./lib/state.js";
import { ensureDeps } from "./lib/deps.js";
import { parseTranscript } from "./lib/transcript.js";
import { debugDump } from "./lib/debug.js";

/**
 * Morph's ratio is approximate, so the output can still overshoot the budget.
 * Keep the head, park the full text on disk, and tell Claude where it is.
 */
async function fitToBudget(sessionId, summary, max) {
  if (summary.length <= max) return summary;
  const path = fullSummaryFile(sessionId);
  await writeText(path, summary);
  log(`PreCompact: summary ${summary.length} chars exceeds budget ${max}; full text at ${path}`);
  const note =
    `\n\n[Summary truncated to ${max} chars. The full ${summary.length}-char ` +
    `summary is at ${path}; read it if earlier details are needed.]`;
  return summary.slice(0, max - note.length) + note;
}

async function hookPreCompact() {
  const input = JSON.parse(await text(process.stdin));

  if (!input.session_id) throw new Error("no session_id in hook input");
  if (!input.transcript_path)
    throw new Error("no transcript_path in hook input");

  log(`PreCompact triggered: trigger=${input.trigger} session=${input.session_id}`);
  await debugDump(input.session_id, "precompact-input.json", input);

  if (!(await fileExists(input.transcript_path))) {
    throw new Error(`transcript not found: ${input.transcript_path}`);
  }

  const sf = stateFile(input.session_id);
  const prev = await readState(sf);
  if (prev?.summary) {
    log("PreCompact: cached summary found, skipping API call");
    return;
  }

  try {
    if (!ensureDeps()) {
      throw new Error(
        "@morphllm/morphsdk is not installed and automatic install failed " +
        "(needs npm, pnpm or bun on PATH). Run `npm install --omit=dev` " +
        "inside the plugin directory.",
      );
    }
    // Imported lazily so the hook can bootstrap node_modules first, and so a
    // missing API key is reported through the state file rather than crashing
    // at module load.
    const { compact, MAX_CONTEXT_CHARS } = await import("./lib/morph.js");

    const previousSummary = await readText(prevSummaryFile(input.session_id));
    const { messages, fromBoundary } = await parseTranscript(input.transcript_path, {
      previousSummary,
    });
    const inputChars = messages.reduce((n, m) => n + m.content.length, 0);
    log(
      `PreCompact: parsed ${messages.length} messages (${inputChars} chars` +
      `${fromBoundary ? ", since last compaction + previous summary" : ""}), calling Morph API...`,
    );
    await debugDump(input.session_id, "precompact-messages.json", messages);

    const start = performance.now();
    const { output, ratio, usage } = await compact(messages);
    const durationMs = Math.round(performance.now() - start);
    await debugDump(input.session_id, "precompact-summary.txt", output);

    const summary = await fitToBudget(input.session_id, output, MAX_CONTEXT_CHARS);
    const achieved = inputChars > 0 ? ((summary.length / inputChars) * 100).toFixed(1) : "N/A";

    log(
      `PreCompact: compaction complete in ${durationMs}ms — ${inputChars} → ${summary.length} chars ` +
      `(${achieved}%, requested ${(ratio * 100).toFixed(0)}%` +
      `${usage ? `, api ${usage.input_tokens}→${usage.output_tokens} tokens in ${usage.processing_time_ms}ms` : ""})`,
    );

    await writeState(sf, {
      summary,
      warn: false,
      stats: {
        messageCount: messages.length,
        inputChars,
        outputChars: summary.length,
        durationMs,
        requestedRatio: ratio,
        fromBoundary,
        usage,
      },
    });
  } catch (e) {
    log(`PreCompact: error — ${e.message}`);
    await debugDump(input.session_id, "precompact-error.txt", `${e.message}\n${e.stack ?? ""}`);
    await writeState(sf, {
      summary: "",
      warn: false,
      error: e.message,
    });
  }
}

await hookPreCompact().catch((e) =>
  process.stderr.write(
    `[morph-compact] pre-compact UNCAUGHT ERROR: ${e.message}\n${e.stack}\n`,
  ),
);
