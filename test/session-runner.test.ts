import assert from "node:assert/strict";
import { before, test } from "node:test";

before(() => {
  process.env.LINEAR_CLIENT_ID = "client";
  process.env.LINEAR_CLIENT_SECRET = "secret";
  process.env.LINEAR_WEBHOOK_SECRET = "webhook";
  process.env.LINEAR_REDIRECT_URI = "https://example.com/linear/oauth/callback";
  process.env.BASE_URL = "https://example.com";
  process.env.KIMI_WORKDIR = "/tmp";
});

async function sessionRunnerModule() {
  return import("../src/session-runner.js");
}

test("final response body includes elapsed footer", async () => {
  const { finalResponseBody } = await sessionRunnerModule();

  assert.equal(
    finalResponseBody("kimi changed files.", 252_000),
    "kimi changed files.\n\n_Run completed in 4m 12s._",
  );
});

test("final response body preserves elapsed footer when summary is truncated", async () => {
  const { finalResponseBody } = await sessionRunnerModule();
  const { MAX_LINEAR_BODY_CHARS } = await import("../src/kimi-runner.js");

  const body = finalResponseBody("x".repeat(MAX_LINEAR_BODY_CHARS), 1_800_000);

  assert.equal(body.length, MAX_LINEAR_BODY_CHARS);
  assert.equal(body.endsWith("\n\n_Run completed in 30m._"), true);
});

test("final error body reports timeout elapsed runtime", async () => {
  const { finalErrorBody } = await sessionRunnerModule();

  assert.equal(
    finalErrorBody({
      exitCode: null,
      signal: null,
      timedOut: true,
      stderr: "",
      outputText: "partial",
      summary: "kimi failed without output.",
      elapsedMs: 1_800_000,
    }),
    "kimi timed out after 30m\n\nkimi failed without output.",
  );
});

test("final error body reports non-timeout SDK failure elapsed runtime", async () => {
  const { finalErrorBody } = await sessionRunnerModule();

  assert.equal(
    finalErrorBody({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stderr: "boom",
      outputText: "",
      summary: "stderr:\nboom",
      elapsedMs: 12_000,
    }),
    "kimi failed after 12s\n\nstderr:\nboom",
  );
});

test("stop and crash activity copy includes elapsed runtime when available", async () => {
  const { crashActivityBody, stopActivityBody } = await sessionRunnerModule();

  assert.equal(stopActivityBody(true, 128_000), "Stopped by user after 2m 8s.");
  assert.equal(stopActivityBody(false, 128_000), "Stop requested; no active kimi run was in progress.");
  assert.equal(
    crashActivityBody(new Error("SDK unavailable"), 3_000),
    "Kimi failed to start or run kimi after 3s: SDK unavailable",
  );
});
