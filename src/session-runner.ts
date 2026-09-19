import { performance } from "node:perf_hooks";
import { createAgentActivity, type AgentActivityContent } from "./linear.js";
import {
  abortKimiSession,
  MAX_LINEAR_BODY_CHARS,
  runKimi,
  type KimiRunResult,
} from "./kimi-runner.js";
import { formatElapsed } from "./progress.js";

export type SessionRunnerDeps = {
  run?: (payload: AgentSessionWebhook) => Promise<KimiRunResult>;
  abort?: (agentSessionId: string) => Promise<boolean>;
  postActivity?: (agentSessionId: string, content: AgentActivityContent) => Promise<unknown>;
};

type ResolvedSessionDeps = {
  run: (payload: AgentSessionWebhook) => Promise<KimiRunResult>;
  abort: (agentSessionId: string) => Promise<boolean>;
  postActivity: (agentSessionId: string, content: AgentActivityContent) => Promise<unknown>;
};

function resolveDeps(deps: SessionRunnerDeps): ResolvedSessionDeps {
  return {
    run: deps.run ?? runKimi,
    abort: deps.abort ?? abortKimiSession,
    postActivity: deps.postActivity ?? createAgentActivity,
  };
}

type SessionState = {
  running: boolean;
  pendingPayload?: AgentSessionWebhook;
  lastStartedAtMs?: number;
};

export type AgentSessionWebhook = {
  action?: string;
  agentActivity?: {
    content?: {
      body?: string;
      type?: string;
    };
  };
  agentSession?: {
    id?: string;
    promptContext?: string;
    issue?: {
      identifier?: string;
      title?: string;
      url?: string;
      description?: string | null;
    } | null;
  };
  promptContext?: string;
  guidance?: Array<{ body?: string; origin?: unknown }>;
};

const sessions = new Map<string, SessionState>();

function issueLabel(payload: AgentSessionWebhook): string {
  const issue = payload.agentSession?.issue;
  return issue?.identifier ? `${issue.identifier}: ${issue.title ?? "Untitled"}` : "Linear agent session";
}

function isStopPayload(payload: AgentSessionWebhook): boolean {
  const action = payload.action?.toLowerCase();
  if (action && ["cancel", "canceled", "cancelled", "stop", "stopped", "abort", "aborted"].includes(action)) {
    return true;
  }

  const body = payload.agentActivity?.content?.body?.trim().toLowerCase();
  return body === "stop" || body === "stopped" || body === "cancel" || body === "cancelled" || body === "canceled";
}

function elapsedSince(startedAtMs?: number): number | undefined {
  if (startedAtMs === undefined) return undefined;
  return Math.max(0, Math.round(performance.now() - startedAtMs));
}

export function finalResponseBody(summary: string, elapsedMs: number): string {
  const footer = `\n\n_Run completed in ${formatElapsed(elapsedMs)}._`;
  if (summary.length + footer.length <= MAX_LINEAR_BODY_CHARS) return `${summary}${footer}`;

  const summaryLength = Math.max(0, MAX_LINEAR_BODY_CHARS - footer.length);
  return `${summary.slice(0, summaryLength)}${footer}`;
}

function finalErrorReason(result: KimiRunResult): string {
  return result.timedOut
    ? `kimi timed out after ${formatElapsed(result.elapsedMs)}`
    : `kimi failed after ${formatElapsed(result.elapsedMs)}`;
}

export function finalErrorBody(result: KimiRunResult): string {
  return `${finalErrorReason(result)}\n\n${result.summary}`;
}

export function stopActivityBody(aborted: boolean, elapsedMs?: number): string {
  if (!aborted) return "Stop requested; no active kimi run was in progress.";
  return elapsedMs === undefined ? "Stopped by user." : `Stopped by user after ${formatElapsed(elapsedMs)}.`;
}

export function crashActivityBody(error: Error, elapsedMs?: number): string {
  const prefix = elapsedMs === undefined
    ? "Kimi failed to start or run kimi"
    : `Kimi failed to start or run kimi after ${formatElapsed(elapsedMs)}`;
  return `${prefix}: ${error.message}`;
}

export async function handleAgentSessionWebhook(payload: AgentSessionWebhook, deps: SessionRunnerDeps = {}): Promise<void> {
  const agentSessionId = payload.agentSession?.id;
  if (!agentSessionId) {
    console.warn("agent session webhook missing agentSession.id");
    return;
  }

  const resolved = resolveDeps(deps);
  const state = sessions.get(agentSessionId) ?? { running: false };
  sessions.set(agentSessionId, state);

  if (isStopPayload(payload)) {
    console.log("agent session stop requested", { agentSessionId, action: payload.action, running: state.running });
    const elapsedMs = elapsedSince(state.lastStartedAtMs);
    state.pendingPayload = undefined;
    state.running = false;
    state.lastStartedAtMs = undefined;
    const aborted = await resolved.abort(agentSessionId);
    await resolved.postActivity(agentSessionId, {
      type: "error",
      body: stopActivityBody(aborted, elapsedMs),
    });
    return;
  }

  if (payload.action === "created") {
    startRun(agentSessionId, payload, state, resolved);
    return;
  }

  if (payload.action === "prompted") {
    if (state.running) {
      state.pendingPayload = payload;
      await resolved.postActivity(agentSessionId, {
        type: "thought",
        body: "Kimi received your follow-up. It will run after the current kimi task finishes.",
      });
      return;
    }

    startRun(agentSessionId, payload, state, resolved);
  }
}

function startRun(agentSessionId: string, payload: AgentSessionWebhook, state: SessionState, deps: ResolvedSessionDeps): void {
  if (state.running) {
    state.pendingPayload = payload;
    void deps.postActivity(agentSessionId, {
      type: "thought",
      body: "A Kimi run is already active for this session; this request is queued.",
    }).catch((error: Error) => console.error("failed to create queued activity", { message: error.message }));
    return;
  }

  state.running = true;
  state.lastStartedAtMs = performance.now();

  void runSession(agentSessionId, payload, state, deps).catch(async (error: Error) => {
    const elapsedMs = elapsedSince(state.lastStartedAtMs);
    state.running = false;
    state.lastStartedAtMs = undefined;
    console.error("kimi run crashed", { agentSessionId, message: error.message });
    await deps.postActivity(agentSessionId, {
      type: "error",
      body: crashActivityBody(error, elapsedMs),
    }).catch((activityError: Error) => {
      console.error("failed to create kimi crash activity", { message: activityError.message });
    });
  });
}

async function runSession(agentSessionId: string, payload: AgentSessionWebhook, state: SessionState, deps: ResolvedSessionDeps): Promise<void> {
  console.log("kimi run started", { agentSessionId });
  await deps.postActivity(agentSessionId, {
    type: "thought",
    body: `Kimi received ${issueLabel(payload)} and started working.`,
  }).catch((error: Error) => {
    console.error("failed to create start activity", { agentSessionId, message: error.message });
  });

  const result = await deps.run(payload);
  console.log("kimi run finished", {
    agentSessionId,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    elapsedMs: result.elapsedMs,
  });

  if (result.exitCode === 0 && !result.timedOut) {
    await deps.postActivity(agentSessionId, {
      type: "response",
      body: finalResponseBody(result.summary, result.elapsedMs),
    });
    console.log("linear response activity posted", { agentSessionId });

  } else {
    const reason = finalErrorReason(result);
    await deps.postActivity(agentSessionId, {
      type: "error",
      body: finalErrorBody(result),
    });
    console.log("linear error activity posted", { agentSessionId, reason });
  }

  // Mark run state as not running once run attempt finishes.
  state.running = false;
  state.lastStartedAtMs = undefined;

  const pendingPayload = state.pendingPayload;
  if (pendingPayload) {
    state.pendingPayload = undefined;
    startRun(agentSessionId, pendingPayload, state, deps);
  }
}
