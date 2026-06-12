import { randomUUID } from "node:crypto";
const sessions = new Map();
const pendingAuths = new Map();
const ttlMs = 1000 * 60 * 60 * 12;
const pendingTtlMs = 1000 * 60 * 10;
function cleanup() {
    const now = Date.now();
    for (const [id, session] of sessions) {
        if (now - session.createdAt > ttlMs)
            sessions.delete(id);
    }
    for (const [id, pending] of pendingAuths) {
        if (now - pending.createdAt > pendingTtlMs)
            pendingAuths.delete(id);
    }
}
export function createPendingAuth(lifePosToken, organizations) {
    cleanup();
    const authId = randomUUID();
    pendingAuths.set(authId, { lifePosToken, organizations, createdAt: Date.now() });
    return authId;
}
export function createSession(lifePosToken, org) {
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
export function createSessionFromPending(authId, orgGuid) {
    cleanup();
    const pending = pendingAuths.get(authId);
    if (!pending)
        return null;
    const org = pending.organizations.find((item) => item.guid === orgGuid);
    if (!org)
        return null;
    pendingAuths.delete(authId);
    return {
        sessionToken: createSession(pending.lifePosToken, org),
        org,
    };
}
export function getSession(sessionToken) {
    cleanup();
    if (!sessionToken)
        return null;
    return sessions.get(sessionToken) ?? null;
}
