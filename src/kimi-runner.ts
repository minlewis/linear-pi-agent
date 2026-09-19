import { spawn, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import { config } from "./config.js";
import { isErrnoCode } from "./errors.js";
import { FileKimiSessionStore, type KimiSessionStore } from "./kimi-session-store.js";
import { handleKimiLine, ProgressReporter, redact } from "./progress.js";
import type { AgentSessionWebhook } from "./session-runner.js";

export const MAX_LINEAR_BODY_CHARS = 8_000;

const ABORT_GRACE_MS = 5_000;

export type KimiRunResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stderr: string;
  outputText: string;
  summary: string;
  elapsedMs: number;
  kimiSessionId?: string;
};

export type KimiRunnerDeps = {
  spawnProcess?: typeof spawn;
  sessionStore?: KimiSessionStore;
  nowMs?: () => number;
  classify?: (payload: AgentSessionWebhook) => Promise<TaskDifficulty | undefined>;
};

type ManagedRun = {
  child: ChildProcess;
  kill: () => void;
};

const activeRuns = new Map<string, ManagedRun>();
let defaultSessionStore: KimiSessionStore | undefined;

function getDefaultSessionStore(): KimiSessionStore {
  defaultSessionStore ??= new FileKimiSessionStore(config.KIMI_SESSION_STORE_PATH);
  return defaultSessionStore;
}

function guidanceText(payload: AgentSessionWebhook): string {
  const rules = payload.guidance?.flatMap((rule) => rule.body ? [rule.body] : []) ?? [];
  if (!rules.length) return "";
  return `\n\nLinear guidance:\n${rules.map((rule) => `- ${rule}`).join("\n")}`;
}

function promptContextOf(payload: AgentSessionWebhook): string | undefined {
  return payload.promptContext ?? payload.agentSession?.promptContext;
}

export function buildKimiPrompt(payload: AgentSessionWebhook): string {
  const issue = payload.agentSession?.issue;
  const promptContext = promptContextOf(payload);

  return [
    "You are running as Kimi, a Linear custom agent powered by Kimi Code.",
    "Work directly in this repository with full control. Make code changes when appropriate.",
    "Do not expose secrets. Be concise in your final summary for Linear.",
    "",
    issue ? "Linear issue:" : "Linear session:",
    issue?.identifier ? `- Identifier: ${issue.identifier}` : undefined,
    issue?.title ? `- Title: ${issue.title}` : undefined,
    issue?.url ? `- URL: ${issue.url}` : undefined,
    issue?.description ? `- Description:\n${issue.description}` : undefined,
    promptContext ? `\nLinear prompt context:\n${promptContext}` : undefined,
    guidanceText(payload),
    "",
    "When finished, summarize what changed, tests/checks run, and any remaining follow-up.",
  ].filter(Boolean).join("\n");
}

export function buildKimiFollowUpPrompt(payload: AgentSessionWebhook): string {
  const followUp = payload.agentActivity?.content?.body?.trim();
  if (followUp) {
    return [
      "Linear user follow-up:",
      followUp,
      "",
      "Continue from the existing session context. Be concise in your final summary for Linear.",
    ].join("\n");
  }

  const promptContext = promptContextOf(payload);
  if (promptContext) {
    return [
      "Linear follow-up context:",
      promptContext,
      "",
      "Continue from the existing session context. Be concise in your final summary for Linear.",
    ].join("\n");
  }

  return "Linear sent a follow-up event without message text. Continue from the existing session context and summarize any useful status.";
}

const CLASSIFY_TIMEOUT_MS = 45_000;

export type TaskDifficulty = "easy" | "hard";

type ClassifyDeps = {
  spawnProcess?: typeof spawn;
  timeoutMs?: number;
};

function buildClassificationPrompt(payload: AgentSessionWebhook): string {
  const issue = payload.agentSession?.issue;
  const promptContext = promptContextOf(payload);

  return [
    "You are classifying the difficulty of a coding task that a coding agent will receive from Linear.",
    "Classify it as exactly one word: easy or hard.",
    "",
    "easy: reading code to answer a question, tiny or single-file changes, docs or config tweaks, trivial fixes.",
    "hard: multi-file refactors, new features, non-trivial debugging, architecture decisions, large analysis tasks.",
    "",
    "When unsure, answer easy.",
    "",
    issue ? `Issue: ${issue.identifier ?? ""} ${issue.title ?? ""}`.trim() : "Issue: (none)",
    issue?.description ? `Description:\n${issue.description}` : undefined,
    promptContext ? `Additional context:\n${promptContext}` : undefined,
    "",
    "Reply with exactly one word: easy or hard.",
  ].filter(Boolean).join("\n");
}

export function parseDifficulty(text: string): TaskDifficulty | undefined {
  const normalized = text.trim().toLowerCase();
  if (/\bhard\b/.test(normalized)) return "hard";
  if (/\beasy\b/.test(normalized)) return "easy";
  return undefined;
}

export async function classifyTaskDifficulty(
  payload: AgentSessionWebhook,
  deps: ClassifyDeps = {},
): Promise<TaskDifficulty | undefined> {
  if (!config.KIMI_MODEL_EASY && !config.KIMI_MODEL_HARD) return undefined;

  const spawnProcess = deps.spawnProcess ?? spawn;
  const routerModel = config.KIMI_MODEL_ROUTER ?? config.KIMI_MODEL_EASY ?? config.KIMI_MODEL;
  const args = [
    "-p", buildClassificationPrompt(payload),
    ...(routerModel ? ["-m", routerModel] : []),
  ];

  let child: ChildProcess;
  try {
    child = spawnProcess(config.KIMI_COMMAND, args, { cwd: config.KIMI_WORKDIR, env: process.env });
  } catch {
    return undefined;
  }

  return new Promise<TaskDifficulty | undefined>((resolve) => {
    let stdout = "";
    let settled = false;
    const finish = (difficulty: TaskDifficulty | undefined) => {
      if (settled) return;
      settled = true;
      resolve(difficulty);
    };
    const timeout = setTimeout(() => {
      killChild(child);
      finish(undefined);
    }, deps.timeoutMs ?? CLASSIFY_TIMEOUT_MS);
    timeout.unref();
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.on("error", () => finish(undefined));
    child.on("exit", () => {
      clearTimeout(timeout);
      finish(parseDifficulty(stdout));
    });
  });
}

export function summarizeKimiResult(result: KimiRunResult): string {
  const combined = [result.outputText.trim(), result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : ""]
    .filter(Boolean)
    .join("\n\n");

  if (!combined) {
    return result.exitCode === 0 ? "kimi finished successfully without output." : "kimi failed without output.";
  }

  const safe = redact(combined);
  if (safe.length <= MAX_LINEAR_BODY_CHARS) return safe;
  return `${safe.slice(0, MAX_LINEAR_BODY_CHARS)}\n\n…output truncated…`;
}

function killChild(child: ChildProcess): void {
  if (child.killed) return;
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  const force = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }, ABORT_GRACE_MS);
  force.unref();
}

export async function runKimi(payload: AgentSessionWebhook, deps: KimiRunnerDeps = {}): Promise<KimiRunResult> {
  const agentSessionId = payload.agentSession?.id;
  if (!agentSessionId) throw new Error("agentSession.id is required to run kimi");

  const spawnProcess = deps.spawnProcess ?? spawn;
  const sessionStore = deps.sessionStore ?? getDefaultSessionStore();
  const nowMs = deps.nowMs ?? (() => performance.now());

  const isFollowUp = payload.action === "prompted";
  const resumeId = isFollowUp ? await sessionStore.get(agentSessionId) : undefined;
  const prompt = isFollowUp && resumeId ? buildKimiFollowUpPrompt(payload) : buildKimiPrompt(payload);

  let chosenModel = resumeId ? await sessionStore.getModel(agentSessionId) : undefined;
  if (!chosenModel && !resumeId && (config.KIMI_MODEL_EASY || config.KIMI_MODEL_HARD)) {
    const classify = deps.classify ?? ((p: AgentSessionWebhook) => classifyTaskDifficulty(p, { spawnProcess }));
    const difficulty = await classify(payload);
    chosenModel =
      difficulty === "hard" ? (config.KIMI_MODEL_HARD ?? config.KIMI_MODEL) :
      difficulty === "easy" ? (config.KIMI_MODEL_EASY ?? config.KIMI_MODEL) :
      config.KIMI_MODEL;
    console.log("task difficulty classified", { agentSessionId, difficulty, model: chosenModel });
  } else if (chosenModel) {
    console.log("reusing stored session model", { agentSessionId, model: chosenModel });
  }

  const args = [
    ...(resumeId ? ["-S", resumeId] : []),
    "-p", prompt,
    "--output-format", "stream-json",
    ...(chosenModel ? ["-m", chosenModel] : []),
  ];

  const startedAt = nowMs();
  const elapsed = () => Math.max(0, Math.round(nowMs() - startedAt));
  const reporter = new ProgressReporter({ agentSessionId });
  let latestAssistantText = "";
  let capturedSessionId: string | undefined;
  let persistPromise: Promise<void> | undefined;
  let stderr = "";
  let spawnError: Error | undefined;
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;

  let child: ChildProcess;
  try {
    child = spawnProcess(config.KIMI_COMMAND, args, { cwd: config.KIMI_WORKDIR, env: process.env });
  } catch (error) {
    const result: KimiRunResult = {
      exitCode: 1,
      signal: null,
      timedOut: false,
      stderr: "",
      outputText: "",
      summary: "",
      elapsedMs: elapsed(),
    };
    result.summary = spawnFailureSummary(error);
    return result;
  }

  activeRuns.set(agentSessionId, { child, kill: () => killChild(child) });

  const processLine = (line: string): void => {
    const event = handleKimiLine(line, reporter);
    if (event.sessionId) {
      capturedSessionId = event.sessionId;
      persistPromise = sessionStore.set(agentSessionId, event.sessionId, chosenModel).catch((error: Error) => {
        console.error("failed to persist kimi session mapping", { agentSessionId, message: error.message });
      });
    }
    if (event.assistantText) {
      // Publish the superseded text as an intermediate thought; the newest text
      // stays buffered as the candidate final answer.
      if (latestAssistantText) reporter.thought(latestAssistantText);
      latestAssistantText = event.assistantText;
    }
  };

  let pendingLine = "";
  const completion = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    let settled = false;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, signal });
    };

    let lineBuffer = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      lineBuffer += chunk.toString();
      let newlineIndex = lineBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = lineBuffer.slice(0, newlineIndex);
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        processLine(line);
        newlineIndex = lineBuffer.indexOf("\n");
      }
      pendingLine = lineBuffer;
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error: Error) => {
      spawnError = error;
      finish(null, null);
    });
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => finish(code, signal));
  });

  timeout = setTimeout(() => {
    timedOut = true;
    killChild(child);
  }, config.KIMI_TIMEOUT_MS);
  timeout.unref();

  reporter.startHeartbeat();
  try {
    const exit = await completion;

    if (pendingLine.trim()) processLine(pendingLine);
    await persistPromise;
    await reporter.flush();

    const result: KimiRunResult = {
      exitCode: exit.exitCode,
      signal: exit.signal,
      timedOut,
      stderr,
      outputText: latestAssistantText,
      summary: "",
      elapsedMs: elapsed(),
      kimiSessionId: capturedSessionId,
    };
    result.summary = spawnError ? spawnFailureSummary(spawnError) : summarizeKimiResult(result);
    return result;
  } finally {
    reporter.clearToolRuns();
    reporter.stopHeartbeat();
    if (timeout) clearTimeout(timeout);
    activeRuns.delete(agentSessionId);
  }
}

function spawnFailureSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const isMissing = isErrnoCode(error, "ENOENT");
  const detail = isMissing
    ? `The Kimi Code CLI ("${config.KIMI_COMMAND}") was not found. Install it on the host and run \`kimi login\` as the service user. (${message})`
    : `kimi failed to start: ${message}`;
  return redact(detail);
}

export async function abortKimiSession(agentSessionId: string): Promise<boolean> {
  const run = activeRuns.get(agentSessionId);
  if (!run) return false;
  run.kill();
  return true;
}
