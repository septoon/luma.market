import { randomUUID } from "node:crypto";

export type LifePosOrganization = {
  guid: string;
  name: string;
};

export type LifePosSession = {
  lifePosToken: string;
  orgGuid: string;
  orgName: string;
  createdAt: number;
};

type PendingAuth = {
  lifePosToken: string;
  organizations: LifePosOrganization[];
  createdAt: number;
};

const sessions = new Map<string, LifePosSession>();
const pendingAuths = new Map<string, PendingAuth>();
const ttlMs = 1000 * 60 * 60 * 12;
const pendingTtlMs = 1000 * 60 * 10;

function cleanup() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > ttlMs) sessions.delete(id);
  }
  for (const [id, pending] of pendingAuths) {
    if (now - pending.createdAt > pendingTtlMs) pendingAuths.delete(id);
  }
}

export function createPendingAuth(lifePosToken: string, organizations: LifePosOrganization[]) {
  cleanup();
  const authId = randomUUID();
  pendingAuths.set(authId, { lifePosToken, organizations, createdAt: Date.now() });
  return authId;
}

export function createSession(lifePosToken: string, org: LifePosOrganization) {
  cleanup();
  const sessionToken = randomUUID();
  sessions.set(sessionToken, {
    lifePosToken,
    orgGuid: org.guid,
    orgName: org.name,
    createdAt: Date.now(),
  });
  return sessionToken;
}

export function createSessionFromPending(authId: string, orgGuid: string) {
  cleanup();
  const pending = pendingAuths.get(authId);
  if (!pending) return null;

  const org = pending.organizations.find((item) => item.guid === orgGuid);
  if (!org) return null;

  pendingAuths.delete(authId);
  return {
    sessionToken: createSession(pending.lifePosToken, org),
    org,
  };
}

export function getSession(sessionToken: string | undefined) {
  cleanup();
  if (!sessionToken) return null;
  return sessions.get(sessionToken) ?? null;
}
