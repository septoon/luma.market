import { analytics, operations, summary } from "./mockData.js";
import { buildAnalytics, buildDashboardSummary, getReportPeriod, mapSalesToOperations, } from "./lifePosMapper.js";
const apiBase = process.env.LIFE_POS_API_BASE ?? "https://api.life-pos.ru";
const lifePosToken = process.env.LIFE_POS_TOKEN;
const orgGuid = process.env.LIFE_POS_ORG_GUID;
const clientId = process.env.LIFE_POS_CLIENT_ID ?? "726f79ad-5af6-4eae-bbd4-66f84313cd35";
const cacheTtlMs = 15_000;
const salesCache = new Map();
function isConfigured() {
    return Boolean(lifePosToken && orgGuid);
}
async function lifePosRequest(path) {
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
    return response.json();
}
async function lifePosSessionRequest(session, path) {
    const response = await fetch(`${apiBase}${path}`, {
        headers: {
            Authorization: `Bearer ${session.lifePosToken}`,
            "Accept-Language": "ru-RU",
            "X-LP-Client-Identifier": clientId,
            "X-LP-Client-Type": "WebApp",
        },
    });
    if (!response.ok) {
        throw new Error(`Life POS request failed: ${response.status}`);
    }
    return response.json();
}
function sessionKey(session) {
    if (session)
        return `session:${session.orgGuid}:${session.lifePosToken.slice(-10)}`;
    if (isConfigured())
        return `env:${orgGuid}:${lifePosToken?.slice(-10)}`;
    return "mock";
}
async function fetchSalesPage(session, pageToken, range) {
    const query = new URLSearchParams({
        presentation: "full",
        order_by: "opened_at_desc",
        include_items_total: "true",
        selection: "all",
    });
    if (pageToken)
        query.set("page_token", pageToken);
    if (range) {
        const period = getReportPeriod(range);
        query.set("opened_at_from", period.start.toISOString());
        query.set("opened_at_to", period.end.toISOString());
    }
    const path = `/orgs/${session?.orgGuid ?? orgGuid}/deals/sales?${query.toString()}`;
    return session ? lifePosSessionRequest(session, path) : lifePosRequest(path);
}
async function getSalesResponse(session, range) {
    if (!session && !isConfigured())
        return null;
    const key = `${sessionKey(session)}:${range?.period ?? "all"}:${range?.date ?? ""}`;
    const cached = salesCache.get(key);
    if (cached && cached.expiresAt > Date.now())
        return cached.response;
    const firstPage = await fetchSalesPage(session, undefined, range);
    const items = [...(firstPage.items ?? [])];
    let nextPageToken = firstPage.next_page_token;
    for (let page = 2; nextPageToken && page <= 10; page += 1) {
        const nextPage = await fetchSalesPage(session, nextPageToken, range);
        items.push(...(nextPage.items ?? []));
        nextPageToken = nextPage.next_page_token;
    }
    const response = { ...firstPage, items };
    salesCache.set(key, { expiresAt: Date.now() + cacheTtlMs, response });
    return response;
}
function readToken(payload) {
    if (!payload || typeof payload !== "object")
        return null;
    const record = payload;
    const token = record.token ?? record.access_token ?? record.accessToken;
    return typeof token === "string" && token.length > 0 ? token : null;
}
function readOrganizations(payload) {
    const record = payload && typeof payload === "object" ? payload : {};
    const data = record.data && typeof record.data === "object" ? record.data : {};
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
        if (!item || typeof item !== "object")
            return null;
        const org = item;
        const guid = org.guid ?? org.org_guid ?? org.id;
        const name = org.name ?? org.title ?? org.short_name ?? org.shortName ?? guid;
        if (typeof guid !== "string" || !guid)
            return null;
        return {
            guid,
            name: typeof name === "string" ? name : guid,
        };
    })
        .filter((item) => Boolean(item));
}
export const lifePosClient = {
    isConfigured,
    async signInByPhone(phone, password) {
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
        return token;
    },
    async listOrganizations(token) {
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
    async getSummary(session, range) {
        const sales = await getSalesResponse(session, range);
        if (sales)
            return buildDashboardSummary(sales.items ?? [], range);
        return summary;
    },
    async getOperations(session, range) {
        const sales = await getSalesResponse(session, range);
        if (sales)
            return mapSalesToOperations(sales.items ?? [], range);
        return operations;
    },
    async getOperation(id, session) {
        const sales = await getSalesResponse(session);
        if (sales) {
            const mapped = mapSalesToOperations(sales.items ?? []);
            return mapped.find((operation) => operation.id === id) ?? mapped[0];
        }
        return operations.find((operation) => operation.id === id) ?? operations[0];
    },
    async getAnalytics(session, range) {
        const sales = await getSalesResponse(session, range);
        if (sales)
            return buildAnalytics(sales.items ?? [], range);
        return analytics;
    },
};
