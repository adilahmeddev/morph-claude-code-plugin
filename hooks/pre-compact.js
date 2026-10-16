import { text } from "node:stream/consumers";
import { stateFile, log, fileExists, readState, writeState } from "./lib/state.js";
import { ensureDeps } from "./lib/deps.js";
import { parseTranscript } from "./lib/transcript.js";
import { debugDump } from "./lib/debug.js";

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
    const { compact } = await import("./lib/morph.js");

    const messages = await parseTranscript(input.transcript_path);
    const inputChars = messages.reduce((n, m) => n + m.content.length, 0);
    log(`PreCompact: parsed ${messages.length} messages (${inputChars} chars), calling Morph API...`);
    await debugDump(input.session_id, "precompact-messages.json", messages);

    const start = performance.now();
    const summary = await compact(messages);
    const durationMs = Math.round(performance.now() - start);
    await debugDump(input.session_id, "precompact-summary.txt", summary);
    const ratio = inputChars > 0 ? ((summary.length / inputChars) * 100).toFixed(1) : "N/A";

    log(`PreCompact: compaction complete in ${durationMs}ms — ${inputChars} → ${summary.length} chars (${ratio}% ratio)`);

    await writeState(sf, {
      summary,
      warn: false,
      stats: { messageCount: messages.length, inputChars, outputChars: summary.length, durationMs },
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
