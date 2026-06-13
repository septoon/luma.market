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
  state?: unknown;
  payment_status?: unknown;
  payment_info?: LifePosPaymentInfo;
  opened_at?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  total_sum?: MoneyValue;
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

function moneyValue(value: MoneyValue | undefined) {
  return numberValue(value?.value) / 100;
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
  if (previous === 0) return current > 0 ? 100 : 0;
  return Number((((current - previous) / previous) * 100).toFixed(1));
}

function paidSales(sales: LifePosSale[]) {
  return sales.filter((sale) => stringValue(sale.payment_status) === "Paid" || stringValue(sale.state) === "Completed");
}

function saleAmount(sale: LifePosSale) {
  return moneyValue(sale.total_sum);
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
  if (sale.payment_info) return sale.payment_info.kind;
  const status = stringValue(sale.payment_status);
  if (status === "Paid") return "paid";
  if (status === "NotPaid") return "notPaid";
  return "unknown";
}

function paymentLabel(sale: LifePosSale) {
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
  return {
    id: stringValue(sale.guid, stringValue(sale.number, randomUUID())),
    number: stringValue(sale.number, "без номера"),
    receiptNumber: "нет данных",
    kind: amount < 0 ? "refund" : "sale",
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
  };
}

function aggregateSoldItems(sales: LifePosSale[], period: Period) {
  const items = new Map<string, { name: string; quantity: number; unit: string; amount: number }>();
  for (const sale of paidSales(sales)) {
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
    unknown: { kind: "unknown", label: "Не указан", amount: 0 },
  };

  for (const sale of sales) {
    buckets[paymentKind(sale)].amount += Math.abs(saleAmount(sale));
  }

  const visible = [buckets.cash, buckets.card, buckets.sbp, buckets.paid, buckets.notPaid, buckets.unknown].filter(
    (bucket) => bucket.amount > 0,
  );
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
  const selectedSales = paidSales(sales).filter((sale) => inPeriod(saleDate(sale), period));
  const previousSales = paidSales(sales).filter((sale) => inPeriod(saleDate(sale), previous));
  const revenue = selectedSales.reduce((sum, sale) => sum + Math.max(0, saleAmount(sale)), 0);
  const previousRevenue = previousSales.reduce((sum, sale) => sum + Math.max(0, saleAmount(sale)), 0);
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
    avgRefund: 0,
    avgRefundDelta: 0,
    shiftStatus: "unknown",
    shiftOpenedAt: firstSelectedSale ? formatTime(firstSelectedSale) : "--:--",
    shiftClosedAt: null,
    shiftDuration: "read-only",
    cashbox: representativeSale ? cashboxName(representativeSale) : "Касса не указана",
    payments: paymentBreakdown(selectedSales),
    updatedAt: formatTime(latestSale ?? new Date()),
  };
}

export function buildAnalytics(sales: LifePosSale[], range?: ReportRange): Analytics {
  const selected = getReportPeriod(range);
  const previous = previousPeriod(selected);
  const selectedSales = paidSales(sales).filter((sale) => inPeriod(saleDate(sale), selected));
  const previousSales = paidSales(sales).filter((sale) => inPeriod(saleDate(sale), previous));
  const hourly = emptyHourly.map((point) => ({ ...point }));

  for (const sale of paidSales(sales)) {
    const date = saleDate(sale);
    if (!date) continue;
    const hour = date.getHours();
    if (inPeriod(date, selected)) hourly[hour].today += Math.max(0, saleAmount(sale));
    if (inPeriod(date, previous)) hourly[hour].yesterday += Math.max(0, saleAmount(sale));
  }

  return {
    refunds: 0,
    refundsDelta: 0,
    conversion: sales.length > 0 ? Number(((selectedSales.length / sales.length) * 100).toFixed(1)) : 0,
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
    .map(mapSaleToOperation);
}
