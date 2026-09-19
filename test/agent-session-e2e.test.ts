import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { before, test } from "node:test";

type FakeChild = {
  child: ChildProcess;
  emitLine: (line: string) => void;
  emitExit: (code: number | null, signal?: NodeJS.Signals) => void;
  killCalls: string[];
};

function fakeChild(): FakeChild {
  const emitter = new EventEmitter();
  const killCalls: string[] = [];
  const child = Object.assign(emitter, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    kill: (signal?: NodeJS.Signals | number) => {
      killCalls.push(String(signal));
      child.killed = true;
      return true;
    },
  }) as unknown as ChildProcess;

  return {
    child,
    killCalls,
    emitLine: (line) => (child.stdout as PassThrough).write(`${line}\n`),
    emitExit: (code, signal) => emitter.emit("exit", code, signal ?? null),
  };
}

type SpawnCall = { command: string; args: string[]; cwd: string };

function memorySessionStore(initial?: Record<string, string>) {
  const data = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    data,
    get: async (id: string) => data.get(id),
    set: async (id: string, sessionId: string) => void data.set(id, sessionId),
  };
}

type SentActivity = { type: string; body?: string };

// Wires a fake kimi process into runKimi and collects spawned argv plus posted
// Linear activities, for driving handleAgentSessionWebhook end to end.
function wireRun(options: {
  runKimi: (payload: never, deps: { spawnProcess: unknown; sessionStore: unknown }) => Promise<unknown>;
  store: ReturnType<typeof memorySessionStore>;
  sent: SentActivity[];
  childFor?: (spawnIndex: number) => FakeChild;
}) {
  const calls: SpawnCall[] = [];
  const fakes = new Map<number, FakeChild>();
  const spawnProcess = ((command: string, args: string[], opts: { cwd: string }) => {
    const fake = options.childFor?.(calls.length) ?? fakeChild();
    fakes.set(calls.length, fake);
    calls.push({ command, args, cwd: opts.cwd });
    return fake.child;
  }) as never;

  return {
    calls,
    fakes,
    run: (payload: never) =>
      options.runKimi(payload, { spawnProcess, sessionStore: options.store }) as Promise<unknown>,
    postActivity: (async (_id: string, content: SentActivity) => {
      options.sent.push(content);
    }) as never,
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const FINAL_TEXT = "Implemented the fix and ran the tests.";

function emitSuccessfulRun(fake: FakeChild, sessionId: string) {
  fake.emitLine(JSON.stringify({ role: "meta", type: "system.version", version: "2.0.1" }));
  fake.emitLine(JSON.stringify({
    role: "assistant",
    tool_calls: [{
      type: "function",
      id: "tool_1",
      function: { name: "Edit", arguments: JSON.stringify({ path: "src/app.ts" }) },
    }],
  }));
  fake.emitLine(JSON.stringify({ role: "tool", tool_call_id: "tool_1", content: "patched" }));
  fake.emitLine(JSON.stringify({ role: "assistant", content: FINAL_TEXT }));
  fake.emitLine(JSON.stringify({ role: "meta", type: "session.resume_hint", session_id: sessionId }));
  fake.emitExit(0);
}

before(() => {
  process.env.LINEAR_CLIENT_ID = "client";
  process.env.LINEAR_CLIENT_SECRET = "secret";
  process.env.LINEAR_WEBHOOK_SECRET = "webhook";
  process.env.LINEAR_REDIRECT_URI = "https://example.com/linear/oauth/callback";
  process.env.BASE_URL = "https://example.com";
  process.env.KIMI_WORKDIR = "/tmp/kimi-workdir";
  process.env.KIMI_COMMAND = "kimi";
  process.env.KIMI_TIMEOUT_MS = "60000";
});

test("created webhook drives a fake kimi run end to end", async () => {
  const { handleAgentSessionWebhook } = await import("../src/session-runner.js");
  const { runKimi } = await import("../src/kimi-runner.js");
  const store = memorySessionStore();
  const sent: SentActivity[] = [];
  const wire = wireRun({ runKimi: runKimi as never, store, sent });

  void handleAgentSessionWebhook(
    { action: "created", agentSession: { id: "agent-session-1", issue: { identifier: "FOO-1", title: "Fix" } } },
    { run: wire.run, postActivity: wire.postActivity },
  );
  setTimeout(() => wire.fakes.get(0) && emitSuccessfulRun(wire.fakes.get(0)!, "session_e2e"), 0);

  await waitFor(() => sent.some((entry) => entry.type === "response"));

  assert.deepEqual(wire.calls[0].args.filter((arg) => arg === "-S"), []);
  assert.equal(store.data.get("agent-session-1"), "session_e2e");
  assert.equal(sent[0]?.type, "thought");
  assert.match(sent[0].body ?? "", /started working/);
  assert.equal(
    sent.some((entry) => entry.type === "thought" && (entry.body ?? "").includes(FINAL_TEXT)),
    false,
    "final answer must appear only as the response activity",
  );
  const response = sent[sent.length - 1];
  assert.equal(response.type, "response");
  assert.match(response.body ?? "", /Implemented the fix/);
  assert.match(response.body ?? "", /_Run completed in /);
});

test("prompted webhook resumes the stored kimi session", async () => {
  const { handleAgentSessionWebhook } = await import("../src/session-runner.js");
  const { runKimi } = await import("../src/kimi-runner.js");
  const store = memorySessionStore({ "agent-session-2": "session_stored" });
  const sent: SentActivity[] = [];
  const wire = wireRun({ runKimi: runKimi as never, store, sent });

  void handleAgentSessionWebhook(
    { action: "prompted", agentActivity: { content: { body: "Please also update docs." } }, agentSession: { id: "agent-session-2" } },
    { run: wire.run, postActivity: wire.postActivity },
  );
  setTimeout(() => wire.fakes.get(0) && emitSuccessfulRun(wire.fakes.get(0)!, "session_stored"), 0);

  await waitFor(() => sent.some((entry) => entry.type === "response"));

  const resumeAt = wire.calls[0].args.indexOf("-S");
  assert.ok(resumeAt >= 0);
  assert.equal(wire.calls[0].args[resumeAt + 1], "session_stored");
});

test("prompted webhook without a stored session starts fresh", async () => {
  const { handleAgentSessionWebhook } = await import("../src/session-runner.js");
  const { runKimi } = await import("../src/kimi-runner.js");
  const store = memorySessionStore();
  const sent: SentActivity[] = [];
  const wire = wireRun({ runKimi: runKimi as never, store, sent });

  void handleAgentSessionWebhook(
    { action: "prompted", agentActivity: { content: { body: "Follow up." } }, agentSession: { id: "agent-session-3" } },
    { run: wire.run, postActivity: wire.postActivity },
  );
  setTimeout(() => wire.fakes.get(0) && emitSuccessfulRun(wire.fakes.get(0)!, "session_fresh"), 0);

  await waitFor(() => sent.some((entry) => entry.type === "response"));
  assert.deepEqual(wire.calls[0].args.filter((arg) => arg === "-S"), []);
});

test("stop webhook kills the running fake kimi process", async () => {
  const { handleAgentSessionWebhook } = await import("../src/session-runner.js");
  const { runKimi } = await import("../src/kimi-runner.js");
  const store = memorySessionStore();
  const sent: SentActivity[] = [];
  const fake = fakeChild();
  const wire = wireRun({ runKimi: runKimi as never, store, sent, childFor: () => fake });

  void handleAgentSessionWebhook(
    { action: "created", agentSession: { id: "agent-session-4" } },
    { run: wire.run, postActivity: wire.postActivity },
  );
  setTimeout(() => fake.emitLine(JSON.stringify({ role: "assistant", content: "working on it" })), 0);

  await waitFor(() => wire.calls.length === 1);
  void handleAgentSessionWebhook(
    { action: "prompted", agentActivity: { content: { body: "stop" } }, agentSession: { id: "agent-session-4" } },
    { postActivity: wire.postActivity },
  );

  await waitFor(() => sent.some((entry) => entry.type === "error" && /Stopped by user/.test(entry.body ?? "")));
  assert.ok(fake.killCalls.includes("SIGTERM"));

  // Let the aborted run settle so the process can exit cleanly.
  fake.emitExit(null, "SIGTERM");
  await waitFor(() => sent.some((entry) => entry.type === "error" && /kimi (timed out|failed)/.test(entry.body ?? "")));
});
