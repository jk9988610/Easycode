import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

export interface StoredSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: unknown[];
}

function sessionsDir(): string {
  const dir = path.join(app.getPath("userData"), "sessions");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fileFor(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(sessionsDir(), safe + ".json");
}

export function listSessions(): { id: string; title: string; updatedAt: number }[] {
  const dir = sessionsDir();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const list: { id: string; title: string; updatedAt: number }[] = [];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, f), "utf8");
      const data = JSON.parse(raw) as StoredSession;
      list.push({ id: data.id, title: data.title, updatedAt: data.updatedAt });
    } catch {
      /* skip broken file */
    }
  }
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  return list;
}

export function loadSession(id: string): StoredSession | null {
  const p = fileFor(id);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as StoredSession;
  } catch {
    return null;
  }
}

export function saveSession(session: StoredSession): boolean {
  try {
    session.updatedAt = Date.now();
    fs.writeFileSync(fileFor(session.id), JSON.stringify(session, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

export function deleteSession(id: string): boolean {
  const p = fileFor(id);
  if (!fs.existsSync(p)) return false;
  try {
    fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}