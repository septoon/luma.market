import type {
  Analytics,
  AuthLoginResponse,
  AuthSessionResponse,
  DashboardSummary,
  Operation,
  PushPublicKeyResponse,
  ReportPeriod,
  UserProfileResponse,
} from "./types";

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";
const SESSION_KEY = "luma_market_session";
const USER_NAME_KEY = "luma_market_user_name";
const LEGACY_ORG_NAME_KEY = "luma_market_org_name";

export function setSessionToken(token: string, userName?: string) {
  localStorage.setItem(SESSION_KEY, token);
  localStorage.removeItem(LEGACY_ORG_NAME_KEY);
  if (userName) localStorage.setItem(USER_NAME_KEY, userName);
}

export function clearSessionToken() {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(USER_NAME_KEY);
  localStorage.removeItem(LEGACY_ORG_NAME_KEY);
}

function getSessionToken() {
  return localStorage.getItem(SESSION_KEY);
}

export function hasSessionToken() {
  return Boolean(getSessionToken());
}

export function getSavedUserName() {
  const value = localStorage.getItem(USER_NAME_KEY);
  if (!value || value === "Владелец" || value === "Пользователь") return null;
  return value;
}

export type ReportQuery = {
  period: ReportPeriod;
  date?: string;
};

function reportQuery(query: ReportQuery) {
  const params = new URLSearchParams({ period: query.period });
  if (query.date) params.set("date", query.date);
  return params.toString();
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(getSessionToken() ? { "X-Luma-Session": getSessionToken() ?? "" } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`API error ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export const api = {
  login: (phone: string, password: string) =>
    request<AuthLoginResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ phone, password }),
    }),
  selectOrg: (authId: string, orgGuid: string) =>
    request<AuthSessionResponse>("/auth/select-org", {
      method: "POST",
      body: JSON.stringify({ authId, orgGuid }),
    }),
  me: () => request<UserProfileResponse>("/me"),
  summary: (query: ReportQuery) => request<DashboardSummary>(`/summary?${reportQuery(query)}`),
  operations: (query: ReportQuery) => request<Operation[]>(`/operations?${reportQuery(query)}`),
  operation: (id: string) => request<Operation>(`/operations/${id}`),
  analytics: (query: ReportQuery) => request<Analytics>(`/analytics?${reportQuery(query)}`),
  pushPublicKey: () => request<PushPublicKeyResponse>("/push/public-key"),
  savePushSubscription: (subscription: PushSubscriptionJSON) =>
    request<{ ok: true }>("/push/subscriptions", {
      method: "POST",
      body: JSON.stringify(subscription),
    }),
  deletePushSubscription: (endpoint: string) =>
    request<{ ok: true }>("/push/subscriptions", {
      method: "DELETE",
      body: JSON.stringify({ endpoint }),
    }),
};
