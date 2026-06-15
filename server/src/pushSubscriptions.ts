import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import webPush, { type PushSubscription } from "web-push";
import { mapSaleToOperation, type LifePosSale } from "./lifePosMapper.js";
import { lifePosClient, mapShiftDocumentToOperation } from "./lifePosClient.js";
import type { LifePosSession } from "./sessionStore.js";
import type { Operation } from "./types.js";

type StoredSubscription = {
  subscription: PushSubscription;
  orgGuid: string;
  userName?: string;
  createdAt: number;
};

type SaleNotification = {
  id: string;
  orgGuid?: string;
  sale: LifePosSale;
};

type ShiftNotification = {
  id: string;
  orgGuid?: string;
  operation?: Operation;
};

const subscriptions = new Map<string, StoredSubscription>();
const seenSaleIds = new Set<string>();
const seenShiftIds = new Set<string>();
const subscriptionsFile = process.env.PUSH_SUBSCRIPTIONS_FILE
  ? resolve(process.env.PUSH_SUBSCRIPTIONS_FILE)
  : join(dirname(fileURLToPath(import.meta.url)), "../data/push-subscriptions.json");

function readText(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatPushBody(operation: ReturnType<typeof mapSaleToOperation>) {
  const amountLine = `Новая продажа на ${operation.amount.toLocaleString("ru-RU")} ₽`;
  if (operation.items.length === 0) return amountLine;

  const visibleItems = operation.items.slice(0, 2).map((item) => {
    const quantity = item.qty.toLocaleString("ru-RU");
    return `${item.name} - ${quantity}`;
  });
  const hiddenCount = operation.items.length - visibleItems.length;
  const itemsLine = hiddenCount > 0 ? `${visibleItems.join(", ")} + ещё ${hiddenCount}` : visibleItems.join(", ");

  return `${amountLine}\n${itemsLine}`;
}

function formatShiftPushBody(operation: Operation) {
  const title = operation.kind === "shiftOpen" ? "Открытие смены" : "Закрытие смены";
  const parts = [operation.dateTime, operation.cashbox, operation.cashier].filter(Boolean);
  return parts.length > 0 ? `${title}\n${parts.join(" · ")}` : title;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readStoredSubscription(value: unknown): StoredSubscription | null {
  const record = objectValue(value);
  const subscription = objectValue(record?.subscription);
  const keys = objectValue(subscription?.keys);
  const endpoint = readText(subscription?.endpoint);
  const orgGuid = readText(record?.orgGuid);
  const p256dh = readText(keys?.p256dh);
  const auth = readText(keys?.auth);

  if (!endpoint || !orgGuid || !p256dh || !auth) return null;

  return {
    subscription: {
      endpoint,
      expirationTime: readNumber(subscription?.expirationTime),
      keys: { p256dh, auth },
    },
    orgGuid,
    userName: readText(record?.userName) ?? undefined,
    createdAt: readNumber(record?.createdAt) ?? Date.now(),
  };
}

function loadStoredSubscriptions() {
  if (!existsSync(subscriptionsFile)) return;

  try {
    const payload = JSON.parse(readFileSync(subscriptionsFile, "utf8")) as unknown;
    const record = objectValue(payload);
    const items = Array.isArray(record?.subscriptions) ? record.subscriptions : [];

    subscriptions.clear();
    for (const item of items) {
      const stored = readStoredSubscription(item);
      if (stored) subscriptions.set(stored.subscription.endpoint, stored);
    }
  } catch (error) {
    console.warn("Failed to load Web Push subscriptions", error);
  }
}

function persistStoredSubscriptions() {
  const payload = JSON.stringify({ version: 1, subscriptions: [...subscriptions.values()] }, null, 2);
  mkdirSync(dirname(subscriptionsFile), { recursive: true });

  const temporaryFile = `${subscriptionsFile}.${process.pid}.tmp`;
  writeFileSync(temporaryFile, payload);
  renameSync(temporaryFile, subscriptionsFile);
}

loadStoredSubscriptions();

function readNestedObject(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = objectValue(record[key]);
    if (value) return value;
  }
  return null;
}

function readGuid(record: Record<string, unknown>) {
  return readText(record.guid) ?? readText(record.deal_guid) ?? readText(record.id) ?? readText(record.uuid);
}

function readOrgGuid(record: Record<string, unknown>) {
  const nested =
    readNestedObject(record, ["organization", "org"]) ??
    readNestedObject(objectValue(record.sale) ?? {}, ["organization", "org"]);
  return (
    readText(record.org_guid) ??
    readText(record.organization_guid) ??
    readText(record.orgGuid) ??
    (nested ? readGuid(nested) : null) ??
    undefined
  );
}

function isDeleteNotification(record: Record<string, unknown>) {
  const marker = [record.action, record.operation, record.event, record.type, record.event_type]
    .map(readText)
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return marker.includes("delete") || marker.includes("archive") || Boolean(record.deleted_at);
}

function moneyValue(value: unknown) {
  const money = objectValue(value);
  return readNumber(money?.value) ?? 0;
}

function saleAmount(sale: LifePosSale) {
  return moneyValue(sale.total_sum);
}

function saleIsPaid(sale: LifePosSale) {
  return readText(sale.payment_status) === "Paid" || readText(sale.state) === "Completed";
}

function hasSaleState(payload: LifePosSale) {
  return Boolean(readText(payload.payment_status) || readText(payload.state) || payload.total_sum);
}

function readNotificationRecord(record: Record<string, unknown>) {
  return (
    objectValue(record.sale) ??
    objectValue(record.deal) ??
    objectValue(record.document) ??
    objectValue(record.fiscal_document) ??
    objectValue(record.fiscalDocument) ??
    objectValue(record.object) ??
    objectValue(record.data) ??
    objectValue(record.payload) ??
    record
  );
}

function shiftSignal(record: Record<string, unknown>) {
  return [
    record.fiscal_form,
    record.fiscal_document_type,
    record.operation_type,
    record.type,
    record.kind,
    record.event,
    record.event_type,
    record.operation,
    record.name,
  ]
    .map(readText)
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function isShiftOpeningSignal(signal: string) {
  return (
    signal.includes("shiftopeningreport") ||
    signal.includes("shift_open") ||
    signal.includes("shift opening") ||
    signal.includes("open shift") ||
    signal.includes("opening shift") ||
    signal.includes("открытие смен")
  );
}

function isShiftClosingSignal(signal: string) {
  return (
    signal.includes("shiftclosingreport") ||
    signal.includes("shift_close") ||
    signal.includes("shift closing") ||
    signal.includes("close shift") ||
    signal.includes("closing shift") ||
    signal.includes("закрытие смен")
  );
}

function normalizeSalePayload(payload: unknown): SaleNotification | null {
  const record = objectValue(payload);
  if (!record || isDeleteNotification(record)) return null;

  const saleRecord = readNotificationRecord(record);

  const id = readGuid(saleRecord);
  if (!id) return null;

  const sale = saleRecord as LifePosSale;
  if (hasSaleState(sale) && (!saleIsPaid(sale) || saleAmount(sale) <= 0)) return null;

  return {
    id,
    orgGuid: readOrgGuid(record) ?? readOrgGuid(saleRecord),
    sale,
  };
}

function normalizeShiftPayload(payload: unknown): ShiftNotification | null {
  const record = objectValue(payload);
  if (!record || isDeleteNotification(record)) return null;

  const documentRecord = readNotificationRecord(record);
  const signal = [shiftSignal(record), shiftSignal(documentRecord)].filter(Boolean).join(" ");
  if (!isShiftOpeningSignal(signal) && !isShiftClosingSignal(signal)) return null;

  const id = readGuid(documentRecord);
  if (!id) return null;

  return {
    id,
    orgGuid: readOrgGuid(record) ?? readOrgGuid(documentRecord),
    operation: mapShiftDocumentToOperation(documentRecord) ?? undefined,
  };
}

export function isWebPushConfigured() {
  return Boolean(process.env.WEB_PUSH_PUBLIC_KEY && process.env.WEB_PUSH_PRIVATE_KEY);
}

export function getWebPushPublicKey() {
  return process.env.WEB_PUSH_PUBLIC_KEY ?? null;
}

export function configureWebPush() {
  const publicKey = process.env.WEB_PUSH_PUBLIC_KEY;
  const privateKey = process.env.WEB_PUSH_PRIVATE_KEY;
  if (!publicKey || !privateKey) return;

  webPush.setVapidDetails(process.env.WEB_PUSH_SUBJECT ?? "mailto:admin@luma.market", publicKey, privateKey);
}

export function savePushSubscription(session: LifePosSession, subscription: PushSubscription) {
  subscriptions.set(subscription.endpoint, {
    subscription,
    orgGuid: session.orgGuid,
    userName: session.userName,
    createdAt: Date.now(),
  });
  persistStoredSubscriptions();
}

export function deletePushSubscription(endpoint: string) {
  subscriptions.delete(endpoint);
  persistStoredSubscriptions();
}

export function getPushStatus(session: LifePosSession | null) {
  const enabled = Boolean(session && [...subscriptions.values()].some((item) => item.orgGuid === session.orgGuid));
  return {
    configured: isWebPushConfigured(),
    enabled,
  };
}

async function sendPushNotification(
  orgGuid: string | undefined,
  message: {
    title: string;
    body: string;
    url: string;
    tag: string;
    data: Record<string, unknown>;
  },
) {
  const targetSubscriptions = [...subscriptions.entries()].filter(([, item]) => !orgGuid || item.orgGuid === orgGuid);
  let delivered = 0;
  const staleEndpoints: string[] = [];

  await Promise.all(
    targetSubscriptions.map(async ([endpoint, item]) => {
      try {
        await webPush.sendNotification(item.subscription, JSON.stringify(message));
        delivered += 1;
      } catch (error) {
        const statusCode =
          typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : undefined;
        if (statusCode === 404 || statusCode === 410) staleEndpoints.push(endpoint);
      }
    }),
  );

  if (staleEndpoints.length > 0) {
    for (const endpoint of staleEndpoints) subscriptions.delete(endpoint);
    persistStoredSubscriptions();
  }

  return { delivered };
}

export async function notifySaleWebhook(payload: unknown) {
  if (!isWebPushConfigured()) return { delivered: 0, skipped: "web-push-not-configured" };

  const notification = normalizeSalePayload(payload);
  if (!notification) return { delivered: 0, skipped: "not-a-new-paid-sale" };
  if (seenSaleIds.has(notification.id)) return { delivered: 0, skipped: "sale-already-seen" };

  const enrichedSale = await lifePosClient.getSaleByIdForPush(notification.id, notification.orgGuid);
  const sale = enrichedSale ?? notification.sale;
  if (!saleIsPaid(sale) || saleAmount(sale) <= 0) return { delivered: 0, skipped: "not-a-new-paid-sale" };

  seenSaleIds.add(notification.id);
  const operation = mapSaleToOperation(sale);
  return sendPushNotification(notification.orgGuid, {
    title: "Люма.Маркет",
    body: formatPushBody(operation),
    url: `/?operation=${encodeURIComponent(operation.id)}`,
    tag: `sale:${operation.id}`,
    data: {
      operationId: operation.id,
      orgGuid: notification.orgGuid,
    },
  });
}

export async function notifyShiftWebhook(payload: unknown) {
  if (!isWebPushConfigured()) return { delivered: 0, skipped: "web-push-not-configured" };

  const notification = normalizeShiftPayload(payload);
  if (!notification) return { delivered: 0, skipped: "not-a-shift-document" };

  const seenKey = `shift:${notification.id}`;
  if (seenShiftIds.has(seenKey)) return { delivered: 0, skipped: "shift-already-seen" };

  const operation = notification.operation ?? (await lifePosClient.getShiftOperationByIdForPush(notification.id, notification.orgGuid));
  if (!operation) return { delivered: 0, skipped: "shift-document-not-found" };

  seenShiftIds.add(seenKey);
  return sendPushNotification(notification.orgGuid, {
    title: "Люма.Маркет",
    body: formatShiftPushBody(operation),
    url: `/?operation=${encodeURIComponent(operation.id)}`,
    tag: `shift:${operation.id}`,
    data: {
      operationId: operation.id,
      orgGuid: notification.orgGuid,
      operationKind: operation.kind,
    },
  });
}

export async function notifyLifePosWebhook(payload: unknown) {
  const shiftResult = await notifyShiftWebhook(payload);
  if (!("skipped" in shiftResult) || shiftResult.skipped !== "not-a-shift-document") return shiftResult;
  return notifySaleWebhook(payload);
}
