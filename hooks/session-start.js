import { text } from "node:stream/consumers";
import { unlink } from "node:fs/promises";
import { stateFile, log, fileExists, readState, emitContext } from "./lib/state.js";
import { ensureDeps } from "./lib/deps.js";

async function hookSessionStart() {
  const input = JSON.parse(await text(process.stdin));
  if (!input.session_id) throw new Error("no session_id in hook input");

  log(`SessionStart: source=${input.source} session=${input.session_id}`);

  const sf = stateFile(input.session_id);
  if (!(await fileExists(sf))) {
    log("SessionStart: no state file, nothing to inject");
    return;
  }

  const state = await readState(sf);
  if (!state) {
    log("SessionStart: state file unreadable, nothing to inject");
    return;
  }
  log(`SessionStart: state=${JSON.stringify({ error: state.error, summaryLen: state.summary?.length ?? 0, stats: state.stats })}`);

  if (state.error) {
    log(`SessionStart: injecting error — ${state.error}`);
    emitContext(
      "SessionStart",
      "ERROR: Morph compaction failed: " + state.error + "\n" +
      "Inform the user about this error. Context from the previous conversation was NOT preserved.",
    );
    await unlink(sf).catch(() => {});
    return;
  }

  if (!state.summary) {
    log("SessionStart: state file has no summary, skipping");
    return;
  }

  const data = state.summary;

  if (state.stats) {
    const { messageCount, inputChars, outputChars, durationMs } = state.stats;
    const ratio = inputChars > 0 ? ((outputChars / inputChars) * 100).toFixed(1) : "N/A";
    log(`SessionStart: injecting summary — ${messageCount} messages, ${inputChars} → ${outputChars} chars (${ratio}%), took ${durationMs}ms`);
  } else {
    log(`SessionStart: injecting summary (${data.length} chars)`);
  }

  emitContext("SessionStart", data);
  await unlink(sf).catch(() => {});
}

await hookSessionStart().catch((e) =>
  process.stderr.write(
    `morph-compact: session-start: ${e.message}\n`,
  ),
);

// Warm the dependency install on session start (no-op once installed) so the
// first compaction does not pay the npm install cost inside its own timeout.
// Failure here is non-fatal: injection above has already happened.
try {
  ensureDeps();
} catch (e) {
  log(`SessionStart: dependency warm-up failed — ${e.message}`);
}
