import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type LifePosOrganization = {
  guid: string;
  name: string;
};

export type LifePosSession = {
  lifePosToken: string;
  orgGuid: string;
  orgName: string;
  userName?: string;
  createdAt: number;
  lastAccessedAt?: number;
};

type PendingAuth = {
  lifePosToken: string;
  organizations: LifePosOrganization[];
  userName?: string;
  createdAt: number;
};

const sessions = new Map<string, LifePosSession>();
const pendingAuths = new Map<string, PendingAuth>();
const sessionStorePath =
  process.env.SESSION_STORE_PATH ?? resolve(dirname(fileURLToPath(import.meta.url)), "../data/sessions.json");
const ttlDays = Number(process.env.SESSION_TTL_DAYS ?? 30);
const ttlMs = 1000 * 60 * 60 * 24 * (Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays : 30);
const pendingTtlMs = 1000 * 60 * 10;
const touchIntervalMs = 1000 * 60 * 60;

function isSession(value: unknown): value is LifePosSession {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.lifePosToken === "string" &&
    typeof record.orgGuid === "string" &&
    typeof record.orgName === "string" &&
    typeof record.createdAt === "number"
  );
}

function loadSessions() {
  if (!existsSync(sessionStorePath)) return;

  try {
    const payload = JSON.parse(readFileSync(sessionStorePath, "utf8")) as unknown;
    if (!payload || typeof payload !== "object") return;
    const records = (payload as Record<string, unknown>).sessions;
    if (!records || typeof records !== "object") return;

    for (const [id, session] of Object.entries(records)) {
      if (isSession(session)) sessions.set(id, session);
    }
  } catch {
    sessions.clear();
  }
}

function persistSessions() {
  mkdirSync(dirname(sessionStorePath), { recursive: true });
  const payload = {
    version: 1,
    sessions: Object.fromEntries(sessions),
  };
  writeFileSync(sessionStorePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  chmodSync(sessionStorePath, 0o600);
}

function cleanup() {
  const now = Date.now();
  let sessionsChanged = false;
  for (const [id, session] of sessions) {
    if (now - (session.lastAccessedAt ?? session.createdAt) > ttlMs) {
      sessions.delete(id);
      sessionsChanged = true;
    }
  }
  for (const [id, pending] of pendingAuths) {
    if (now - pending.createdAt > pendingTtlMs) pendingAuths.delete(id);
  }
  if (sessionsChanged) persistSessions();
}

loadSessions();
cleanup();

export function createPendingAuth(lifePosToken: string, organizations: LifePosOrganization[], userName?: string) {
  cleanup();
  const authId = randomUUID();
  pendingAuths.set(authId, { lifePosToken, organizations, userName, createdAt: Date.now() });
  return authId;
}

export function createSession(lifePosToken: string, org: LifePosOrganization, userName?: string) {
  cleanup();
  const sessionToken = randomUUID();
  sessions.set(sessionToken, {
    lifePosToken,
    orgGuid: org.guid,
    orgName: org.name,
    userName,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
  });
  persistSessions();
  return sessionToken;
}

export function consumePendingAuth(authId: string, orgGuid: string) {
  cleanup();
  const pending = pendingAuths.get(authId);
  if (!pending) return null;

  const org = pending.organizations.find((item) => item.guid === orgGuid);
  if (!org) return null;

  pendingAuths.delete(authId);
  return {
    lifePosToken: pending.lifePosToken,
    org,
    userName: pending.userName,
  };
}

export function getSession(sessionToken: string | undefined) {
  cleanup();
  if (!sessionToken) return null;
  const session = sessions.get(sessionToken);
  if (!session) return null;

  const now = Date.now();
  if (now - (session.lastAccessedAt ?? session.createdAt) > touchIntervalMs) {
    session.lastAccessedAt = now;
    persistSessions();
  }

  return session;
}

export function deleteSession(sessionToken: string | undefined) {
  cleanup();
  if (!sessionToken) return false;
  const isDeleted = sessions.delete(sessionToken);
  if (isDeleted) persistSessions();
  return isDeleted;
}
