import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

interface SessionRecord {
  acpSessionId: string;
  updatedAt: string;
}

interface StateFile {
  version: 1;
  sessions: Record<string, Record<string, SessionRecord>>;
}

export class SessionStateStore {
  private state: StateFile = { version: 1, sessions: {} };
  private loaded = false;

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as StateFile;
      if (parsed && parsed.version === 1 && parsed.sessions) {
        this.state = parsed;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
    this.loaded = true;
  }

  get(accountId: string, providerSessionKey: string): string | null {
    return this.state.sessions[accountId]?.[providerSessionKey]?.acpSessionId ?? null;
  }

  async set(accountId: string, providerSessionKey: string, acpSessionId: string): Promise<void> {
    this.state.sessions[accountId] ??= {};
    this.state.sessions[accountId][providerSessionKey] = {
      acpSessionId,
      updatedAt: new Date().toISOString(),
    };
    await this.save();
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2), "utf8");
    await rename(tmp, this.filePath);
  }
}
