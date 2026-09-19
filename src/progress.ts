import { performance } from "node:perf_hooks";
import { config } from "./config.js";
import { createAgentActivity, type AgentActivityContent } from "./linear.js";

const MAX_PROGRESS_CHARS = 220;

const SAFE_FALLBACK_FIELDS = ["path", "file_path", "filePath", "query", "pattern", "glob", "url", "name", "title"];

type ProgressUpdate = {
  type: "thought" | "action";
  body: string;
  action?: string;
  parameter?: string;
  dedupeKey?: string;
};

type ToolRun = {
  toolName: string;
  display: string;
  startedAtMs: number;
};

type ProgressReporterOptions = {
  agentSessionId: string;
  debounceMs?: number;
  heartbeatMs?: number;
  longToolMs?: number;
  nowMs?: () => number;
  send?: (agentSessionId: string, content: AgentActivityContent) => Promise<unknown>;
  logger?: Pick<typeof console, "error">;
};

function isSensitiveName(name: string): boolean {
  const normalized = name.replace(/[-_]/g, "").toLowerCase();
  return normalized === "key"
    || normalized === "apikey"
    || normalized.endsWith("apikey")
    || normalized === "pass"
    || normalized.includes("token")
    || normalized.includes("secret")
    || normalized.includes("password")
    || normalized.includes("auth");
}

function sanitizeUrlText(text: string): string {
  try {
    const url = new URL(text);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveName(key)) url.searchParams.set(key, "redacted");
    }
    return url.toString();
  } catch {
    return text;
  }
}

function redactUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => sanitizeUrlText(url));
}

export function redact(text: string): string {
  return redactUrls(text)
    .replace(/Authorization:\s*Bearer\s+\S+/gi, "Authorization: Bearer [redacted]")
    .replace(/(--(?:token|api-key|apikey|key|secret|password|pass|auth)(?:\s+|=))\S+/gi, "$1[redacted]")
    .replace(/(^|[\s"'`])([A-Z0-9_.-]+)\s*([=:])\s*(\S+)/gi, (match, prefix: string, name: string, separator: string) => {
      if (name.toLowerCase() === "authorization") return match;
      return isSensitiveName(name) ? `${prefix}${name}${separator}[redacted]` : match;
    })
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "github_pat_[redacted]")
    .replace(/ghp_[A-Za-z0-9]{20,}/g, "ghp_[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-[redacted]");
}

export function truncate(text: string, maxChars = MAX_PROGRESS_CHARS): string {
  const clean = redact(text).replace(/\s+/g, " ").trim();
  return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars - 1)}…`;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const clean = value.replace(/\s+/g, " ").trim();
    return clean || undefined;
  }
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    const clean = firstString(item);
    if (clean) return clean;
  }
  return undefined;
}

function summarizeString(value: unknown): string | undefined {
  const clean = firstString(value);
  return clean ? truncate(clean) : undefined;
}

function summarizeSearch(pattern: unknown, scope: unknown): string | undefined {
  const safePattern = summarizeString(pattern);
  const safeScope = summarizeString(scope);
  if (safePattern && safeScope) return `${safePattern} in ${safeScope}`;
  return safePattern ?? (safeScope ? `in ${safeScope}` : undefined);
}

function summarizeUrl(value: unknown): string | undefined {
  const clean = firstString(value);
  return clean ? truncate(sanitizeUrlText(clean)) : undefined;
}

function summarizeToolTarget(toolName: string, args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;

  switch (toolName.toLowerCase()) {
    case "bash":
      return summarizeString(record.command ?? record.cmd);
    case "read":
    case "write":
    case "edit":
      return summarizeString(record.path ?? record.file_path ?? record.filePath);
    case "ls":
      return summarizeString(record.path) ?? ".";
    case "grep":
    case "rg":
      return summarizeSearch(record.pattern ?? record.query ?? record.regex, record.path ?? record.glob);
    case "find":
      return summarizeSearch(record.pattern ?? record.query ?? record.name, record.path);
    case "search":
    case "web_search":
      return summarizeString(record.query ?? record.queries);
    case "fetch_content":
      return summarizeUrl(record.url ?? record.urls);
  }

  for (const field of SAFE_FALLBACK_FIELDS) {
    const summary = field === "url" ? summarizeUrl(record[field]) : summarizeString(record[field]);
    if (summary) return summary;
  }
  return undefined;
}

export function toolDisplayText(toolName: string, args: unknown): string {
  const safeToolName = truncate(toolName, 80);
  const detail = summarizeToolTarget(toolName, args);
  return truncate(detail ? `${safeToolName}: ${detail}` : safeToolName);
}

export function toolProgressText(toolName: string, args: unknown): string {
  return truncate(`Running ${toolDisplayText(toolName, args)}`);
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

export function toolCompletionText(display: string, elapsedMs: number): string {
  const suffix = ` after ${formatElapsed(elapsedMs)}.`;
  const prefix = "Finished ";
  const maxDisplayChars = MAX_PROGRESS_CHARS - prefix.length - suffix.length;
  const safeDisplay = truncate(display, Math.max(1, maxDisplayChars));
  return truncate(`${prefix}${safeDisplay}${suffix}`);
}

export class ProgressReporter {
  private pending?: ProgressUpdate;
  private timer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private heartbeatStartedAt = 0;
  private lastSentAt = 0;
  private lastSentKey?: string;
  private toolRuns = new Map<string, ToolRun>();
  private readonly debounceMs: number;
  private readonly heartbeatMs: number;
  private readonly longToolMs: number;
  private readonly nowMs: () => number;
  private readonly send: (agentSessionId: string, content: AgentActivityContent) => Promise<unknown>;
  private readonly logger: Pick<typeof console, "error">;

  constructor(private readonly options: ProgressReporterOptions) {
    this.debounceMs = options.debounceMs ?? config.KIMI_PROGRESS_DEBOUNCE_MS;
    this.heartbeatMs = options.heartbeatMs ?? config.KIMI_PROGRESS_HEARTBEAT_MS;
    this.longToolMs = options.longToolMs ?? config.KIMI_PROGRESS_LONG_TOOL_MS;
    this.nowMs = options.nowMs ?? (() => performance.now());
    this.send = options.send ?? createAgentActivity;
    this.logger = options.logger ?? console;
  }

  thought(body: string): void {
    this.queue({ type: "thought", body: truncate(body) });
  }

  action(action: string, parameter: string): void {
    const body = parameter.trim() ? `${action}: ${parameter}` : action;
    this.queue({ type: "thought", body: truncate(body) });
  }

  toolStarted(toolCallId: string, toolName: string, args: unknown): void {
    const display = toolDisplayText(toolName, args);
    this.toolRuns.set(toolCallId, { toolName, display, startedAtMs: this.nowMs() });
    this.queue({ type: "thought", body: `Running ${display}`, dedupeKey: `tool-start:${toolCallId}` });
  }

  toolEnded(toolCallId: string, toolName: string, isError: boolean): void {
    const run = this.toolRuns.get(toolCallId);
    this.toolRuns.delete(toolCallId);
    const name = toolName || run?.toolName || "tool";

    if (isError) {
      this.queue({
        type: "thought",
        body: `${name} reported an error; Kimi is adjusting.`,
        dedupeKey: `tool-error:${toolCallId}`,
      });
      return;
    }

    if (!run || this.longToolMs === 0) return;
    const elapsedMs = this.nowMs() - run.startedAtMs;
    if (elapsedMs < this.longToolMs) return;

    this.queue({
      type: "thought",
      body: toolCompletionText(run.display, elapsedMs),
      dedupeKey: `tool-complete:${toolCallId}`,
    });
  }

  clearToolRuns(): void {
    this.toolRuns.clear();
  }

  startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatStartedAt = Date.now();
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatMs);
    this.heartbeatTimer.unref();
  }

  stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private heartbeat(): void {
    if (this.pending) return;
    if (this.lastSentAt && Date.now() - this.lastSentAt < this.heartbeatMs) return;
    const elapsedMinutes = Math.max(1, Math.round((Date.now() - this.heartbeatStartedAt) / 60_000));
    this.queue({
      type: "thought",
      body: `Kimi is still working (${elapsedMinutes} min).`,
      dedupeKey: `heartbeat:${elapsedMinutes}`,
    });
  }

  private queue(update: ProgressUpdate): void {
    const body = update.body.trim();
    if (!body) return;

    const next = { ...update, body, dedupeKey: update.dedupeKey ?? this.dedupeKey(update) };
    if (this.pending?.dedupeKey === next.dedupeKey) return;
    if (this.lastSentKey === next.dedupeKey) return;

    this.pending = next;
    const wait = Math.max(0, this.debounceMs - (Date.now() - this.lastSentAt));
    if (this.timer) return;
    this.timer = setTimeout(() => void this.flush(), wait);
    this.timer.unref();
  }

  private dedupeKey(update: ProgressUpdate): string {
    if (update.type === "action") return `action:${update.action ?? ""}:${update.parameter ?? update.body}`;
    return `thought:${update.body}`;
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const update = this.pending;
    this.pending = undefined;
    if (!update) return;

    try {
      if (update.type === "action") {
        await this.send(this.options.agentSessionId, {
          type: "action",
          action: update.action ?? "Processing",
          parameter: update.parameter ?? update.body,
        });
      } else {
        await this.send(this.options.agentSessionId, { type: "thought", body: update.body });
      }
      this.lastSentAt = Date.now();
      this.lastSentKey = update.dedupeKey;
    } catch (error) {
      this.logger.error("failed to post kimi progress", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

type KimiToolCall = {
  type?: string;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

function kimiToolCalls(event: Record<string, unknown>): KimiToolCall[] {
  if (!Array.isArray(event.tool_calls)) return [];
  return event.tool_calls.filter(
    (call): call is KimiToolCall => Boolean(call) && typeof call === "object",
  );
}

function parseToolArguments(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function kimiTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const maybeText = (part as { text?: unknown }).text;
      return typeof maybeText === "string" ? [maybeText] : [];
    })
    .join("\n");
}

function isErrorToolResult(content: unknown): boolean {
  const text = kimiTextContent(content).trimStart();
  return /^(error|exception|failed|failure)\b/i.test(text);
}

// Handles one line of Kimi Code `stream-json` (NDJSON) output. Malformed lines
// and unknown event shapes are ignored for forward compatibility. Returns the
// kimi session id when the line is a session.resume_hint meta event.
export function handleKimiLine(line: string, reporter: ProgressReporter): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;

  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!event || typeof event !== "object" || Array.isArray(event)) return undefined;

  const record = event as Record<string, unknown>;
  const role = typeof record.role === "string" ? record.role : undefined;

  if (role === "meta") {
    if (record.type === "session.resume_hint" && typeof record.session_id === "string") {
      return record.session_id;
    }
    return undefined;
  }

  if (role === "assistant") {
    for (const call of kimiToolCalls(record)) {
      if (call.type !== "function" || !call.id) continue;
      reporter.toolStarted(call.id, call.function?.name ?? "tool", parseToolArguments(call.function?.arguments));
    }

    const text = kimiTextContent(record.content).trim();
    if (text) reporter.thought(text);
    return undefined;
  }

  if (role === "tool") {
    const toolCallId = typeof record.tool_call_id === "string" ? record.tool_call_id : undefined;
    if (toolCallId) reporter.toolEnded(toolCallId, "", isErrorToolResult(record.content));
    return undefined;
  }

  return undefined;
}
