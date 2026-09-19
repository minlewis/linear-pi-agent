import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { before, test } from "node:test";

type FakeChild = {
  child: ChildProcess;
  stdout: PassThrough;
  stderr: PassThrough;
  emitLine: (line: string) => void;
  emitExit: (code: number | null, signal?: NodeJS.Signals) => void;
  emitError: (error: Error) => void;
  killCalls: string[];
};

function fakeChild(): FakeChild {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const killCalls: string[] = [];
  const child = Object.assign(emitter, {
    stdout,
    stderr,
    killed: false,
    kill: (signal?: NodeJS.Signals | number) => {
      killCalls.push(String(signal));
      child.killed = true;
      return true;
    },
  }) as unknown as ChildProcess;

  return {
    child,
    stdout,
    stderr,
    killCalls,
    emitLine: (line) => stdout.write(`${line}\n`),
    emitExit: (code, signal) => emitter.emit("exit", code, signal ?? null),
    emitError: (error) => emitter.emit("error", error),
  };
}

type SpawnCall = {
  command: string;
  args: string[];
  cwd: string;
};

function spawnRecorder(fake: FakeChild, calls: SpawnCall[]) {
  return ((command: string, args: string[], options: { cwd: string }) => {
    calls.push({ command, args, cwd: options.cwd });
    return fake.child;
  }) as never;
}

function memorySessionStore(initial?: Record<string, string>) {
  const data = new Map(Object.entries(initial ?? {}));
  const models = new Map<string, string>();
  return {
    data,
    models,
    get: async (id: string) => data.get(id),
    getModel: async (id: string) => models.get(id),
    set: async (id: string, sessionId: string, model?: string) => {
      data.set(id, sessionId);
      if (model) models.set(id, model);
    },
  };
}

const RESUME_HINT = JSON.stringify({
  role: "meta",
  type: "session.resume_hint",
  session_id: "session_abc",
});

async function runnerModule() {
  return import("../src/kimi-runner.js");
}

before(() => {
  process.env.LINEAR_CLIENT_ID = "client";
  process.env.LINEAR_CLIENT_SECRET = "secret";
  process.env.LINEAR_WEBHOOK_SECRET = "webhook";
  process.env.LINEAR_REDIRECT_URI = "https://example.com/linear/oauth/callback";
  process.env.BASE_URL = "https://example.com";
  process.env.KIMI_WORKDIR = "/tmp/kimi-workdir";
  process.env.KIMI_COMMAND = "kimi";
  process.env.KIMI_TIMEOUT_MS = "50";
  process.env.KIMI_MODEL_ROUTER = "kimi-code/router-model";
  process.env.KIMI_MODEL_EASY = "kimi-code/easy-model";
  process.env.KIMI_MODEL_HARD = "kimi-code/hard-model";
});

test("parseDifficulty maps model replies to easy or hard", async () => {
  const { parseDifficulty } = await runnerModule();

  assert.equal(parseDifficulty("easy"), "easy");
  assert.equal(parseDifficulty("Easy."), "easy");
  assert.equal(parseDifficulty("HARD"), "hard");
  assert.equal(parseDifficulty("I would classify this as quite hard."), "hard");
  assert.equal(parseDifficulty("cannot say"), undefined);
  assert.equal(parseDifficulty(""), undefined);
});

test("classifyTaskDifficulty asks the router model and parses the reply", async () => {
  const { classifyTaskDifficulty } = await runnerModule();
  const fake = fakeChild();
  const calls: SpawnCall[] = [];

  const promise = classifyTaskDifficulty(
    { action: "created", agentSession: { id: "agent-session-1", issue: { identifier: "FOO-1", title: "Tweak docs" } } },
    { spawnProcess: spawnRecorder(fake, calls) },
  );
  setTimeout(() => {
    fake.stdout.write("easy\n");
    fake.emitExit(0);
  }, 0);

  assert.equal(await promise, "easy");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes("-p"));
  assert.match(calls[0].args.join(" "), /Tweak docs/);
  const modelAt = calls[0].args.indexOf("-m");
  assert.ok(modelAt >= 0);
  assert.equal(calls[0].args[modelAt + 1], "kimi-code/router-model");
});

test("classifyTaskDifficulty returns undefined for unreadable replies and spawn errors", async () => {
  const { classifyTaskDifficulty } = await runnerModule();

  const fake = fakeChild();
  const p1 = classifyTaskDifficulty(
    { action: "created", agentSession: { id: "agent-session-1" } },
    { spawnProcess: spawnRecorder(fake, []) },
  );
  setTimeout(() => {
    fake.stdout.write("banana\n");
    fake.emitExit(0);
  }, 0);
  assert.equal(await p1, undefined);

  const fake2 = fakeChild();
  const p2 = classifyTaskDifficulty(
    { action: "created", agentSession: { id: "agent-session-1" } },
    { spawnProcess: spawnRecorder(fake2, []) },
  );
  setTimeout(() => fake2.emitError(new Error("boom")), 0);
  assert.equal(await p2, undefined);
});

test("classifyTaskDifficulty times out to undefined and kills the child", async () => {
  const { classifyTaskDifficulty } = await runnerModule();
  const fake = fakeChild();

  const resultPromise = classifyTaskDifficulty(
    { action: "created", agentSession: { id: "agent-session-1" } },
    { spawnProcess: spawnRecorder(fake, []), timeoutMs: 30 },
  );
  // Keep the event loop alive so the unref'd classify timeout can fire.
  setTimeout(() => fake.emitExit(null, "SIGTERM"), 500);

  assert.equal(await resultPromise, undefined);
  assert.ok(fake.killCalls.includes("SIGTERM"));
});

test("runKimi routes easy classifications to KIMI_MODEL_EASY", async () => {
  const { runKimi } = await runnerModule();
  const fake = fakeChild();
  const calls: SpawnCall[] = [];
  const store = memorySessionStore();

  const promise = runKimi(
    { action: "created", agentSession: { id: "agent-session-1" } },
    { spawnProcess: spawnRecorder(fake, calls), sessionStore: store, classify: async () => "easy" },
  );
  setTimeout(() => {
    fake.emitLine(RESUME_HINT);
    fake.emitExit(0);
  }, 0);
  await promise;

  const modelAt = calls[0].args.indexOf("-m");
  assert.ok(modelAt >= 0);
  assert.equal(calls[0].args[modelAt + 1], "kimi-code/easy-model");
  assert.equal(store.models.get("agent-session-1"), "kimi-code/easy-model");
});

test("runKimi routes hard classifications to KIMI_MODEL_HARD", async () => {
  const { runKimi } = await runnerModule();
  const fake = fakeChild();
  const calls: SpawnCall[] = [];
  const store = memorySessionStore();

  const promise = runKimi(
    { action: "created", agentSession: { id: "agent-session-1" } },
    { spawnProcess: spawnRecorder(fake, calls), sessionStore: store, classify: async () => "hard" },
  );
  setTimeout(() => {
    fake.emitLine(RESUME_HINT);
    fake.emitExit(0);
  }, 0);
  await promise;

  const modelAt = calls[0].args.indexOf("-m");
  assert.ok(modelAt >= 0);
  assert.equal(calls[0].args[modelAt + 1], "kimi-code/hard-model");
});

test("runKimi falls back to no -m when classification fails", async () => {
  const { runKimi } = await runnerModule();
  const fake = fakeChild();
  const calls: SpawnCall[] = [];

  const promise = runKimi(
    { action: "created", agentSession: { id: "agent-session-1" } },
    { spawnProcess: spawnRecorder(fake, calls), sessionStore: memorySessionStore(), classify: async () => undefined },
  );
  setTimeout(() => {
    fake.emitLine(RESUME_HINT);
    fake.emitExit(0);
  }, 0);
  await promise;

  assert.deepEqual(calls[0].args.filter((arg) => arg === "-m"), []);
});

test("runKimi reuses the stored model for follow-ups without classifying", async () => {
  const { runKimi } = await runnerModule();
  const fake = fakeChild();
  const calls: SpawnCall[] = [];
  const store = memorySessionStore({ "agent-session-1": "session_stored" });
  store.models.set("agent-session-1", "kimi-code/hard-model");
  let classifyCalled = false;

  const promise = runKimi(
    { action: "prompted", agentActivity: { content: { body: "Follow up." } }, agentSession: { id: "agent-session-1" } },
    {
      spawnProcess: spawnRecorder(fake, calls),
      sessionStore: store,
      classify: async () => {
        classifyCalled = true;
        return "easy";
      },
    },
  );
  setTimeout(() => {
    fake.emitLine(RESUME_HINT);
    fake.emitExit(0);
  }, 0);
  await promise;

  assert.equal(classifyCalled, false);
  const modelAt = calls[0].args.indexOf("-m");
  assert.ok(modelAt >= 0);
  assert.equal(calls[0].args[modelAt + 1], "kimi-code/hard-model");
});
