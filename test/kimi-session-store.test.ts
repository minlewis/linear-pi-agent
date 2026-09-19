import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, before, test } from "node:test";

let dir: string;

before(async () => {
  process.env.LINEAR_CLIENT_ID = "client";
  process.env.LINEAR_CLIENT_SECRET = "secret";
  process.env.LINEAR_WEBHOOK_SECRET = "webhook";
  process.env.LINEAR_REDIRECT_URI = "https://example.com/linear/oauth/callback";
  process.env.BASE_URL = "https://example.com";
  process.env.KIMI_WORKDIR = "/tmp";
  dir = await mkdtemp(path.join(tmpdir(), "kimi-session-store-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  dir = await mkdtemp(path.join(tmpdir(), "kimi-session-store-"));
});

async function storeModule() {
  return import("../src/kimi-session-store.js");
}

test("get returns undefined when the store file is missing", async () => {
  const { FileKimiSessionStore } = await storeModule();
  const store = new FileKimiSessionStore(path.join(dir, "missing.json"));

  assert.equal(await store.get("agent-session-1"), undefined);
});

test("set then get returns the stored kimi session id", async () => {
  const { FileKimiSessionStore } = await storeModule();
  const file = path.join(dir, "sessions.json");
  const store = new FileKimiSessionStore(file);

  await store.set("agent-session-1", "session_abc");

  const reloaded = new FileKimiSessionStore(file);
  assert.equal(await reloaded.get("agent-session-1"), "session_abc");
});

test("the store file uses the documented mapping format", async () => {
  const { FileKimiSessionStore } = await storeModule();
  const file = path.join(dir, "sessions.json");
  const store = new FileKimiSessionStore(file);

  await store.set("agent-session-1", "session_abc");

  const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  const entry = raw["agent-session-1"] as Record<string, unknown>;
  assert.equal(entry.kimiSessionId, "session_abc");
  assert.equal(typeof entry.updatedAt, "string");
});

test("a corrupt store file behaves as empty and set recovers it", async () => {
  const { FileKimiSessionStore } = await storeModule();
  const file = path.join(dir, "sessions.json");
  await writeFile(file, "not json {", "utf8");
  const store = new FileKimiSessionStore(file);

  assert.equal(await store.get("agent-session-1"), undefined);

  await store.set("agent-session-1", "session_abc");
  const reloaded = new FileKimiSessionStore(file);
  assert.equal(await reloaded.get("agent-session-1"), "session_abc");
});

test("set overwrites an existing mapping for the same agent session", async () => {
  const { FileKimiSessionStore } = await storeModule();
  const file = path.join(dir, "sessions.json");
  const store = new FileKimiSessionStore(file);

  await store.set("agent-session-1", "session_old");
  await store.set("agent-session-1", "session_new");

  assert.equal(await store.get("agent-session-1"), "session_new");
});

test("mappings for different agent sessions do not collide", async () => {
  const { FileKimiSessionStore } = await storeModule();
  const file = path.join(dir, "sessions.json");
  const store = new FileKimiSessionStore(file);

  await store.set("agent-session-1", "session_a");
  await store.set("agent-session-2", "session_b");

  const reloaded = new FileKimiSessionStore(file);
  assert.equal(await reloaded.get("agent-session-1"), "session_a");
  assert.equal(await reloaded.get("agent-session-2"), "session_b");
});
