import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  buildStartRecord,
  currentCommitSha,
  parseArgs,
  resolveRunningApp,
} from "../scripts/evaluation-start.mjs";

const SCRIPT = path.resolve("scripts/evaluation-start.mjs");
const CHECKOUT_SHA = currentCommitSha();
const OTHER_SHA = "b".repeat(40);

function tempOutput() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-start-"));
  return { dir, file: path.join(dir, "evaluation-start.json") };
}

function runScript(args, env = {}) {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("buildStartRecord requires operator and timezone-qualified start", () => {
  assert.throws(() => buildStartRecord({ operator: "", start: "2026-11-06T09:00:00+09:00", commitSha: "x", health: {} }), /--operator/);
  assert.throws(() => buildStartRecord({ operator: "op", start: "2026-11-06T09:00:00", commitSha: "x", health: {} }), /timezone/);
  const rec = buildStartRecord({
    operator: " Yuki ",
    start: "2026-11-06T09:00:00+09:00",
    commitSha: CHECKOUT_SHA,
    health: { hasGeminiKey: true, reachable: true, commitSha: CHECKOUT_SHA },
  });
  assert.equal(rec.operator, "Yuki");
  assert.equal(rec.checkoutCommitSha, CHECKOUT_SHA);
  assert.equal(rec.runningApp.commitSha, CHECKOUT_SHA);
  assert.equal(rec.runningApp.verified, true);
  assert.equal(rec.evaluationStart, "2026-11-06T09:00:00+09:00");
  assert.equal(rec.gemini.hasGeminiKey, true);
  // The legacy single-field SHA must never come back: checkout and running build are separate.
  assert.equal(rec.commitSha, undefined);
});

test("parseArgs reads operator/start/health-url/app-commit/output and rejects unknown flags", () => {
  const opts = parseArgs([
    "--operator", "A",
    "--start", "2026-11-06T09:00:00Z",
    "--app-commit", "abc1234",
    "--force",
  ]);
  assert.equal(opts.operator, "A");
  assert.equal(opts.start, "2026-11-06T09:00:00Z");
  assert.equal(opts.appCommit, "abc1234");
  assert.equal(opts.force, true);
  assert.throws(() => parseArgs(["--nope"]), /Unknown argument/);
});

test("currentCommitSha returns a full SHA in this checkout", () => {
  assert.match(CHECKOUT_SHA, /^([0-9a-f]{40}|unknown)$/);
});

// --- Running-build safeguard: never record an unverified SHA as running ---

test("safeguard: refuses to record the checkout SHA when the app reports no commit", () => {
  // App reachable but exposes no commit field (current builds) — no --app-commit.
  assert.throws(
    () => resolveRunningApp({ checkoutSha: CHECKOUT_SHA, health: { hasGeminiKey: true, reachable: true } }),
    /Refusing to record the checkout SHA/
  );
  // App unreachable — nothing to verify against either.
  assert.throws(
    () => resolveRunningApp({ checkoutSha: CHECKOUT_SHA, health: { hasGeminiKey: null, commitSha: null, reachable: false } }),
    /Refusing to record the checkout SHA/
  );
  // --app-commit is the required escape hatch; the error names it.
  assert.throws(
    () => resolveRunningApp({ checkoutSha: CHECKOUT_SHA, health: { reachable: true } }),
    /--app-commit/
  );
});

test("safeguard: fails when the running app reports a different commit than the checkout", () => {
  assert.throws(
    () => resolveRunningApp({
      checkoutSha: CHECKOUT_SHA,
      health: { hasGeminiKey: true, reachable: true, commitSha: OTHER_SHA },
    }),
    /Restart the app on the intended commit/
  );
  // Abbreviated health SHA that does not prefix-match the checkout also fails.
  assert.throws(
    () => resolveRunningApp({ checkoutSha: CHECKOUT_SHA, health: { reachable: true, commitSha: "deadbeef" } }),
    /Restart the app on the intended commit/
  );
});

test("safeguard: health-reported commit matching the checkout is recorded as verified", () => {
  const app = resolveRunningApp({
    checkoutSha: CHECKOUT_SHA,
    health: { hasGeminiKey: true, reachable: true, commitSha: CHECKOUT_SHA.toUpperCase() },
  });
  assert.equal(app.verified, true);
  assert.equal(app.source, "health-endpoint");
  assert.equal(app.commitSha, CHECKOUT_SHA.toLowerCase());
  assert.equal(app.matchesCheckout, true);
});

test("safeguard: --app-commit is recorded as an unverified operator attestation", () => {
  const attested = resolveRunningApp({
    checkoutSha: CHECKOUT_SHA,
    health: { hasGeminiKey: true, reachable: true },
    appCommit: CHECKOUT_SHA,
  });
  assert.equal(attested.verified, false);
  assert.equal(attested.source, "operator-attested");
  assert.equal(attested.matchesCheckout, true);
  assert.match(attested.note, /NOT machine-verified/);

  // Attested SHA that differs from the checkout is still recorded, but flagged.
  const differs = resolveRunningApp({
    checkoutSha: CHECKOUT_SHA,
    health: { reachable: true },
    appCommit: OTHER_SHA,
  });
  assert.equal(differs.verified, false);
  assert.equal(differs.matchesCheckout, false);

  // Malformed attestation is rejected, not stored.
  assert.throws(
    () => resolveRunningApp({ checkoutSha: CHECKOUT_SHA, health: { reachable: true }, appCommit: "not-a-sha" }),
    /--app-commit must be/
  );
});

test("CLI refuses to write a start record without a verifiable running SHA", () => {
  const { dir, file } = tempOutput();
  try {
    const result = spawnSync(process.execPath, [
      SCRIPT,
      "--operator", "Test Op",
      "--start", "2026-11-06T09:00:00+09:00",
      "--health-url", "http://127.0.0.1:1", // unreachable: no SHA to verify against
      "--output", file,
    ], { encoding: "utf8" });
    assert.equal(result.status, 1, "must exit with status 1 (a crash code like 0xC0000409 would fail this)");
    assert.match(result.stderr, /Refusing to record the checkout SHA/);
    assert.equal(fs.existsSync(file), false, "no start record may be written");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI writes the start record with an attested SHA and refuses silent overwrite", () => {
  const { dir, file } = tempOutput();
  try {
    const out = runScript([
      "--operator", "Test Op",
      "--start", "2026-11-06T09:00:00+09:00",
      "--health-url", "http://127.0.0.1:1", // unreachable: no SHA to verify against
      "--app-commit", CHECKOUT_SHA, // operator attests the running build
      "--output", file,
    ]);
    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.match(written.evaluationStart, /T.*([Z]|[+-]\d{2}:?\d{2})$/);
    assert.equal(written.operator, "Test Op");
    assert.match(written.checkoutCommitSha, /^([0-9a-f]{40}|unknown)$/);
    assert.equal(written.runningApp.commitSha, CHECKOUT_SHA);
    assert.equal(written.runningApp.verified, false);
    assert.equal(written.runningApp.source, "operator-attested");
    assert.equal(written.gemini.reachable, false); // nothing listening on port 1
    assert.equal(written.gemini.hasGeminiKey, null);
    assert.ok(JSON.parse(out).ok);

    // Second run without --force must fail and keep the original record.
    assert.throws(() => runScript(["--operator", "Other", "--output", file]), /already exists/);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).operator, "Test Op");

    // --force replaces it deliberately (attestation still required).
    runScript([
      "--operator", "Other",
      "--start", "2026-11-07T09:00:00Z",
      "--health-url", "http://127.0.0.1:1",
      "--app-commit", CHECKOUT_SHA,
      "--force",
      "--output", file,
    ]);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).operator, "Other");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
