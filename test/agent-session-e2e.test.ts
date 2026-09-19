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
  const fake = fakeChild();
  const calls: SpawnCall[] = [];
  const store = memorySessionStore();
  const sent: Array<{ type: string; body?: string }> = [];

  const spawnProcess = ((command: string, args: string[], options: { cwd: string }) => {
    calls.push({ command, args, cwd: options.cwd });
    return fake.child;
  }) as never;

  const run = (payload: never) => runKimi(payload, { spawnProcess, sessionStore: store });
  const postActivity = async (_id: string, content: { type: string; body?: string }) => {
    sent.push(content);
  };

  void handleAgentSessionWebhook(
    { action: "created", agentSession: { id: "agent-session-1", issue: { identifier: "FOO-1", title: "Fix" } } },
    { run: run as never, postActivity: postActivity as never },
  );
  setTimeout(() => emitSuccessfulRun(fake, "session_e2e"), 0);

  await waitFor(() => sent.some((entry) => entry.type === "response"));

  assert.deepEqual(calls[0].args.filter((arg) => arg === "-S"), []);
  assert.equal(store.data.get("agent-session-1"), "session_e2e");
  assert.equal(sent[0]?.type, "thought");
  assert.match(sent[0].body ?? "", /started working/);
  const response = sent[sent.length - 1];
  assert.equal(response.type, "response");
  assert.match(response.body ?? "", /Implemented the fix/);
  assert.match(response.body ?? "", /_Run completed in /);
});

test("prompted webhook resumes the stored kimi session", async () => {
  const { handleAgentSessionWebhook } = await import("../src/session-runner.js");
  const { runKimi } = await import("../src/kimi-runner.js");
  const store = memorySessionStore({ "agent-session-2": "session_stored" });
  const sent: Array<{ type: string; body?: string }> = [];
  const calls: SpawnCall[] = [];
  const fakes = new Map<number, FakeChild>();
  let spawnCount = 0;

  const spawnProcess = ((command: string, args: string[], options: { cwd: string }) => {
    const fake = fakeChild();
    fakes.set(spawnCount, fake);
    calls.push({ command, args, cwd: options.cwd });
    return fake.child;
  }) as never;

  const run = (payload: never) => runKimi(payload, { spawnProcess, sessionStore: store });
  const postActivity = async (_id: string, content: { type: string; body?: string }) => {
    sent.push(content);
  };

  void handleAgentSessionWebhook(
    { action: "prompted", agentActivity: { content: { body: "Please also update docs." } }, agentSession: { id: "agent-session-2" } },
    { run: run as never, postActivity: postActivity as never },
  );
  setTimeout(() => emitSuccessfulRun(fakes.get(0)!, "session_stored"), 0);

  await waitFor(() => sent.some((entry) => entry.type === "response"));

  const resumeAt = calls[0].args.indexOf("-S");
  assert.ok(resumeAt >= 0);
  assert.equal(calls[0].args[resumeAt + 1], "session_stored");
});

test("prompted webhook without a stored session starts fresh", async () => {
  const { handleAgentSessionWebhook } = await import("../src/session-runner.js");
  const { runKimi } = await import("../src/kimi-runner.js");
  const fake = fakeChild();
  const calls: SpawnCall[] = [];
  const store = memorySessionStore();
  const sent: Array<{ type: string }> = [];

  const spawnProcess = ((command: string, args: string[], options: { cwd: string }) => {
    calls.push({ command, args, cwd: options.cwd });
    return fake.child;
  }) as never;

  const run = (payload: never) => runKimi(payload, { spawnProcess, sessionStore: store });
  const postActivity = async (_id: string, content: { type: string }) => {
    sent.push(content);
  };

  void handleAgentSessionWebhook(
    { action: "prompted", agentActivity: { content: { body: "Follow up." } }, agentSession: { id: "agent-session-3" } },
    { run: run as never, postActivity: postActivity as never },
  );
  setTimeout(() => emitSuccessfulRun(fake, "session_fresh"), 0);

  await waitFor(() => sent.some((entry) => entry.type === "response"));
  assert.deepEqual(calls[0].args.filter((arg) => arg === "-S"), []);
});

test("stop webhook kills the running fake kimi process", async () => {
  const { handleAgentSessionWebhook } = await import("../src/session-runner.js");
  const { runKimi } = await import("../src/kimi-runner.js");
  const fake = fakeChild();
  const store = memorySessionStore();
  const sent: Array<{ type: string; body?: string }> = [];
  const calls: SpawnCall[] = [];

  const spawnProcess = ((command: string, args: string[], options: { cwd: string }) => {
    calls.push({ command, args, cwd: options.cwd });
    return fake.child;
  }) as never;
  const run = (payload: never) => runKimi(payload, { spawnProcess, sessionStore: store });
  const postActivity = async (_id: string, content: { type: string; body?: string }) => {
    sent.push(content);
  };

  void handleAgentSessionWebhook(
    { action: "created", agentSession: { id: "agent-session-4" } },
    { run: run as never, postActivity: postActivity as never },
  );
  setTimeout(() => fake.emitLine(JSON.stringify({ role: "assistant", content: "working on it" })), 0);

  await waitFor(() => calls.length === 1);
  void handleAgentSessionWebhook(
    { action: "prompted", agentActivity: { content: { body: "stop" } }, agentSession: { id: "agent-session-4" } },
    { postActivity: postActivity as never },
  );

  await waitFor(() => sent.some((entry) => entry.type === "error" && /Stopped by user/.test(entry.body ?? "")));
  assert.ok(fake.killCalls.includes("SIGTERM"));

  // Let the aborted run settle so the process can exit cleanly.
  fake.emitExit(null, "SIGTERM");
  await waitFor(() => sent.some((entry) => entry.type === "error" && /kimi (timed out|failed)/.test(entry.body ?? "")));
});
