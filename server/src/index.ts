import "dotenv/config";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { z } from "zod";
import { lifePosClient } from "./lifePosClient.js";
import {
  configureWebPush,
  deletePushSubscription,
  getPushStatus,
  getWebPushPublicKey,
  notifySaleWebhook,
  savePushSubscription,
} from "./pushSubscriptions.js";
import { consumePendingAuth, createPendingAuth, createSession, deleteSession, getSession } from "./sessionStore.js";

const app = express();
const port = Number(process.env.PORT ?? 4000);
const webhookSecret = process.env.LIFE_POS_NOTIFICATION_SECRET;

configureWebPush();

function readReportRange(req: express.Request) {
  const schema = z.object({
    period: z.enum(["today", "yesterday", "week", "month", "date"]).default("today"),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  });
  return schema.parse(req.query);
}

app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_ORIGIN ?? "http://localhost:5173" }));
app.use(express.json());
app.use(morgan("dev"));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, authRequired: true });
});

function requireSession(req: express.Request, res: express.Response) {
  const session = getSession(req.header("X-Luma-Session"));
  if (!session) {
    res.status(401).json({ error: "Session is required" });
    return null;
  }
  return session;
}

app.get("/api/push/public-key", (req, res) => {
  res.json({
    publicKey: getWebPushPublicKey(),
    ...getPushStatus(getSession(req.header("X-Luma-Session"))),
  });
});

app.post("/api/push/subscriptions", (req, res, next) => {
  try {
    const session = getSession(req.header("X-Luma-Session"));
    if (!session) {
      res.status(401).json({ error: "Session is required" });
      return;
    }

    const schema = z.object({
      endpoint: z.string().url(),
      expirationTime: z.number().nullable().optional(),
      keys: z.object({
        p256dh: z.string().min(1),
        auth: z.string().min(1),
      }),
    });
    savePushSubscription(session, schema.parse(req.body));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/push/subscriptions", (req, res, next) => {
  try {
    const schema = z.object({ endpoint: z.string().url() });
    deletePushSubscription(schema.parse(req.body).endpoint);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/life-pos/notifications/configure", async (req, res, next) => {
  try {
    const session = requireSession(req, res);
    if (!session) return;

    const schema = z.object({
      primaryUrl: z.string().url().optional(),
      secondaryUrl: z.string().url().optional(),
    });
    const { primaryUrl, secondaryUrl } = schema.parse(req.body ?? {});
    const url = primaryUrl ?? process.env.LIFE_POS_NOTIFICATIONS_URL;
    if (!url) {
      res.status(400).json({ error: "LIFE_POS_NOTIFICATIONS_URL or primaryUrl is required" });
      return;
    }

    await lifePosClient.configureOperationNotifications(session, url, secondaryUrl);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

async function handleLifePosNotification(req: express.Request, res: express.Response, next: express.NextFunction) {
  try {
    const providedSecret = req.params.secret || req.header("X-Luma-Webhook-Secret");
    if (webhookSecret && providedSecret !== webhookSecret) {
      res.status(401).json({ error: "Invalid webhook secret" });
      return;
    }

    lifePosClient.clearSalesCache();
    const result = await notifySaleWebhook(req.body);
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
}

app.post("/api/life-pos/notifications", handleLifePosNotification);
app.post("/api/life-pos/notifications/:secret", handleLifePosNotification);

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const schema = z.object({
      phone: z.string().min(5),
      password: z.string().min(1),
    });
    const { phone, password } = schema.parse(req.body);

    const auth = await lifePosClient.signInByPhone(phone, password);
    const { token } = auth;
    const organizations = await lifePosClient.listOrganizations(token);

    if (organizations.length === 1) {
      const org = organizations[0];
      const userName = await lifePosClient.getCurrentUserNameByToken(token, org.guid).catch(() => undefined);
      res.json({
        sessionToken: createSession(token, org, userName),
        org,
        userName,
        organizations,
      });
      return;
    }

    res.json({
      authId: createPendingAuth(token, organizations),
      organizations,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/select-org", async (req, res, next) => {
  try {
    const schema = z.object({
      authId: z.string().uuid(),
      orgGuid: z.string().min(1),
    });
    const { authId, orgGuid } = schema.parse(req.body);
    const pending = consumePendingAuth(authId, orgGuid);

    if (!pending) {
      res.status(400).json({ error: "Organization selection expired or invalid" });
      return;
    }

    const userName =
      (await lifePosClient.getCurrentUserNameByToken(pending.lifePosToken, pending.org.guid).catch(() => undefined)) ??
      pending.userName;

    res.json({
      sessionToken: createSession(pending.lifePosToken, pending.org, userName),
      org: pending.org,
      userName,
    });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/auth/session", (req, res) => {
  deleteSession(req.header("X-Luma-Session"));
  res.json({ ok: true });
});

app.get("/api/me", async (req, res, next) => {
  try {
    const session = requireSession(req, res);
    if (!session) return;
    const userName = await lifePosClient.getCurrentUserName(session).catch(() => session?.userName);
    res.json({ userName: userName ?? null });
  } catch (error) {
    next(error);
  }
});

app.get("/api/summary", async (req, res, next) => {
  try {
    const session = requireSession(req, res);
    if (!session) return;
    res.json(await lifePosClient.getSummary(session, readReportRange(req)));
  } catch (error) {
    next(error);
  }
});

app.get("/api/operations", async (req, res, next) => {
  try {
    const session = requireSession(req, res);
    if (!session) return;
    res.json(await lifePosClient.getOperations(session, readReportRange(req)));
  } catch (error) {
    next(error);
  }
});

app.get("/api/operations/:id", async (req, res, next) => {
  try {
    const session = requireSession(req, res);
    if (!session) return;
    res.json(await lifePosClient.getOperation(req.params.id, session));
  } catch (error) {
    next(error);
  }
});

app.get("/api/analytics", async (req, res, next) => {
  try {
    const session = requireSession(req, res);
    if (!session) return;
    res.json(await lifePosClient.getAnalytics(session, readReportRange(req)));
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: "Invalid request", details: error.issues });
    return;
  }

  const message = error instanceof Error ? error.message : "Unexpected error";
  res.status(500).json({ error: message });
});

app.listen(port, () => {
  console.log(`Luma Market API listening on http://localhost:${port}`);
});
