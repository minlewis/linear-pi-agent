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

type SentActivity = { agentSessionId: string; content: unknown };

function sessionDeps(overrides: {
  runResult?: Record<string, unknown>;
  abortResult?: boolean;
} = {}) {
  const sent: SentActivity[] = [];
  const runs: unknown[] = [];
  const aborts: string[] = [];
  const deps = {
    sent,
    runs,
    aborts,
    run: async (payload: unknown) => {
      runs.push(payload);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stderr: "",
        outputText: "done",
        summary: "kimi finished.",
        elapsedMs: 1_000,
        ...overrides.runResult,
      };
    },
    abort: async (agentSessionId: string) => {
      aborts.push(agentSessionId);
      return overrides.abortResult ?? true;
    },
    postActivity: async (agentSessionId: string, content: unknown) => {
      sent.push({ agentSessionId, content });
    },
  };
  return deps;
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("created webhook starts a run and posts a response activity", async () => {
  const { handleAgentSessionWebhook } = await sessionRunnerModule();
  const deps = sessionDeps();

  void handleAgentSessionWebhook(
    { action: "created", agentSession: { id: "agent-session-1", issue: { identifier: "FOO-1", title: "Fix" } } },
    deps,
  );

  await waitFor(() => deps.sent.some((entry) => (entry.content as { type: string }).type === "response"));
  assert.equal(deps.runs.length, 1);
  const types = deps.sent.map((entry) => (entry.content as { type: string }).type);
  assert.deepEqual(types, ["thought", "response"]);
  const response = deps.sent[1].content as { body: string };
  assert.match(response.body, /kimi finished\./);
  assert.match(response.body, /_Run completed in 1s\._/);
});

test("prompted webhook runs a follow-up after the previous run finished", async () => {
  const { handleAgentSessionWebhook } = await sessionRunnerModule();
  const deps = sessionDeps();

  void handleAgentSessionWebhook(
    { action: "created", agentSession: { id: "agent-session-1" } },
    deps,
  );
  await waitFor(() => deps.sent.filter((entry) => (entry.content as { type: string }).type === "response").length === 1);

  void handleAgentSessionWebhook(
    { action: "prompted", agentActivity: { content: { body: "Follow up." } }, agentSession: { id: "agent-session-1" } },
    deps,
  );

  await waitFor(() => deps.sent.filter((entry) => (entry.content as { type: string }).type === "response").length === 2);
  assert.equal(deps.runs.length, 2);
  assert.deepEqual(
    deps.sent.map((entry) => (entry.content as { type: string }).type),
    ["thought", "response", "thought", "response"],
  );
});

test("prompted webhook while running is queued and runs after the active run", async () => {
  const { handleAgentSessionWebhook } = await sessionRunnerModule();
  const sent: SentActivity[] = [];
  const runs: string[] = [];
  let releaseRun: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });

  const deps = {
    run: async (payload: { action?: string }) => {
      runs.push(payload.action ?? "?");
      if (runs.length === 1) await gate;
      return { exitCode: 0, signal: null, timedOut: false, stderr: "", outputText: "done", summary: "ok", elapsedMs: 1 };
    },
    abort: async () => true,
    postActivity: async (agentSessionId: string, content: unknown) => {
      sent.push({ agentSessionId, content });
    },
  };

  void handleAgentSessionWebhook({ action: "created", agentSession: { id: "agent-session-1" } }, deps);
  await waitFor(() => runs.length === 1);

  void handleAgentSessionWebhook(
    { action: "prompted", agentActivity: { content: { body: "Follow up." } }, agentSession: { id: "agent-session-1" } },
    deps,
  );
  await waitFor(() => sent.some((entry) => {
    const content = entry.content as { type: string; body: string };
    return content.type === "thought" && /queued|after the current/i.test(content.body);
  }));
  assert.equal(runs.length, 1);

  releaseRun?.();
  await waitFor(() => runs.length === 2);
});

test("stop webhook aborts the active run and posts an error activity", async () => {
  const { handleAgentSessionWebhook } = await sessionRunnerModule();
  const deps = sessionDeps({ abortResult: true });

  void handleAgentSessionWebhook({ action: "created", agentSession: { id: "agent-session-1" } }, deps);
  await waitFor(() => deps.runs.length === 1);

  void handleAgentSessionWebhook(
    { action: "prompted", agentActivity: { content: { body: "stop" } }, agentSession: { id: "agent-session-1" } },
    deps,
  );

  await waitFor(() => deps.aborts.length === 1);
  assert.deepEqual(deps.aborts, ["agent-session-1"]);
  await waitFor(() => deps.sent.some((entry) => (entry.content as { type: string }).type === "error"));
  const error = deps.sent.find((entry) => (entry.content as { type: string }).type === "error");
  assert.match((error?.content as { body: string }).body, /Stopped by user/);
});

test("stop webhook without an active run reports no active run", async () => {
  const { handleAgentSessionWebhook } = await sessionRunnerModule();
  const deps = sessionDeps({ abortResult: false });

  void handleAgentSessionWebhook(
    { action: "prompted", agentActivity: { content: { body: "cancel" } }, agentSession: { id: "agent-session-1" } },
    deps,
  );

  await waitFor(() => deps.sent.some((entry) => (entry.content as { type: string }).type === "error"));
  assert.equal(deps.aborts.length, 1);
  const error = deps.sent.find((entry) => (entry.content as { type: string }).type === "error");
  assert.match((error?.content as { body: string }).body, /no active kimi run/);
});
