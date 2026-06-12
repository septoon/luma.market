import { analytics, operations, summary } from "./mockData.js";
import {
  buildAnalytics,
  buildDashboardSummary,
  getReportPeriod,
  mapSalesToOperations,
  type LifePosPaymentInfo,
  type LifePosSalesResponse,
} from "./lifePosMapper.js";
import type { LifePosOrganization, LifePosSession } from "./sessionStore.js";
import type { ReportRange } from "./types.js";

const apiBase = process.env.LIFE_POS_API_BASE ?? "https://api.life-pos.ru";
const lifePosToken = process.env.LIFE_POS_TOKEN;
const orgGuid = process.env.LIFE_POS_ORG_GUID;
const clientId = process.env.LIFE_POS_CLIENT_ID ?? "726f79ad-5af6-4eae-bbd4-66f84313cd35";
const cacheTtlMs = 15_000;
const salesCache = new Map<string, { expiresAt: number; response: LifePosSalesResponse }>();

type LifePosTerminalResponse = {
  items?: Array<{
    guid?: unknown;
  }>;
};

type LifePosTransaction = {
  amount?: {
    value?: unknown;
  };
  payment_type?: unknown;
  operation?: unknown;
  status?: unknown;
  card_number?: unknown;
  meta_data?: {
    purpose?: unknown;
  };
};

type LifePosTransactionResponse = {
  items?: LifePosTransaction[];
};

function isConfigured() {
  return Boolean(lifePosToken && orgGuid);
}

async function lifePosRequest<T>(path: string): Promise<T> {
  if (!isConfigured()) {
    throw new Error("Life POS is not configured");
  }

  const response = await fetch(`${apiBase}${path}`, {
    headers: {
      Authorization: `Bearer ${lifePosToken}`,
      "Accept-Language": "ru-RU",
      "X-LP-Client-Identifier": clientId,
      "X-LP-Client-Type": "WebApp",
    },
  });

  if (!response.ok) {
    throw new Error(`Life POS request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

async function lifePosSessionRequest<T>(session: LifePosSession, path: string): Promise<T> {
  return lifePosTokenRequest<T>(session.lifePosToken, path);
}

async function lifePosTokenRequest<T>(token: string, path: string): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Accept-Language": "ru-RU",
      "X-LP-Client-Identifier": clientId,
      "X-LP-Client-Type": "WebApp",
    },
  });

  if (!response.ok) {
    throw new Error(`Life POS request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

function sessionKey(session?: LifePosSession | null) {
  if (session) return `session:${session.orgGuid}:${session.lifePosToken.slice(-10)}`;
  if (isConfigured()) return `env:${orgGuid}:${lifePosToken?.slice(-10)}`;
  return "mock";
}

async function fetchSalesPage(session: LifePosSession | null | undefined, pageToken: string | undefined, range?: ReportRange) {
  const query = new URLSearchParams({
    presentation: "full",
    order_by: "opened_at_desc",
    include_items_total: "true",
    selection: "all",
  });
  if (pageToken) query.set("page_token", pageToken);
  if (range) {
    const period = getReportPeriod(range);
    query.set("opened_at_from", period.start.toISOString());
    query.set("opened_at_to", period.end.toISOString());
  }
  const path = `/orgs/${session?.orgGuid ?? orgGuid}/deals/sales?${query.toString()}`;

  return session ? lifePosSessionRequest<LifePosSalesResponse>(session, path) : lifePosRequest<LifePosSalesResponse>(path);
}

async function orgRequest<T>(session: LifePosSession | null | undefined, path: string): Promise<T> {
  if (session) return lifePosSessionRequest<T>(session, path);
  return lifePosRequest<T>(path);
}

function transactionRangeQuery(range?: ReportRange) {
  const query = new URLSearchParams({
    presentation: "full",
    order_by: "registered_at_desc",
  });
  if (range) {
    const period = getReportPeriod(range);
    query.set("registered_at_from", period.start.toISOString());
    query.set("registered_at_to", period.end.toISOString());
  }
  return query;
}

function cardLabel(transaction: LifePosTransaction) {
  const cardNumber = readText(transaction.card_number);
  return cardNumber ? `Карта ${cardNumber.replaceAll("*", "•")}` : "Карта";
}

function transactionPaymentInfo(kind: "bank" | "quick-payments", transaction: LifePosTransaction): LifePosPaymentInfo | null {
  if (readText(transaction.status) !== "Completed" || readText(transaction.operation) !== "Payment") return null;
  if (kind === "bank") return { kind: "card", label: cardLabel(transaction) };
  return { kind: "sbp", label: "СБП" };
}

async function fetchTransactionPaymentMap(session: LifePosSession | null | undefined, range?: ReportRange) {
  const result = new Map<string, LifePosPaymentInfo>();
  const org = session?.orgGuid ?? orgGuid;
  if (!org) return result;

  for (const kind of ["bank", "quick-payments"] as const) {
    const terminals = await orgRequest<LifePosTerminalResponse>(session, `/orgs/${org}/terminals/${kind}?presentation=full`).catch(
      () => null,
    );
    for (const terminal of terminals?.items ?? []) {
      const terminalGuid = readText(terminal.guid);
      if (!terminalGuid) continue;
      const query = transactionRangeQuery(range);
      const transactions = await orgRequest<LifePosTransactionResponse>(
        session,
        `/orgs/${org}/terminals/${kind}/${terminalGuid}/transactions?${query.toString()}`,
      ).catch(() => null);
      for (const transaction of transactions?.items ?? []) {
        const purpose = readText(transaction.meta_data?.purpose);
        const paymentInfo = transactionPaymentInfo(kind, transaction);
        if (purpose && paymentInfo) result.set(purpose, paymentInfo);
      }
    }
  }

  return result;
}

async function enrichSalesWithPayments(session: LifePosSession | null | undefined, sales: LifePosSalesResponse, range?: ReportRange) {
  const paymentBySaleNumber = await fetchTransactionPaymentMap(session, range);
  const items = (sales.items ?? []).map((sale) => {
    const number = readText(sale.number);
    const paymentInfo = number ? paymentBySaleNumber.get(number) : null;
    if (paymentInfo) return { ...sale, payment_info: paymentInfo };
    if (readText(sale.payment_status) === "Paid" && moneyValue(sale.total_sum) > 0) {
      return { ...sale, payment_info: { kind: "cash", label: "Наличные" } satisfies LifePosPaymentInfo };
    }
    return sale;
  });

  return { ...sales, items };
}

async function getSalesResponse(session?: LifePosSession | null, range?: ReportRange) {
  if (!session && !isConfigured()) return null;

  const key = `${sessionKey(session)}:${range?.period ?? "all"}:${range?.date ?? ""}`;
  const cached = salesCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.response;

  const firstPage = await fetchSalesPage(session, undefined, range);
  const items = [...(firstPage.items ?? [])];
  let nextPageToken = firstPage.next_page_token;

  for (let page = 2; nextPageToken && page <= 10; page += 1) {
    const nextPage = await fetchSalesPage(session, nextPageToken, range);
    items.push(...(nextPage.items ?? []));
    nextPageToken = nextPage.next_page_token;
  }

  const response = await enrichSalesWithPayments(session, { ...firstPage, items }, range);
  salesCache.set(key, { expiresAt: Date.now() + cacheTtlMs, response });
  return response;
}

function readToken(payload: unknown) {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const token = record.token ?? record.access_token ?? record.accessToken;
  return typeof token === "string" && token.length > 0 ? token : null;
}

function readText(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function moneyValue(value: { value?: unknown } | undefined) {
  return typeof value?.value === "number" && Number.isFinite(value.value) ? value.value / 100 : 0;
}

function readUserNameFromRecord(record: Record<string, unknown>): string | null {
  const direct =
    readText(record.name) ??
    readText(record.full_name) ??
    readText(record.fullName) ??
    readText(record.display_name) ??
    readText(record.displayName) ??
    readText(record.fio) ??
    readText(record.email) ??
    readText(record.phone);
  if (direct) return direct;

  const firstName = readText(record.first_name) ?? readText(record.firstName);
  const lastName = readText(record.last_name) ?? readText(record.lastName);
  const composed = [firstName, lastName].filter(Boolean).join(" ").trim();
  return composed || null;
}

function readUserName(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;

  const direct = readUserNameFromRecord(record);
  if (direct) return direct;

  const data = record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : null;
  const nestedRecords = [record.user, record.employee, record.account, record.profile, data?.user, data?.employee].filter(
    (item): item is Record<string, unknown> => Boolean(item && typeof item === "object"),
  );

  for (const nested of nestedRecords) {
    const name = readUserNameFromRecord(nested);
    if (name) return name;
  }

  return undefined;
}

function readCurrentEmployeeName(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  return (
    readText(record.name) ??
    readText(record.full_name) ??
    readText(record.fullName) ??
    readText(record.display_name) ??
    readText(record.displayName) ??
    readText(record.username) ??
    undefined
  );
}

function readOrganizations(payload: unknown): LifePosOrganization[] {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const data = record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : {};
  const items = Array.isArray(payload)
    ? payload
    : Array.isArray(record.items)
      ? record.items
      : Array.isArray(record.organizations)
        ? record.organizations
        : Array.isArray(data.items)
          ? data.items
          : [];

  return items
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const org = item as Record<string, unknown>;
      const guid = org.guid ?? org.org_guid ?? org.id;
      const name = org.name ?? org.title ?? org.short_name ?? org.shortName ?? guid;
      if (typeof guid !== "string" || !guid) return null;
      return {
        guid,
        name: typeof name === "string" ? name : guid,
      };
    })
    .filter((item): item is LifePosOrganization => Boolean(item));
}

export const lifePosClient = {
  isConfigured,
  async signInByPhone(phone: string, password: string) {
    const response = await fetch(`${apiBase}/auth/sign-in-by-phone`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept-Language": "ru-RU",
        "X-LP-Client-Identifier": clientId,
        "X-LP-Client-Type": "WebApp",
      },
      body: JSON.stringify({ phone, password }),
    });

    if (!response.ok) {
      throw new Error(`Life POS auth failed: ${response.status}`);
    }

    const payload = await response.json();
    const token = readToken(payload);
    if (!token) {
      throw new Error("Life POS auth response does not contain token");
    }

    return {
      token,
      userName: readUserName(payload),
    };
  },
  async listOrganizations(token: string) {
    const response = await fetch(`${apiBase}/orgs?presentation=full`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Accept-Language": "ru-RU",
        "X-LP-Client-Identifier": clientId,
        "X-LP-Client-Type": "WebApp",
      },
    });

    if (!response.ok) {
      throw new Error(`Life POS organizations request failed: ${response.status}`);
    }

    const organizations = readOrganizations(await response.json());
    if (organizations.length === 0) {
      throw new Error("Life POS account has no available organizations");
    }

    return organizations;
  },
  async getCurrentUserNameByToken(token: string, targetOrgGuid: string) {
    const query = new URLSearchParams({
      presentation: "full",
      include_permissions: "false",
    });
    const payload = await lifePosTokenRequest<unknown>(token, `/orgs/${targetOrgGuid}/me?${query.toString()}`);
    return readCurrentEmployeeName(payload);
  },
  async getCurrentUserName(session?: LifePosSession | null) {
    if (session?.userName) return session.userName;
    if (session) return this.getCurrentUserNameByToken(session.lifePosToken, session.orgGuid);
    if (lifePosToken && orgGuid) return this.getCurrentUserNameByToken(lifePosToken, orgGuid);
    return undefined;
  },
  async getSummary(session?: LifePosSession | null, range?: ReportRange) {
    const sales = await getSalesResponse(session, range);
    if (sales) return buildDashboardSummary(sales.items ?? [], range);
    return summary;
  },
  async getOperations(session?: LifePosSession | null, range?: ReportRange) {
    const sales = await getSalesResponse(session, range);
    if (sales) return mapSalesToOperations(sales.items ?? [], range);
    return operations;
  },
  async getOperation(id: string, session?: LifePosSession | null) {
    const sales = await getSalesResponse(session);
    if (sales) {
      const mapped = mapSalesToOperations(sales.items ?? []);
      return mapped.find((operation) => operation.id === id) ?? mapped[0];
    }
    return operations.find((operation) => operation.id === id) ?? operations[0];
  },
  async getAnalytics(session?: LifePosSession | null, range?: ReportRange) {
    const sales = await getSalesResponse(session, range);
    if (sales) return buildAnalytics(sales.items ?? [], range);
    return analytics;
  },
};
