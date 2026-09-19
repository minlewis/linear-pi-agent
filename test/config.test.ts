import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);

async function loadConfig(env: Record<string, string | undefined> = {}) {
  const { stdout } = await execFileAsync(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    `const { config, publicConfig } = await import("./src/config.ts");
console.log(JSON.stringify({ config, publicConfig: publicConfig() }));`,
  ], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DOTENV_CONFIG_PATH: "/dev/null",
      LINEAR_CLIENT_ID: "client",
      LINEAR_CLIENT_SECRET: "secret",
      LINEAR_WEBHOOK_SECRET: "webhook",
      INSTALL_SECRET: "",
      LINEAR_REDIRECT_URI: "https://example.com/linear/oauth/callback",
      BASE_URL: "https://example.com",
      KIMI_WORKDIR: "/tmp",
      KIMI_PROGRESS_DEBOUNCE_MS: "1234",
      KIMI_PROGRESS_HEARTBEAT_MS: "5678",
      KIMI_PROGRESS_LONG_TOOL_MS: "3456",
      KIMI_TIMEOUT_MS: "9012",
      ...env,
    },
  });

  return JSON.parse(stdout) as {
    config: {
      KIMI_WORKDIR: string;
      KIMI_COMMAND: string;
      KIMI_MODEL?: string;
      KIMI_SESSION_STORE_PATH: string;
      KIMI_PROGRESS_LONG_TOOL_MS: number;
    };
    publicConfig: {
      kimiWorkdir: string;
      kimiCommand: string;
      kimiModel?: string;
      kimiSessionStorePath: string;
      kimiProgressDebounceMs: number;
      kimiProgressHeartbeatMs: number;
      kimiProgressLongToolMs: number;
      kimiTimeoutMs: number;
    };
  };
}

test("KIMI_COMMAND defaults to kimi", async () => {
  const result = await loadConfig({ KIMI_COMMAND: undefined });

  assert.equal(result.config.KIMI_COMMAND, "kimi");
});

test("KIMI_COMMAND accepts a custom executable path", async () => {
  const result = await loadConfig({ KIMI_COMMAND: "/opt/kimi/bin/kimi" });

  assert.equal(result.config.KIMI_COMMAND, "/opt/kimi/bin/kimi");
});

test("KIMI_MODEL is unset by default and passed through when set", async () => {
  const unset = await loadConfig({ KIMI_MODEL: undefined });
  const set = await loadConfig({ KIMI_MODEL: "k2" });

  assert.equal(unset.config.KIMI_MODEL, undefined);
  assert.equal(set.config.KIMI_MODEL, "k2");
  assert.equal(set.publicConfig.kimiModel, "k2");
});

test("KIMI_SESSION_STORE_PATH defaults to ./data/kimi-sessions.json", async () => {
  const result = await loadConfig({ KIMI_SESSION_STORE_PATH: undefined });

  assert.equal(result.config.KIMI_SESSION_STORE_PATH, "./data/kimi-sessions.json");
});

test("publicConfig includes safe Kimi runtime settings", async () => {
  const result = await loadConfig({ KIMI_COMMAND: "/usr/local/bin/kimi" });

  assert.equal(result.publicConfig.kimiWorkdir, "/tmp");
  assert.equal(result.publicConfig.kimiCommand, "/usr/local/bin/kimi");
  assert.equal(result.publicConfig.kimiSessionStorePath, "./data/kimi-sessions.json");
  assert.equal(result.publicConfig.kimiProgressDebounceMs, 1234);
  assert.equal(result.publicConfig.kimiProgressHeartbeatMs, 5678);
  assert.equal(result.publicConfig.kimiProgressLongToolMs, 3456);
  assert.equal(result.publicConfig.kimiTimeoutMs, 9012);
});

test("KIMI_PROGRESS_LONG_TOOL_MS defaults to 30000", async () => {
  const result = await loadConfig({ KIMI_PROGRESS_LONG_TOOL_MS: undefined });

  assert.equal(result.config.KIMI_PROGRESS_LONG_TOOL_MS, 30_000);
});

test("KIMI_PROGRESS_LONG_TOOL_MS accepts custom values and zero", async () => {
  const custom = await loadConfig({ KIMI_PROGRESS_LONG_TOOL_MS: "45000" });
  const disabled = await loadConfig({ KIMI_PROGRESS_LONG_TOOL_MS: "0" });

  assert.equal(custom.config.KIMI_PROGRESS_LONG_TOOL_MS, 45_000);
  assert.equal(disabled.config.KIMI_PROGRESS_LONG_TOOL_MS, 0);
});

test("legacy PI_* variables are ignored and KIMI_WORKDIR is required", async () => {
  await assert.rejects(
    () => loadConfig({ KIMI_WORKDIR: undefined, PI_WORKDIR: "/tmp" }),
    /KIMI_WORKDIR/,
  );
});
