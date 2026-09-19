import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isErrnoCode } from "./errors.js";

export type KimiSessionStore = {
  get(agentSessionId: string): Promise<string | undefined>;
  getModel(agentSessionId: string): Promise<string | undefined>;
  set(agentSessionId: string, kimiSessionId: string, model?: string): Promise<void>;
};

type StoredEntry = {
  kimiSessionId: string;
  model?: string;
  updatedAt: string;
};

function isNotFound(error: unknown): boolean {
  return isErrnoCode(error, "ENOENT");
}

export class FileKimiSessionStore implements KimiSessionStore {
  constructor(private readonly filePath: string) {}

  async get(agentSessionId: string): Promise<string | undefined> {
    const data = await this.read();
    return data[agentSessionId]?.kimiSessionId;
  }

  async getModel(agentSessionId: string): Promise<string | undefined> {
    const data = await this.read();
    return data[agentSessionId]?.model;
  }

  async set(agentSessionId: string, kimiSessionId: string, model?: string): Promise<void> {
    const data = await this.read();
    data[agentSessionId] = { kimiSessionId, ...(model ? { model } : {}), updatedAt: new Date().toISOString() };
    await this.write(data);
  }

  private async read(): Promise<Record<string, StoredEntry>> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNotFound(error)) return {};
      throw error;
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, StoredEntry>;
      }
      return {};
    } catch {
      return {};
    }
  }

  private async write(data: Record<string, StoredEntry>): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }
}
