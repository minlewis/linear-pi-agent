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
  return {
    data,
    get: async (id: string) => data.get(id),
    set: async (id: string, sessionId: string) => void data.set(id, sessionId),
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
});

test("buildKimiPrompt includes issue details, prompt context, and guidance", async () => {
  const { buildKimiPrompt } = await runnerModule();

  const prompt = buildKimiPrompt({
    action: "created",
    promptContext: "Customer asked for a fix.",
    guidance: [{ body: "Always run tests." }],
    agentSession: {
      id: "agent-session-1",
      issue: {
        identifier: "FOO-1",
        title: "Fix the bug",
        url: "https://linear.app/example/issue/FOO-1",
        description: "It is broken.",
      },
    },
  });

  assert.match(prompt, /Kimi/);
  assert.match(prompt, /FOO-1/);
  assert.match(prompt, /Fix the bug/);
  assert.match(prompt, /It is broken\./);
  assert.match(prompt, /Customer asked for a fix\./);
  assert.match(prompt, /Always run tests\./);
});

test("buildKimiFollowUpPrompt uses the follow-up body", async () => {
  const { buildKimiFollowUpPrompt } = await runnerModule();

  const prompt = buildKimiFollowUpPrompt({
    action: "prompted",
    agentActivity: { content: { body: "Also update the README." } },
    agentSession: { id: "agent-session-1" },
  });

  assert.match(prompt, /Also update the README\./);
});

test("buildKimiFollowUpPrompt falls back to prompt context", async () => {
  const { buildKimiFollowUpPrompt } = await runnerModule();

  const prompt = buildKimiFollowUpPrompt({
    action: "prompted",
    agentSession: { id: "agent-session-1", promptContext: "More context." },
  });

  assert.match(prompt, /More context\./);
});

test("runKimi spawns a fresh kimi prompt session for created actions", async () => {
  const { runKimi } = await runnerModule();
  const fake = fakeChild();
  const calls: SpawnCall[] = [];
  const store = memorySessionStore();

  const promise = runKimi(
    { action: "created", agentSession: { id: "agent-session-1", issue: { identifier: "FOO-1", title: "Fix" } } },
    { spawnProcess: spawnRecorder(fake, calls), sessionStore: store },
  );
  setTimeout(() => {
    fake.emitLine(JSON.stringify({ role: "assistant", content: "All done." }));
    fake.emitLine(RESUME_HINT);
    fake.emitExit(0);
  }, 0);
  const result = await promise;

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "kimi");
  assert.equal(calls[0].cwd, "/tmp/kimi-workdir");
  assert.deepEqual(calls[0].args.filter((arg) => arg === "-S"), []);
  assert.deepEqual(calls[0].args.filter((arg) => arg === "-m"), []);
  assert.ok(calls[0].args.includes("-p"));
  assert.ok(calls[0].args.includes("--output-format"));
  assert.ok(calls[0].args.includes("stream-json"));

  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.outputText, "All done.");
  assert.equal(result.kimiSessionId, "session_abc");
  assert.equal(store.data.get("agent-session-1"), "session_abc");
  assert.match(result.summary, /All done\./);
});

test("runKimi resumes the stored kimi session for follow-ups", async () => {
  const { runKimi } = await runnerModule();
  const fake = fakeChild();
  const calls: SpawnCall[] = [];
  const store = memorySessionStore({ "agent-session-1": "session_stored" });

  const promise = runKimi(
    { action: "prompted", agentActivity: { content: { body: "Follow up." } }, agentSession: { id: "agent-session-1" } },
    { spawnProcess: spawnRecorder(fake, calls), sessionStore: store },
  );
  setTimeout(() => {
    fake.emitLine(RESUME_HINT);
    fake.emitExit(0);
  }, 0);
  await promise;

  const resumeAt = calls[0].args.indexOf("-S");
  assert.ok(resumeAt >= 0);
  assert.equal(calls[0].args[resumeAt + 1], "session_stored");
});

test("runKimi starts a fresh session when no kimi session is stored", async () => {
  const { runKimi } = await runnerModule();
  const fake = fakeChild();
  const calls: SpawnCall[] = [];
  const store = memorySessionStore();

  const promise = runKimi(
    { action: "prompted", agentActivity: { content: { body: "Follow up." } }, agentSession: { id: "agent-session-1" } },
    { spawnProcess: spawnRecorder(fake, calls), sessionStore: store },
  );
  setTimeout(() => {
    fake.emitLine(RESUME_HINT);
    fake.emitExit(0);
  }, 0);
  await promise;

  assert.deepEqual(calls[0].args.filter((arg) => arg === "-S"), []);
});

test("runKimi reports a timeout and kills the child", async () => {
  const { runKimi } = await runnerModule();
  const fake = fakeChild();
  const calls: SpawnCall[] = [];

  const promise = runKimi(
    { action: "created", agentSession: { id: "agent-session-1" } },
    { spawnProcess: spawnRecorder(fake, calls), sessionStore: memorySessionStore() },
  );

  // The fake child only exits once killed; the 50ms run timeout must trigger the kill.
  setTimeout(() => fake.emitExit(null, "SIGTERM"), 500);
  const result = await promise;
  assert.equal(result.timedOut, true);
  assert.ok(fake.killCalls.includes("SIGTERM"));
});

test("runKimi surfaces spawn errors as a clear failure", async () => {
  const { runKimi } = await runnerModule();
  const fake = fakeChild();
  const calls: SpawnCall[] = [];

  const promise = runKimi(
    { action: "created", agentSession: { id: "agent-session-1" } },
    { spawnProcess: spawnRecorder(fake, calls), sessionStore: memorySessionStore() },
  );
  setTimeout(() => {
    const enoent = new Error("spawn kimi ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    fake.emitError(enoent);
    fake.emitExit(-2, "ENOENT" as NodeJS.Signals);
  }, 0);

  const result = await promise;
  assert.notEqual(result.exitCode, 0);
  assert.match(result.summary, /kimi login|install/i);
});

test("runKimi reports non-zero exits with stderr in the summary", async () => {
  const { runKimi } = await runnerModule();
  const fake = fakeChild();
  const calls: SpawnCall[] = [];

  const promise = runKimi(
    { action: "created", agentSession: { id: "agent-session-1" } },
    { spawnProcess: spawnRecorder(fake, calls), sessionStore: memorySessionStore() },
  );
  setTimeout(() => {
    fake.stderr.write("fatal: something broke\n");
    fake.emitExit(1);
  }, 0);
  const result = await promise;

  assert.equal(result.exitCode, 1);
  assert.match(result.summary, /something broke/);
});

test("abortKimiSession kills the running child", async () => {
  const { runKimi, abortKimiSession } = await runnerModule();
  const fake = fakeChild();
  const calls: SpawnCall[] = [];

  const promise = runKimi(
    { action: "created", agentSession: { id: "agent-session-1" } },
    { spawnProcess: spawnRecorder(fake, calls), sessionStore: memorySessionStore() },
  );

  setTimeout(async () => {
    const aborted = await abortKimiSession("agent-session-1");
    assert.equal(aborted, true);
    fake.emitExit(null, "SIGTERM");
  }, 20);

  const result = await promise;
  assert.ok(fake.killCalls.includes("SIGTERM"));
  assert.notEqual(result.exitCode, 0);
});

test("abortKimiSession returns false when nothing is running", async () => {
  const { abortKimiSession } = await runnerModule();

  assert.equal(await abortKimiSession("agent-session-missing"), false);
});
