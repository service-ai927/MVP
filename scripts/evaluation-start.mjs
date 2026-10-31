#!/usr/bin/env node
/**
 * evaluation-start.mjs — record the start of a seven-day evaluation window.
 *
 * Writes a one-time JSON artifact (default: <DATA_DIR>/evaluation-start.json)
 * capturing everything the client runbook requires before the window opens:
 * start timestamp (ISO 8601 with timezone), operator, the checkout commit SHA,
 * the RUNNING app's commit SHA (only when verified — see below), and Gemini
 * availability (a boolean fetched from /api/health — never a key).
 *
 * Running-build safeguard: a fresh `git rev-parse HEAD` proves what is checked
 * out, not what the server process is actually running. The record therefore
 * keeps `checkoutCommitSha` and `runningApp` separate and refuses to write an
 * unverified SHA as the running SHA:
 *   - if /api/health reports a commit SHA, it must match the checkout HEAD
 *     (a mismatch fails: restart the app on the intended commit first);
 *   - otherwise the operator must pass --app-commit <sha> to attest which build
 *     is running (recorded with verified:false, source "operator-attested");
 *   - with neither, the script exits 1 instead of guessing.
 *
 * The file is the anchor for the end-of-week report: evaluate-week.mjs
 * --start should be given this start timestamp. The script refuses to
 * overwrite an existing start record unless --force is passed, so the window
 * start cannot be silently moved.
 *
 * Usage:
 *   node scripts/evaluation-start.mjs --operator "Name"
 *        [--start 2026-11-06T09:00:00+09:00]
 *        [--health-url http://127.0.0.1:3000]
 *        [--app-commit <sha>]   (required when /api/health exposes no commit SHA)
 *        [--output <path>] [--force]
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const ISO_WITH_TIMEZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;
const GIT_SHA = /^[0-9a-f]{7,40}$/i;

/** Shorten a SHA for human-readable error messages. */
function shortSha(sha) {
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}

/** Compare two commit SHAs (either may be abbreviated or "unknown"). */
function sameCommit(a, b) {
  if (!a || !b || a === "unknown" || b === "unknown") return null;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || x.startsWith(y) || y.startsWith(x);
}

export function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--operator") options.operator = argv[++i];
    else if (arg === "--start") options.start = argv[++i];
    else if (arg === "--health-url") options.healthUrl = argv[++i];
    else if (arg === "--app-commit") options.appCommit = argv[++i];
    else if (arg === "--output") options.output = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

/** Current commit SHA, or "unknown" outside a Git checkout. */
export function currentCommitSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

/** Read hasGeminiKey (and, if the build exposes one, its commit SHA) from /api/health. */
export async function probeHealth(healthUrl) {
  try {
    const res = await fetch(new URL("/api/health", healthUrl), {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { hasGeminiKey: null, commitSha: null, reachable: false };
    const body = await res.json();
    // Only the boolean and an optional commit SHA are taken; the endpoint never returns the key itself.
    const reported = typeof body.commitSha === "string" ? body.commitSha : null;
    return {
      hasGeminiKey: Boolean(body.hasGeminiKey),
      commitSha: reported && GIT_SHA.test(reported) ? reported.toLowerCase() : null,
      reachable: true,
    };
  } catch {
    return { hasGeminiKey: null, commitSha: null, reachable: false };
  }
}

/**
 * Resolve which commit the RUNNING app is on, or fail. Never records the
 * checkout SHA as the running SHA without evidence (see header comment).
 * Exposed for regression tests.
 */
export function resolveRunningApp({ checkoutSha, health, appCommit }) {
  const healthSha = health?.commitSha && GIT_SHA.test(health.commitSha) ? health.commitSha.toLowerCase() : null;

  if (healthSha) {
    const matches = sameCommit(checkoutSha, healthSha);
    if (matches === false) {
      throw new Error(
        `The running app reports commit ${shortSha(healthSha)} but this checkout is at ${shortSha(checkoutSha)} — ` +
          "the app is running a different (likely older) build. Restart the app on the intended commit " +
          "(or check out the commit that is actually running) before starting the evaluation."
      );
    }
    return {
      commitSha: healthSha,
      verified: true,
      source: "health-endpoint",
      matchesCheckout: matches,
      note: "commit SHA reported by the running app's /api/health; machine-verified",
    };
  }

  if (appCommit !== undefined && appCommit !== null && appCommit !== "") {
    if (typeof appCommit !== "string" || !GIT_SHA.test(appCommit)) {
      throw new Error("--app-commit must be a Git commit SHA (7-40 hex characters) for the build the app is running");
    }
    return {
      commitSha: appCommit.toLowerCase(),
      verified: false,
      source: "operator-attested",
      matchesCheckout: sameCommit(checkoutSha, appCommit),
      note:
        "operator attestation: /api/health does not report a commit SHA — NOT machine-verified. " +
        "Confirm the app was restarted on this commit before the evaluation window opens.",
    };
  }

  throw new Error(
    "Cannot verify the running app's commit: /api/health does not report a SHA and --app-commit was not given. " +
      "Restart the app on the intended commit first, then re-run this script — pass --app-commit <sha> " +
      "(git rev-parse HEAD of the commit the app was restarted from) when /api/health has no commit field. " +
      "Refusing to record the checkout SHA as the running SHA."
  );
}

/**
 * Build the start record. Pure except for the git/health probes, which are
 * injected so tests can exercise validation without side effects.
 */
export function buildStartRecord({ operator, start, commitSha, health, appCommit }) {
  if (!operator || typeof operator !== "string" || !operator.trim()) {
    throw new Error("--operator is required (the evaluation must name an operator)");
  }
  if (!start || !ISO_WITH_TIMEZONE.test(start)) {
    throw new Error("--start must be an ISO 8601 date/time with an explicit timezone offset (e.g. 2026-11-06T09:00:00+09:00)");
  }
  const runningApp = resolveRunningApp({ checkoutSha: commitSha, health, appCommit });
  return {
    evaluationStart: start,
    recordedAt: new Date().toISOString(),
    operator: operator.trim(),
    checkoutCommitSha: commitSha,
    runningApp,
    gemini: {
      hasGeminiKey: health.hasGeminiKey,
      reachable: health.reachable,
      note: health.reachable
        ? "boolean read from /api/health; key value never read or stored"
        : "app not reachable at probe time — record hasGeminiKey manually later",
    },
    timezoneNote: "evaluationStart carries an explicit UTC offset; use it verbatim as evaluate-week.mjs --start",
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: node scripts/evaluation-start.mjs --operator <name> [--start <ISO 8601 with timezone>]\n" +
        "       [--health-url http://127.0.0.1:3000] [--app-commit <sha>] [--output <path>] [--force]\n" +
        "Records the seven-day evaluation start (timestamp, operator, running build's commit, Gemini availability).\n" +
        "The running app's commit is taken from /api/health when the build reports one; otherwise --app-commit\n" +
        "<sha> is required (restart the app on the intended commit first). Without either, this script exits 1\n" +
        "instead of recording the checkout SHA as the running SHA.\n"
    );
    return;
  }

  const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve(".data");
  const outputPath = options.output ? path.resolve(options.output) : path.join(dataDir, "evaluation-start.json");

  if (fs.existsSync(outputPath) && !options.force) {
    throw new Error(`Start record already exists at ${outputPath}. Read it, or rerun with --force to replace it deliberately.`);
  }

  const healthUrl = options.healthUrl || "http://127.0.0.1:3000";
  const record = buildStartRecord({
    operator: options.operator,
    start: options.start || new Date().toISOString(),
    commitSha: currentCommitSha(),
    health: await probeHealth(healthUrl),
    appCommit: options.appCommit,
  });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(record, null, 2) + "\n", "utf8");
  process.stdout.write(JSON.stringify({ ok: true, path: outputPath, record }, null, 2) + "\n");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`Evaluation start failed: ${err.message}\n`);
    // Do not process.exit() here: on Windows, exiting while the stderr write to a
    // pipe is still pending trips a libuv assertion and reports a crash code
    // (0xC0000409) instead of a clean exit 1. Setting exitCode lets Node drain
    // the write first, then exit naturally with status 1.
    process.exitCode = 1;
  });
}
