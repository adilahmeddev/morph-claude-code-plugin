import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { log } from "./state.js";

// Resolve the plugin root from this file's location rather than from the
// shell, so the result is correct regardless of cwd, quoting, or which shell
// (Git Bash, PowerShell, sh) Claude Code used to launch the hook.
export const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SDK_MARKER = join(PLUGIN_ROOT, "node_modules", "@morphllm", "morphsdk", "package.json");

// Package managers to try, in order. The first one found on PATH is used.
// Override with MORPH_PACKAGE_MANAGER=npm|pnpm|bun.
const PACKAGE_MANAGERS = {
  npm: "npm install --omit=dev --no-audit --no-fund --loglevel=error",
  // hoisted linker: @morphllm/morphsdk reaches sibling packages (e.g. `ai`)
  // that pnpm's isolated layout would otherwise hide from it.
  pnpm: "pnpm install --prod --ignore-workspace --config.node-linker=hoisted --config.confirmModulesPurge=false",
  bun: "bun install --production --no-save",
};

function run(command, opts = {}) {
  return spawnSync(command, {
    cwd: PLUGIN_ROOT,
    // shell: true so Windows `.cmd` shims (npm.cmd, pnpm.cmd) resolve.
    shell: true,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
    encoding: "utf-8",
    ...opts,
  });
}

function isAvailable(pm) {
  const r = run(`${pm} --version`, { timeout: 15000 });
  return !r.error && r.status === 0;
}

function pickPackageManager() {
  const forced = (process.env.MORPH_PACKAGE_MANAGER || "").trim().toLowerCase();
  if (forced) {
    if (!PACKAGE_MANAGERS[forced]) {
      log(`MORPH_PACKAGE_MANAGER=${forced} is not supported (npm, pnpm, bun); ignoring`);
    } else if (isAvailable(forced)) {
      return forced;
    } else {
      log(`MORPH_PACKAGE_MANAGER=${forced} not found on PATH; trying others`);
    }
  }
  for (const pm of Object.keys(PACKAGE_MANAGERS)) {
    if (pm !== forced && isAvailable(pm)) return pm;
  }
  return null;
}

export function depsInstalled() {
  return existsSync(SDK_MARKER);
}

/**
 * Install runtime dependencies into the plugin root if they are missing.
 *
 * Runs in-process instead of in the hook command string so that:
 *  - no POSIX redirection (`>/dev/null 2>&1`) or `&&` is needed, which breaks
 *    when Windows falls back to PowerShell for hooks;
 *  - `cwd` is the plugin root, avoiding the Windows npm bug where
 *    `npm install --prefix` still reads package.json from the caller's cwd;
 *  - it works with whichever of npm / pnpm / bun is installed;
 *  - the install is skipped entirely once node_modules is populated.
 *
 * Returns true when the SDK is available afterwards.
 */
export function ensureDeps() {
  if (depsInstalled()) return true;

  const pm = pickPackageManager();
  if (!pm) {
    log("no package manager found on PATH (need one of: npm, pnpm, bun); cannot install @morphllm/morphsdk");
    return false;
  }

  log(`installing dependencies with ${pm} (first run)...`);
  const result = run(PACKAGE_MANAGERS[pm], { timeout: 5 * 60 * 1000 });

  if (result.error) {
    log(`${pm} install failed to start: ${result.error.message}`);
  } else if (result.status !== 0) {
    const tail = (result.stderr || "").trim().split(/\r?\n/).slice(-5).join(" | ");
    log(`${pm} install exited with ${result.status}${tail ? `: ${tail}` : ""}`);
  }

  return depsInstalled();
}
