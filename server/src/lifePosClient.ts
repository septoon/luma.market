import {
  buildAnalytics,
  buildDashboardSummary,
  findFiscalReceiptUrl,
  findFiscalRegistrarGuid,
  getReportComparisonPeriod,
  getReportPeriod,
  mapSaleToOperation,
  mapSalesToOperations,
  type LifePosSale,
  type LifePosPaymentInfo,
  type LifePosSalesResponse,
} from "./lifePosMapper.js";
import type { LifePosOrganization, LifePosSession } from "./sessionStore.js";
import type { DashboardSummary, Operation, ReportRange, ShiftStatus } from "./types.js";

const apiBase = process.env.LIFE_POS_API_BASE ?? "https://api.life-pos.ru";
const clientId = process.env.LIFE_POS_CLIENT_ID ?? "726f79ad-5af6-4eae-bbd4-66f84313cd35";
const cacheTtlMs = 15_000;
const salesCache = new Map<string, { expiresAt: number; response: LifePosSalesResponse }>();
const shiftDocumentsCache = new Map<string, { expiresAt: number; promise: Promise<ShiftFiscalDocument[]> }>();

type SalesFetchRange = ReportRange | { start: Date; end: Date };

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

type LifePosFiscalRegistrar = {
  guid?: unknown;
  name?: unknown;
  title?: unknown;
  serial_number?: unknown;
  number?: unknown;
};

type LifePosFiscalRegistrarResponse = {
  items?: LifePosFiscalRegistrar[];
};

type LifePosFiscalDocument = {
  guid?: unknown;
  ofd_url?: unknown;
  ofdUrl?: unknown;
  receipt_url?: unknown;
  receiptUrl?: unknown;
  fiscal_form?: unknown;
  fiscal_status?: unknown;
  status?: unknown;
  issued_at?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  cashier?: unknown;
  employee?: unknown;
  operator?: unknown;
  user?: unknown;
  registrar?: LifePosFiscalRegistrar;
  fiscal_registrar?: LifePosFiscalRegistrar;
  fiscalRegistrar?: LifePosFiscalRegistrar;
};

type LifePosFiscalDocumentResponse = {
  items?: LifePosFiscalDocument[];
};

type ShiftInfo = {
  status: ShiftStatus;
  openedAt: Date | null;
  closedAt: Date | null;
  cashbox: string | null;
};

type ShiftFiscalDocument = LifePosFiscalDocument & {
  registrar?: LifePosFiscalRegistrar;
};

async function parseLifePosResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) return null as T;
  return JSON.parse(text) as T;
}

async function lifePosSessionRequest<T>(session: LifePosSession, path: string): Promise<T> {
  return lifePosTokenRequest<T>(session.lifePosToken, path);
}

async function lifePosTokenRequest<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Accept-Language": "ru-RU",
      "X-LP-Client-Identifier": clientId,
      "X-LP-Client-Type": "WebApp",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`Life POS request failed: ${response.status}`);
  }

  return parseLifePosResponse<T>(response);
}

function sessionKey(session: LifePosSession) {
  return `session:${session.orgGuid}:${session.lifePosToken.slice(-10)}`;
}

function resolveSalesFetchRange(range?: SalesFetchRange) {
  if (!range) return null;
  if ("start" in range) return range;
  return getReportPeriod(range);
}

function salesFetchRangeKey(range?: SalesFetchRange) {
  if (!range) return "all";
  const period = resolveSalesFetchRange(range);
  return period ? `${period.start.toISOString()}:${period.end.toISOString()}` : "all";
}

async function fetchSalesPage(session: LifePosSession, pageToken: string | undefined, range?: SalesFetchRange) {
  const query = new URLSearchParams({
    presentation: "full",
    order_by: "opened_at_desc",
    include_items_total: "true",
    selection: "all",
  });
  if (pageToken) query.set("page_token", pageToken);
  const period = resolveSalesFetchRange(range);
  if (period) {
    query.set("opened_at_from", period.start.toISOString());
    query.set("opened_at_to", period.end.toISOString());
  }
  const path = `/orgs/${session.orgGuid}/deals/sales?${query.toString()}`;

  return lifePosSessionRequest<LifePosSalesResponse>(session, path);
}

async function orgRequest<T>(session: LifePosSession, path: string): Promise<T> {
  return lifePosSessionRequest<T>(session, path);
}

function transactionRangeQuery(range?: SalesFetchRange) {
  const query = new URLSearchParams({
    presentation: "full",
    order_by: "registered_at_desc",
  });
  const period = resolveSalesFetchRange(range);
  if (period) {
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

async function fetchTransactionPaymentMap(session: LifePosSession, range?: SalesFetchRange) {
  const result = new Map<string, LifePosPaymentInfo>();
  const org = session.orgGuid;
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

async function fetchFiscalRegistrars(session: LifePosSession) {
  const org = session.orgGuid;
  if (!org) return [];

  const query = new URLSearchParams({
    presentation: "full",
    selection: "alive_only",
  });
  const response = await orgRequest<LifePosFiscalRegistrarResponse>(session, `/orgs/${org}/fiscal-registrars?${query.toString()}`);
  return response.items ?? [];
}

async function fetchShiftFiscalDocuments(session: LifePosSession, registrarGuid: string) {
  const org = session.orgGuid;
  if (!org) return [];

  const query = new URLSearchParams({
    presentation: "full",
    order_by: "issued_at_desc",
    selection: "all",
    items_per_page: "100",
  });
  query.append("fiscal_form", "ShiftOpeningReport");
  query.append("fiscal_form", "ShiftClosingReport");

  const response = await orgRequest<LifePosFiscalDocumentResponse>(
    session,
    `/orgs/${org}/fiscal-registrars/${registrarGuid}/docs?${query.toString()}`,
  );
  return response.items ?? [];
}

async function fetchShiftDocuments(session: LifePosSession) {
  const registrars = await fetchFiscalRegistrars(session);
  return (
    await Promise.all(
      registrars.map(async (registrar) => {
        const registrarGuid = readText(registrar.guid);
        if (!registrarGuid) return [];
        const documents = await fetchShiftFiscalDocuments(session, registrarGuid).catch(() => []);
        return documents.map((document) => ({ ...document, registrar }) satisfies ShiftFiscalDocument);
      }),
    )
  ).flat();
}

async function getShiftDocuments(session: LifePosSession) {
  const key = sessionKey(session);
  const cached = shiftDocumentsCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const promise = fetchShiftDocuments(session);
  shiftDocumentsCache.set(key, { expiresAt: Date.now() + cacheTtlMs, promise });

  try {
    return await promise;
  } catch (error) {
    shiftDocumentsCache.delete(key);
    throw error;
  }
}

function isSingleDayRange(range?: ReportRange) {
  const period = range?.period ?? "today";
  return period === "today" || period === "yesterday" || period === "date";
}

function buildShiftInfo(operations: Operation[]): ShiftInfo | null {
  const events = [...operations].sort((a, b) => new Date(a.openedAt).getTime() - new Date(b.openedAt).getTime());
  const lastEvent = events.at(-1);
  if (!lastEvent) return null;

  const openedEvent = events
    .filter((operation) => operation.kind === "shiftOpen")
    .at(-1);
  const closedEvent = lastEvent.kind === "shiftClose" ? lastEvent : null;
  const openedAt = openedEvent ? readDate(openedEvent.openedAt) : null;
  const closedAt = closedEvent ? readDate(closedEvent.openedAt) : null;

  return {
    status: lastEvent.kind === "shiftOpen" ? "open" : lastEvent.kind === "shiftClose" ? "closed" : "unknown",
    openedAt,
    closedAt,
    cashbox: lastEvent.cashbox || openedEvent?.cashbox || null,
  };
}

async function enrichSalesWithPayments(session: LifePosSession, sales: LifePosSalesResponse, range?: SalesFetchRange) {
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

async function getSalesResponse(session: LifePosSession, range?: SalesFetchRange) {
  const key = `${sessionKey(session)}:${salesFetchRangeKey(range)}`;
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

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function moneyValue(value: { value?: unknown } | undefined) {
  return typeof value?.value === "number" && Number.isFinite(value.value) ? value.value / 100 : 0;
}

function readDate(value: unknown) {
  const text = readText(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function fiscalDocumentDate(document: LifePosFiscalDocument) {
  return readDate(document.issued_at) ?? readDate(document.created_at) ?? readDate(document.updated_at);
}

function isConfirmedFiscalDocument(document: LifePosFiscalDocument) {
  const status = readText(document.fiscal_status) ?? readText(document.status);
  return status === "Printed";
}

function fiscalDocumentCashbox(document: ShiftFiscalDocument) {
  const registrar = document.registrar;
  return (
    readText(registrar?.name) ??
    readText(registrar?.title) ??
    readText(registrar?.serial_number) ??
    readText(registrar?.number) ??
    "Касса"
  );
}

function fiscalDocumentCashier(document: ShiftFiscalDocument) {
  const nestedRecords = [document.cashier, document.employee, document.operator, document.user]
    .map(objectValue)
    .filter((record): record is Record<string, unknown> => Boolean(record));

  for (const record of nestedRecords) {
    const name =
      readText(record.name) ??
      readText(record.full_name) ??
      readText(record.fullName) ??
      readText(record.display_name) ??
      readText(record.displayName) ??
      readText(record.username);
    if (name) return name;
  }

  return readText(document.cashier) ?? readText(document.employee) ?? readText(document.operator) ?? readText(document.user) ?? "";
}

function shiftDocumentKind(document: LifePosFiscalDocument): Operation["kind"] | null {
  const form = readText(document.fiscal_form);
  if (form === "ShiftOpeningReport") return "shiftOpen";
  if (form === "ShiftClosingReport") return "shiftClose";
  return null;
}

function formatTime(date: Date | null) {
  if (!date) return "--:--";
  return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function formatDateTime(date: Date | null) {
  if (!date) return "Дата не указана";
  return date.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function shiftDocumentToOperation(document: ShiftFiscalDocument): Operation | null {
  const kind = shiftDocumentKind(document);
  const date = fiscalDocumentDate(document);
  if (!kind || !date) return null;

  return {
    id: readText(document.guid) ?? `${kind}-${date.toISOString()}`,
    number: kind === "shiftOpen" ? "открытие смены" : "закрытие смены",
    receiptNumber: "нет данных",
    kind,
    amount: 0,
    time: formatTime(date),
    dateTime: formatDateTime(date),
    openedAt: date.toISOString(),
    paymentKind: "unknown",
    paymentLabel: "Смена",
    cashbox: fiscalDocumentCashbox(document),
    cashier: fiscalDocumentCashier(document),
    receiptStatus: "sent",
    items: [],
    subtotal: 0,
    discount: 0,
  };
}

async function getShiftOperations(session: LifePosSession, range?: ReportRange) {
  const period = getReportPeriod(range);
  const documents = await getShiftDocuments(session).catch(() => []);
  return documents
    .filter(isConfirmedFiscalDocument)
    .map(shiftDocumentToOperation)
    .filter((operation): operation is Operation => Boolean(operation))
    .filter((operation) => {
      const date = readDate(operation.openedAt);
      return Boolean(date && date >= period.start && date < period.end);
    });
}

function formatShiftDateTime(date: Date | null) {
  if (!date) return "Нет данных";
  return date.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function applyShiftInfo(summary: DashboardSummary, shiftInfo: ShiftInfo | null): DashboardSummary {
  if (!shiftInfo) {
    return {
      ...summary,
      shiftStatus: "unknown",
      shiftOpenedAt: "Нет данных",
      shiftClosedAt: null,
      shiftDuration: "unknown",
      cashbox: "",
    };
  }

  return {
    ...summary,
    shiftStatus: shiftInfo.status,
    shiftOpenedAt: formatShiftDateTime(shiftInfo.openedAt),
    shiftClosedAt: shiftInfo.closedAt ? formatShiftDateTime(shiftInfo.closedAt) : null,
    shiftDuration: "fiscal-documents",
    cashbox: shiftInfo.cashbox ?? summary.cashbox,
  };
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

function readSalePayload(payload: unknown): LifePosSale | null {
  const record = objectValue(payload);
  if (!record) return null;
  return (objectValue(record.sale) ?? objectValue(record.deal) ?? objectValue(record.object) ?? objectValue(record.data) ?? record) as LifePosSale;
}

function readFiscalDocumentPayload(payload: unknown): Record<string, unknown> | null {
  const record = objectValue(payload);
  if (!record) return null;
  return objectValue(record.receipt) ?? objectValue(record.document) ?? objectValue(record.object) ?? objectValue(record.data) ?? record;
}

function readFiscalDocumentItems(payload: unknown): Record<string, unknown>[] {
  const record = objectValue(payload);
  const data = objectValue(record?.data);
  const items = Array.isArray(record?.items) ? record.items : Array.isArray(data?.items) ? data.items : Array.isArray(payload) ? payload : [];
  return items.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
}

async function fetchSaleById(session: LifePosSession, id: string) {
  const query = new URLSearchParams({
    presentation: "full",
    include_items_total: "true",
  });
  const payload = await lifePosSessionRequest<unknown>(
    session,
    `/orgs/${session.orgGuid}/deals/sales/${encodeURIComponent(id)}?${query.toString()}`,
  );
  return readSalePayload(payload);
}

async function fetchFiscalReceiptDocument(session: LifePosSession, registrarGuid: string, documentGuid: string) {
  const query = new URLSearchParams({ presentation: "full" });
  const payload = await lifePosSessionRequest<unknown>(
    session,
    `/orgs/${session.orgGuid}/fiscal-registrars/${encodeURIComponent(registrarGuid)}/docs/receipts/${encodeURIComponent(documentGuid)}?${query.toString()}`,
  );
  return readFiscalDocumentPayload(payload);
}

async function findFiscalReceiptDocumentByGuid(session: LifePosSession, documentGuid: string) {
  const query = new URLSearchParams({
    presentation: "full",
    guid: documentGuid,
  });
  const payload = await lifePosSessionRequest<unknown>(
    session,
    `/orgs/${session.orgGuid}/fiscal-registrars/*/docs/receipts?${query.toString()}`,
  );
  return readFiscalDocumentItems(payload)[0] ?? null;
}

async function enrichOperationWithFiscalReceipt(session: LifePosSession, operation: Operation) {
  if (operation.fiscalReceiptUrl) return operation;
  const documentGuid = operation.fiscalDocumentGuid;
  if (!documentGuid) return operation;

  let registrarGuid = operation.fiscalRegistrarGuid;
  let document: Record<string, unknown> | null = null;

  if (!registrarGuid) {
    document = await findFiscalReceiptDocumentByGuid(session, documentGuid).catch(() => null);
    const listUrl = findFiscalReceiptUrl(document);
    if (listUrl) return { ...operation, fiscalReceiptUrl: listUrl };
    registrarGuid = findFiscalRegistrarGuid(document) ?? registrarGuid;
  }

  if (!registrarGuid) return operation;
  document ??= await fetchFiscalReceiptDocument(session, registrarGuid, documentGuid).catch(() => null);
  const fiscalReceiptUrl = findFiscalReceiptUrl(document);
  return fiscalReceiptUrl ? { ...operation, fiscalReceiptUrl, fiscalRegistrarGuid: registrarGuid } : operation;
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
    return undefined;
  },
  async getSummary(session: LifePosSession, range?: ReportRange) {
    const comparisonRange = getReportComparisonPeriod(range);
    const [sales, shiftOperations] = await Promise.all([
      getSalesResponse(session, comparisonRange),
      isSingleDayRange(range) ? getShiftOperations(session, range).catch(() => []) : Promise.resolve([]),
    ]);
    const shiftInfo = isSingleDayRange(range) ? buildShiftInfo(shiftOperations) : null;
    return applyShiftInfo(buildDashboardSummary(sales.items ?? [], range), shiftInfo);
  },
  async getOperations(session: LifePosSession, range?: ReportRange) {
    const [sales, shiftOperations] = await Promise.all([getSalesResponse(session, range), getShiftOperations(session, range)]);
    return [...mapSalesToOperations(sales.items ?? [], range), ...shiftOperations].sort(
      (a, b) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime(),
    );
  },
  async getOperation(id: string, session: LifePosSession) {
    const sale = await fetchSaleById(session, id).catch(() => null);
    if (sale) {
      return enrichOperationWithFiscalReceipt(session, mapSaleToOperation(sale));
    }

    const sales = await getSalesResponse(session);
    const mapped = mapSalesToOperations(sales.items ?? []);
    const operation = mapped.find((item) => item.id === id) ?? mapped[0];
    return operation ? enrichOperationWithFiscalReceipt(session, operation) : operation;
  },
  async getSaleByIdForPush(_id: string, _targetOrgGuid?: string) {
    return null;
  },
  async getAnalytics(session: LifePosSession, range?: ReportRange) {
    const sales = await getSalesResponse(session, getReportComparisonPeriod(range));
    return buildAnalytics(sales.items ?? [], range);
  },
  clearSalesCache() {
    salesCache.clear();
    shiftDocumentsCache.clear();
  },
  async configureOperationNotifications(session: LifePosSession, primaryUrl: string, secondaryUrl?: string) {
    const targetOrgGuid = session.orgGuid;
    if (!targetOrgGuid) throw new Error("Life POS organization is not configured");

    const body = [
      {
        op: "add",
        path: "/extensions/notification_service",
        value: {
          turned_on: true,
          primary_url_for_notifications: primaryUrl,
          ...(secondaryUrl ? { secondary_url_for_notifications: secondaryUrl } : {}),
          version: "1.0",
        },
      },
    ];

    const init = {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-LP-Client-Extensions": "notification_service",
      },
      body: JSON.stringify(body),
    };

    return lifePosTokenRequest<unknown>(session.lifePosToken, `/v6/orgs/${targetOrgGuid}`, init);
  },
};
