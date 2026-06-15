import { randomUUID } from "node:crypto";
import type {
  Analytics,
  DashboardSummary,
  Operation,
  OperationItem,
  PaymentKind,
  ProductSalesPeriod,
  ReportRange,
} from "./types.js";

type MoneyValue = {
  value?: unknown;
};

type UnknownRecord = Record<string, unknown>;

type LifePosSalePosition = {
  name?: unknown;
  quantity?: unknown;
  sale_price?: MoneyValue;
  total_sum?: MoneyValue;
  uom?: {
    name?: unknown;
    short_name?: unknown;
  };
};

export type LifePosSale = {
  guid?: unknown;
  number?: unknown;
  operation_type?: unknown;
  type?: unknown;
  kind?: unknown;
  fiscal_form?: unknown;
  fiscal_document_type?: unknown;
  receipt_type?: unknown;
  payment_type?: unknown;
  is_return?: unknown;
  state?: unknown;
  status?: unknown;
  payment_status?: unknown;
  payment_info?: LifePosPaymentInfo;
  opened_at?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  total_sum?: MoneyValue;
  amount?: MoneyValue | unknown;
  total?: MoneyValue | unknown;
  outlet?: {
    name?: unknown;
  };
  workplace?: {
    name?: unknown;
    number?: unknown;
  };
  opened_by?: {
    name?: unknown;
    username?: unknown;
  };
  positions?: LifePosSalePosition[];
  ofd_url?: unknown;
  ofdUrl?: unknown;
  receipt_url?: unknown;
  receiptUrl?: unknown;
  printable_qr?: unknown;
  fiscal_document?: unknown;
  fiscalDocument?: unknown;
  fiscal_documents?: unknown;
  fiscalDocuments?: unknown;
  receipt?: unknown;
  fiscal_document_guid?: unknown;
  fiscalDocumentGuid?: unknown;
  fiscal_doc_guid?: unknown;
  doc_guid?: unknown;
  docGuid?: unknown;
  document_guid?: unknown;
  documentGuid?: unknown;
  fiscal_registrar_guid?: unknown;
  fiscalRegistrarGuid?: unknown;
  registrar_guid?: unknown;
  registrarGuid?: unknown;
};

export type LifePosPaymentInfo = {
  kind: PaymentKind;
  label: string;
};

export type LifePosSalesResponse = {
  items?: LifePosSale[];
  next_page_token?: string;
  pages_total?: number;
};

type Period = {
  start: Date;
  end: Date;
};

type SaleClassification = "sale" | "refund" | "cancel" | "unknown";

const emptyHourly = Array.from({ length: 24 }, (_, index) => ({
  hour: String(index).padStart(2, "0"),
  today: 0,
  yesterday: 0,
}));

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function recordValue(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : null;
}

function readPath(payload: unknown, path: string[]) {
  let current: unknown = payload;
  for (const segment of path) {
    const record = recordValue(current);
    if (!record || !(segment in record)) return undefined;
    current = record[segment];
  }
  return current;
}

function validUrl(value: unknown) {
  const text = stringValue(value);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function findTextByKeys(payload: unknown, keys: Set<string>, maxDepth = 6, seen = new Set<unknown>()): string | undefined {
  if (!payload || maxDepth < 0 || seen.has(payload)) return undefined;
  if (typeof payload !== "object") return undefined;
  seen.add(payload);

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const value = findTextByKeys(item, keys, maxDepth - 1, seen);
      if (value) return value;
    }
    return undefined;
  }

  const record = payload as UnknownRecord;
  for (const [key, value] of Object.entries(record)) {
    if (keys.has(key)) {
      const text = stringValue(value);
      if (text) return text;
    }
  }
  for (const value of Object.values(record)) {
    const nested = findTextByKeys(value, keys, maxDepth - 1, seen);
    if (nested) return nested;
  }
  return undefined;
}

function findUrlByKeys(payload: unknown, keys: Set<string>, maxDepth = 6, seen = new Set<unknown>()): string | undefined {
  if (!payload || maxDepth < 0 || seen.has(payload)) return undefined;
  if (typeof payload !== "object") return undefined;
  seen.add(payload);

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const value = findUrlByKeys(item, keys, maxDepth - 1, seen);
      if (value) return value;
    }
    return undefined;
  }

  const record = payload as UnknownRecord;
  for (const [key, value] of Object.entries(record)) {
    if (keys.has(key)) {
      const url = validUrl(value);
      if (url) return url;
    }
  }
  for (const value of Object.values(record)) {
    const nested = findUrlByKeys(value, keys, maxDepth - 1, seen);
    if (nested) return nested;
  }
  return undefined;
}

export function findFiscalReceiptUrl(payload: unknown) {
  const directPaths = [
    ["ofd_url"],
    ["ofdUrl"],
    ["receipt_url"],
    ["receiptUrl"],
    ["printable_qr"],
    ["fiscal_document", "ofd_url"],
    ["fiscal_document", "receipt_url"],
    ["fiscalDocument", "ofdUrl"],
    ["fiscalDocument", "receiptUrl"],
    ["receipt", "ofd_url"],
    ["receipt", "receipt_url"],
  ];
  for (const path of directPaths) {
    const url = validUrl(readPath(payload, path));
    if (url) return url;
  }
  return findUrlByKeys(payload, new Set(["ofd_url", "ofdUrl", "receipt_url", "receiptUrl", "printable_qr"]));
}

export function findFiscalDocumentGuid(payload: unknown) {
  const directPaths = [
    ["fiscal_document_guid"],
    ["fiscalDocumentGuid"],
    ["fiscal_doc_guid"],
    ["doc_guid"],
    ["docGuid"],
    ["document_guid"],
    ["documentGuid"],
    ["fiscal_document", "guid"],
    ["fiscalDocument", "guid"],
    ["receipt", "guid"],
  ];
  for (const path of directPaths) {
    const text = stringValue(readPath(payload, path));
    if (text) return text;
  }
  return findTextByKeys(
    payload,
    new Set(["fiscal_document_guid", "fiscalDocumentGuid", "fiscal_doc_guid", "doc_guid", "docGuid", "document_guid", "documentGuid"]),
  );
}

export function findFiscalRegistrarGuid(payload: unknown) {
  const directPaths = [
    ["fiscal_registrar_guid"],
    ["fiscalRegistrarGuid"],
    ["registrar_guid"],
    ["registrarGuid"],
    ["fiscal_registrar", "guid"],
    ["fiscalRegistrar", "guid"],
    ["registrar", "guid"],
    ["workplace", "fiscal_registrar", "guid"],
    ["workplace", "fiscalRegistrar", "guid"],
    ["fiscal_document", "fiscal_registrar", "guid"],
    ["fiscalDocument", "fiscalRegistrar", "guid"],
  ];
  for (const path of directPaths) {
    const text = stringValue(readPath(payload, path));
    if (text) return text;
  }
  return findTextByKeys(payload, new Set(["fiscal_registrar_guid", "fiscalRegistrarGuid", "registrar_guid", "registrarGuid"]));
}

function moneyValue(value: MoneyValue | undefined) {
  return numberValue(value?.value) / 100;
}

function moneyValueFromUnknown(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value && typeof value === "object" && "value" in value) {
    return numberValue((value as MoneyValue).value) / 100;
  }
  return 0;
}

function saleDate(sale: LifePosSale) {
  const raw = stringValue(sale.opened_at) || stringValue(sale.created_at) || stringValue(sale.updated_at);
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(date: Date) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

function addDays(date: Date, days: number) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function addMonths(date: Date, months: number) {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

function inPeriod(date: Date | null, period: Period) {
  return Boolean(date && date >= period.start && date < period.end);
}

function percentDelta(current: number, previous: number) {
  if (previous === 0) return null;
  return Number((((current - previous) / previous) * 100).toFixed(1));
}

function paidSales(sales: LifePosSale[]) {
  return sales.filter((sale) => stringValue(sale.payment_status) === "Paid" || stringValue(sale.state) === "Completed");
}

function saleAmount(sale: LifePosSale) {
  return moneyValue(sale.total_sum) || moneyValueFromUnknown(sale.total) || moneyValueFromUnknown(sale.amount);
}

function saleRawType(sale: LifePosSale) {
  return [
    sale.operation_type,
    sale.type,
    sale.kind,
    sale.fiscal_form,
    sale.fiscal_document_type,
    sale.receipt_type,
    sale.payment_type,
    sale.payment_status,
    sale.status,
    sale.state,
    typeof sale.is_return === "boolean" ? `is_return:${sale.is_return}` : undefined,
  ]
    .map((value) => stringValue(value))
    .filter(Boolean)
    .join(" · ");
}

function normalizedSignals(sale: LifePosSale) {
  return [
    sale.operation_type,
    sale.type,
    sale.kind,
    sale.fiscal_form,
    sale.fiscal_document_type,
    sale.receipt_type,
    sale.payment_type,
    sale.status,
    sale.state,
  ]
    .map((value) => stringValue(value).toLowerCase())
    .filter(Boolean);
}

function explicitOperationSignals(sale: LifePosSale) {
  return [sale.operation_type, sale.type, sale.kind, sale.fiscal_form, sale.fiscal_document_type, sale.receipt_type]
    .map((value) => stringValue(value).toLowerCase())
    .filter(Boolean);
}

function signalContains(signals: string[], values: string[]) {
  return signals.some((signal) => values.some((value) => signal.includes(value)));
}

function hasNegativeLine(sale: LifePosSale) {
  return (sale.positions ?? []).some((position) => moneyValue(position.total_sum) < 0 || moneyValue(position.sale_price) < 0);
}

function classifySale(sale: LifePosSale): SaleClassification {
  const amount = saleAmount(sale);
  const signals = normalizedSignals(sale);
  const operationSignals = explicitOperationSignals(sale);
  const isReturn = sale.is_return === true || stringValue(sale.is_return).toLowerCase() === "true";
  const isSaleSignal = signalContains(signals, ["sale", "sell", "receipt", "payment", "income"]);

  if (signalContains(signals, ["cancel", "cancelled", "canceled", "void", "annul", "storno", "delete", "deleted", "отмен"])) {
    return "cancel";
  }

  if (isReturn || amount < 0 || hasNegativeLine(sale) || signalContains(signals, ["refund", "return", "возврат"])) {
    return "refund";
  }

  if (amount > 0 && (isSaleSignal || (operationSignals.length === 0 && paidSales([sale]).length > 0))) {
    return "sale";
  }

  return "unknown";
}

function realSales(sales: LifePosSale[]) {
  return paidSales(sales).filter((sale) => classifySale(sale) === "sale" && saleAmount(sale) > 0);
}

function adjustmentSales(sales: LifePosSale[]) {
  return paidSales(sales).filter((sale) => {
    const classification = classifySale(sale);
    return (classification === "refund" || classification === "cancel") && Math.abs(saleAmount(sale)) > 0;
  });
}

function saleItems(sale: LifePosSale): OperationItem[] {
  return Array.isArray(sale.positions)
    ? sale.positions.map((position) => {
        const total = moneyValue(position.total_sum);
        const qty = numberValue(position.quantity);
        return {
          name: stringValue(position.name, "Позиция без названия"),
          qty,
          unitPrice: moneyValue(position.sale_price) || (qty > 0 ? total / qty : 0),
          total,
        };
      })
    : [];
}

function paymentKind(sale: LifePosSale): PaymentKind {
  const classification = classifySale(sale);
  if (classification === "refund") return "refund";
  if (classification === "cancel") return "cancel";
  if (sale.payment_info) return sale.payment_info.kind;
  const status = stringValue(sale.payment_status);
  if (status === "Paid") return "paid";
  if (status === "NotPaid") return "notPaid";
  return "unknown";
}

function paymentLabel(sale: LifePosSale) {
  const classification = classifySale(sale);
  if (classification === "refund") return "Возврат";
  if (classification === "cancel") return "Отмена";
  if (sale.payment_info) return sale.payment_info.label;
  const status = stringValue(sale.payment_status);
  if (status === "Paid") return "Оплачено";
  if (status === "NotPaid") return "Не оплачено";
  return "Способ оплаты не указан";
}

function receiptStatus(sale: LifePosSale): Operation["receiptStatus"] {
  const state = stringValue(sale.state);
  if (state === "Completed") return "sent";
  if (state === "New") return "pending";
  return "pending";
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

function cashboxName(sale: LifePosSale) {
  const workplaceName = stringValue(sale.workplace?.name);
  const workplaceNumber = typeof sale.workplace?.number === "number" ? `Касса ${sale.workplace.number}` : "";
  const outletName = stringValue(sale.outlet?.name);
  return [workplaceName || workplaceNumber || "Касса", outletName].filter(Boolean).join(" · ");
}

function cashierName(sale: LifePosSale) {
  return stringValue(sale.opened_by?.name) || stringValue(sale.opened_by?.username) || "Сотрудник не указан";
}

export function mapSaleToOperation(sale: LifePosSale): Operation {
  const date = saleDate(sale);
  const amount = saleAmount(sale);
  const items = saleItems(sale);
  const classification = classifySale(sale);
  const fiscalReceiptUrl = findFiscalReceiptUrl(sale);
  const fiscalDocumentGuid = findFiscalDocumentGuid(sale);
  const fiscalRegistrarGuid = findFiscalRegistrarGuid(sale);
  return {
    id: stringValue(sale.guid, stringValue(sale.number, randomUUID())),
    number: stringValue(sale.number, "без номера"),
    receiptNumber: "нет данных",
    kind: classification,
    amount: Math.abs(amount),
    time: formatTime(date),
    dateTime: formatDateTime(date),
    openedAt: date?.toISOString() ?? "",
    paymentKind: paymentKind(sale),
    paymentLabel: paymentLabel(sale),
    cashbox: cashboxName(sale),
    cashier: cashierName(sale),
    receiptStatus: receiptStatus(sale),
    items,
    subtotal: items.reduce((sum, item) => sum + item.total, 0) || Math.abs(amount),
    discount: 0,
    rawType: saleRawType(sale) || undefined,
    ...(fiscalReceiptUrl ? { fiscalReceiptUrl } : {}),
    ...(fiscalDocumentGuid ? { fiscalDocumentGuid } : {}),
    ...(fiscalRegistrarGuid ? { fiscalRegistrarGuid } : {}),
  };
}

function aggregateSoldItems(sales: LifePosSale[], period: Period) {
  const items = new Map<string, { name: string; quantity: number; unit: string; amount: number }>();
  for (const sale of realSales(sales)) {
    if (!inPeriod(saleDate(sale), period)) continue;
    for (const position of sale.positions ?? []) {
      const name = stringValue(position.name, "Позиция без названия");
      const existing = items.get(name) ?? { name, quantity: 0, unit: "шт", amount: 0 };
      existing.quantity += numberValue(position.quantity);
      existing.amount += moneyValue(position.total_sum);
      existing.unit = stringValue(position.uom?.short_name) || stringValue(position.uom?.name) || existing.unit;
      items.set(name, existing);
    }
  }

  return [...items.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 10);
}

function paymentBreakdown(sales: LifePosSale[]) {
  const buckets: Record<PaymentKind, { kind: PaymentKind; label: string; amount: number }> = {
    cash: { kind: "cash", label: "Наличные", amount: 0 },
    card: { kind: "card", label: "Карта", amount: 0 },
    sbp: { kind: "sbp", label: "СБП", amount: 0 },
    paid: { kind: "paid", label: "Оплачено", amount: 0 },
    notPaid: { kind: "notPaid", label: "Не оплачено", amount: 0 },
    refund: { kind: "refund", label: "Возврат", amount: 0 },
    cancel: { kind: "cancel", label: "Отмена", amount: 0 },
    unknown: { kind: "unknown", label: "Не указан", amount: 0 },
  };

  for (const sale of sales) {
    const classification = classifySale(sale);
    if (classification === "unknown" || (classification === "sale" && saleAmount(sale) <= 0)) continue;
    buckets[paymentKind(sale)].amount += Math.abs(saleAmount(sale));
  }

  const visible = [
    buckets.cash,
    buckets.card,
    buckets.sbp,
    buckets.paid,
    buckets.notPaid,
    buckets.refund,
    buckets.cancel,
    buckets.unknown,
  ].filter((bucket) => bucket.amount > 0);
  const total = visible.reduce((sum, bucket) => sum + bucket.amount, 0);
  return visible.map((bucket) => ({
    ...bucket,
    percent: total > 0 ? Number(((bucket.amount / total) * 100).toFixed(1)) : 0,
  }));
}

function parseDateOnly(value: string | undefined) {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function getReportPeriod(range: ReportRange | undefined, now = new Date()): Period {
  const todayStart = startOfDay(now);
  const tomorrowStart = addDays(todayStart, 1);
  const yesterdayStart = addDays(todayStart, -1);
  const period = range?.period ?? "today";

  if (period === "yesterday") return { start: yesterdayStart, end: todayStart };
  if (period === "week") return { start: addDays(todayStart, -6), end: tomorrowStart };
  if (period === "month") return { start: addMonths(todayStart, -1), end: tomorrowStart };
  if (period === "date") {
    const selected = parseDateOnly(range?.date) ?? todayStart;
    return { start: selected, end: addDays(selected, 1) };
  }
  return { start: todayStart, end: tomorrowStart };
}

function previousPeriod(period: Period) {
  const duration = period.end.getTime() - period.start.getTime();
  return {
    start: new Date(period.start.getTime() - duration),
    end: new Date(period.start.getTime()),
  };
}

export function getReportComparisonPeriod(range?: ReportRange, now = new Date()): Period {
  const selected = getReportPeriod(range, now);
  const previous = previousPeriod(selected);
  return { start: previous.start, end: selected.end };
}

function buildProductPeriods(now = new Date()) {
  const todayStart = startOfDay(now);
  const tomorrowStart = addDays(todayStart, 1);
  const yesterdayStart = addDays(todayStart, -1);
  return {
    today: { start: todayStart, end: tomorrowStart },
    yesterday: { start: yesterdayStart, end: todayStart },
    week: { start: addDays(todayStart, -6), end: tomorrowStart },
  } satisfies Record<ProductSalesPeriod, Period>;
}

export function buildDashboardSummary(sales: LifePosSale[], range?: ReportRange): DashboardSummary {
  const period = getReportPeriod(range);
  const previous = previousPeriod(period);
  const selectedSales = realSales(sales).filter((sale) => inPeriod(saleDate(sale), period));
  const previousSales = realSales(sales).filter((sale) => inPeriod(saleDate(sale), previous));
  const selectedAdjustments = adjustmentSales(sales).filter((sale) => inPeriod(saleDate(sale), period));
  const previousAdjustments = adjustmentSales(sales).filter((sale) => inPeriod(saleDate(sale), previous));
  const selectedPaymentOperations = paidSales(sales).filter((sale) => {
    const classification = classifySale(sale);
    return inPeriod(saleDate(sale), period) && classification !== "unknown" && (classification !== "sale" || saleAmount(sale) > 0);
  });
  const revenue = selectedSales.reduce((sum, sale) => sum + saleAmount(sale), 0);
  const previousRevenue = previousSales.reduce((sum, sale) => sum + saleAmount(sale), 0);
  const refunds = selectedAdjustments.reduce((sum, sale) => sum + Math.abs(saleAmount(sale)), 0);
  const previousRefunds = previousAdjustments.reduce((sum, sale) => sum + Math.abs(saleAmount(sale)), 0);
  const avgCheck = selectedSales.length > 0 ? Math.round(revenue / selectedSales.length) : 0;
  const previousAvg = previousSales.length > 0 ? Math.round(previousRevenue / previousSales.length) : 0;
  const firstSelectedSale = selectedSales.map(saleDate).filter((date): date is Date => Boolean(date)).sort((a, b) => a.getTime() - b.getTime())[0];
  const latestSale = sales.map(saleDate).filter((date): date is Date => Boolean(date)).sort((a, b) => b.getTime() - a.getTime())[0];
  const representativeSale = selectedSales[0] ?? sales[0];

  return {
    revenue,
    revenueDelta: percentDelta(revenue, previousRevenue),
    salesCount: selectedSales.length,
    salesDelta: percentDelta(selectedSales.length, previousSales.length),
    avgCheck,
    avgCheckDelta: percentDelta(avgCheck, previousAvg),
    avgRefund: selectedAdjustments.length > 0 ? Math.round(refunds / selectedAdjustments.length) : 0,
    avgRefundDelta: percentDelta(
      selectedAdjustments.length > 0 ? Math.round(refunds / selectedAdjustments.length) : 0,
      previousAdjustments.length > 0 ? Math.round(previousRefunds / previousAdjustments.length) : 0,
    ),
    shiftStatus: "unknown",
    shiftOpenedAt: firstSelectedSale ? formatTime(firstSelectedSale) : "--:--",
    shiftClosedAt: null,
    shiftDuration: "read-only",
    cashbox: representativeSale ? cashboxName(representativeSale) : "Касса не указана",
    payments: paymentBreakdown(selectedPaymentOperations),
    updatedAt: formatTime(latestSale ?? new Date()),
  };
}

export function buildAnalytics(sales: LifePosSale[], range?: ReportRange): Analytics {
  const selected = getReportPeriod(range);
  const previous = previousPeriod(selected);
  const selectedSales = realSales(sales).filter((sale) => inPeriod(saleDate(sale), selected));
  const previousSales = realSales(sales).filter((sale) => inPeriod(saleDate(sale), previous));
  const selectedAdjustments = adjustmentSales(sales).filter((sale) => inPeriod(saleDate(sale), selected));
  const previousAdjustments = adjustmentSales(sales).filter((sale) => inPeriod(saleDate(sale), previous));
  const hourly = emptyHourly.map((point) => ({ ...point }));

  for (const sale of realSales(sales)) {
    const date = saleDate(sale);
    if (!date) continue;
    const hour = date.getHours();
    if (inPeriod(date, selected)) hourly[hour].today += Math.max(0, saleAmount(sale));
    if (inPeriod(date, previous)) hourly[hour].yesterday += Math.max(0, saleAmount(sale));
  }

  return {
    refunds: selectedAdjustments.reduce((sum, sale) => sum + Math.abs(saleAmount(sale)), 0),
    refundsDelta: percentDelta(
      selectedAdjustments.reduce((sum, sale) => sum + Math.abs(saleAmount(sale)), 0),
      previousAdjustments.reduce((sum, sale) => sum + Math.abs(saleAmount(sale)), 0),
    ),
    conversion: realSales(sales).length > 0 ? Number(((selectedSales.length / realSales(sales).length) * 100).toFixed(1)) : 0,
    conversionDelta: percentDelta(selectedSales.length, previousSales.length),
    hourly,
    soldItemsByPeriod: {
      today: aggregateSoldItems(sales, selected),
      yesterday: aggregateSoldItems(sales, previous),
      week: aggregateSoldItems(sales, { start: addDays(selected.end, -7), end: selected.end }),
    },
  };
}

export function mapSalesToOperations(sales: LifePosSale[], range?: ReportRange) {
  const period = range ? getReportPeriod(range) : null;
  return [...sales]
    .filter((sale) => (period ? inPeriod(saleDate(sale), period) : true))
    .sort((a, b) => (saleDate(b)?.getTime() ?? 0) - (saleDate(a)?.getTime() ?? 0))
    .map(mapSaleToOperation)
    .filter((operation) => (operation.kind !== "sale" && operation.kind !== "unknown") || operation.amount > 0);
}
