import webPush, { type PushSubscription } from "web-push";
import { mapSaleToOperation, type LifePosSale } from "./lifePosMapper.js";
import type { LifePosSession } from "./sessionStore.js";

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

const subscriptions = new Map<string, StoredSubscription>();
const seenSaleIds = new Set<string>();

function readText(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

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

function normalizeSalePayload(payload: unknown): SaleNotification | null {
  const record = objectValue(payload);
  if (!record || isDeleteNotification(record)) return null;

  const saleRecord =
    objectValue(record.sale) ??
    objectValue(record.deal) ??
    objectValue(record.object) ??
    objectValue(record.data) ??
    objectValue(record.payload) ??
    record;

  const id = readGuid(saleRecord);
  if (!id) return null;

  const sale = saleRecord as LifePosSale;
  if (!saleIsPaid(sale) || saleAmount(sale) <= 0) return null;

  return {
    id,
    orgGuid: readOrgGuid(record) ?? readOrgGuid(saleRecord),
    sale,
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
}

export function deletePushSubscription(endpoint: string) {
  subscriptions.delete(endpoint);
}

export function getPushStatus(session: LifePosSession | null) {
  const enabled = Boolean(session && [...subscriptions.values()].some((item) => item.orgGuid === session.orgGuid));
  return {
    configured: isWebPushConfigured(),
    enabled,
  };
}

export async function notifySaleWebhook(payload: unknown) {
  if (!isWebPushConfigured()) return { delivered: 0, skipped: "web-push-not-configured" };

  const notification = normalizeSalePayload(payload);
  if (!notification) return { delivered: 0, skipped: "not-a-new-paid-sale" };
  if (seenSaleIds.has(notification.id)) return { delivered: 0, skipped: "sale-already-seen" };
  seenSaleIds.add(notification.id);

  const operation = mapSaleToOperation(notification.sale);
  const targetSubscriptions = [...subscriptions.entries()].filter(
    ([, item]) => !notification.orgGuid || item.orgGuid === notification.orgGuid,
  );

  const message = JSON.stringify({
    title: "Новая продажа",
    body: `${operation.number}: ${operation.amount.toLocaleString("ru-RU")} ₽`,
    url: "/",
    tag: `sale:${operation.id}`,
    data: {
      operationId: operation.id,
      orgGuid: notification.orgGuid,
    },
  });

  let delivered = 0;
  await Promise.all(
    targetSubscriptions.map(async ([endpoint, item]) => {
      try {
        await webPush.sendNotification(item.subscription, message);
        delivered += 1;
      } catch (error) {
        const statusCode =
          typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : undefined;
        if (statusCode === 404 || statusCode === 410) subscriptions.delete(endpoint);
      }
    }),
  );

  return { delivered };
}
