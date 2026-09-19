import "dotenv/config";
import { z } from "zod";

const emptyStringAsUndefined = (value: unknown) => value === "" ? undefined : value;

const ConfigSchema = z.object({
  LINEAR_CLIENT_ID: z.string().min(1),
  LINEAR_CLIENT_SECRET: z.string().min(1),
  LINEAR_WEBHOOK_SECRET: z.string().min(1),
  INSTALL_SECRET: z.preprocess(emptyStringAsUndefined, z.string().min(16).optional()),
  LINEAR_REDIRECT_URI: z.string().url(),
  BASE_URL: z.string().url(),
  KIMI_WORKDIR: z.string().min(1),
  KIMI_COMMAND: z.preprocess(emptyStringAsUndefined, z.string().trim().min(1).default("kimi")),
  KIMI_MODEL: z.preprocess(emptyStringAsUndefined, z.string().trim().min(1).optional()),
  KIMI_SESSION_STORE_PATH: z.string().default("./data/kimi-sessions.json"),
  KIMI_PROGRESS_DEBOUNCE_MS: z.coerce.number().int().positive().default(3_000),
  KIMI_PROGRESS_HEARTBEAT_MS: z.coerce.number().int().positive().default(300_000),
  KIMI_PROGRESS_LONG_TOOL_MS: z.coerce.number().int().nonnegative().default(30_000),
  KIMI_TIMEOUT_MS: z.coerce.number().int().positive().default(1_800_000),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(8787),
  TOKEN_STORE_PATH: z.string().default("./data/linear-tokens.json"),
  STATE_STORE_PATH: z.string().default("./data/oauth-states.json"),
});

export const config = ConfigSchema.parse(process.env);

export function publicConfig() {
  return {
    baseUrl: config.BASE_URL,
    redirectUri: config.LINEAR_REDIRECT_URI,
    installSecretConfigured: Boolean(config.INSTALL_SECRET),
    kimiWorkdir: config.KIMI_WORKDIR,
    kimiCommand: config.KIMI_COMMAND,
    kimiModel: config.KIMI_MODEL,
    kimiSessionStorePath: config.KIMI_SESSION_STORE_PATH,
    kimiProgressDebounceMs: config.KIMI_PROGRESS_DEBOUNCE_MS,
    kimiProgressHeartbeatMs: config.KIMI_PROGRESS_HEARTBEAT_MS,
    kimiProgressLongToolMs: config.KIMI_PROGRESS_LONG_TOOL_MS,
    kimiTimeoutMs: config.KIMI_TIMEOUT_MS,
    host: config.HOST,
    port: config.PORT,
    tokenStorePath: config.TOKEN_STORE_PATH,
    stateStorePath: config.STATE_STORE_PATH,
  };
}
