// Read-only ServiceTitan API client (client-credentials OAuth).
// Needs SERVICETITAN_CLIENT_ID / _CLIENT_SECRET / _APP_KEY / _TENANT_ID
// (and optionally SERVICETITAN_ENV=integration) in the environment.

const AUTH_URLS = {
  production: "https://auth.servicetitan.io/connect/token",
  integration: "https://auth-integration.servicetitan.io/connect/token",
} as const;

const API_BASES = {
  production: "https://api.servicetitan.io",
  integration: "https://api-integration.servicetitan.io",
} as const;

type Params = Record<string, string | number | boolean | undefined | null>;

function env(): keyof typeof AUTH_URLS {
  return process.env.SERVICETITAN_ENV === "integration" ? "integration" : "production";
}

export function tenant(): string {
  const t = process.env.SERVICETITAN_TENANT_ID;
  if (!t) throw new Error("SERVICETITAN_TENANT_ID is not set");
  return t;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) return cachedToken.token;
  const res = await fetch(AUTH_URLS[env()], {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.SERVICETITAN_CLIENT_ID ?? "",
      client_secret: process.env.SERVICETITAN_CLIENT_SECRET ?? "",
    }),
  });
  if (!res.ok) {
    throw new Error(`ServiceTitan login failed (${res.status}). Check the client id/secret in Vercel env.`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.token;
}

// Paths are written with {tenant}, e.g. "crm/v2/tenant/{tenant}/customers".
function buildUrl(path: string, params: Params): URL {
  const url = new URL(`${API_BASES[env()]}/${path.replace(/^\//, "").replace("{tenant}", tenant())}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  return url;
}

async function request(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, params: Params = {}, body?: unknown): Promise<any> {
  const token = await getToken();
  const url = buildUrl(path, params);
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "ST-App-Key": process.env.SERVICETITAN_APP_KEY ?? "",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) {
      const text = await res.text();
      return text ? JSON.parse(text) : { ok: true };
    }
    lastError = `${res.status} ${(await res.text()).slice(0, 400)}`;
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    break;
  }
  if (lastError.startsWith("403")) {
    lastError += " — the ServiceTitan API app is probably missing the read scope for this area.";
  }
  throw new Error(`ServiceTitan ${method} ${path} failed: ${lastError}`);
}

export const stGet = (path: string, params: Params = {}) => request("GET", path, params);

// Only used for reporting "data" calls, which are POST but read-only.
export const stPost = (path: string, body: unknown, params: Params = {}) => request("POST", path, params, body);

// Changes data in ServiceTitan. Only the write tools call this, and only after
// writesEnabled() and an explicit confirm.
export const stWrite = (method: "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown) =>
  request(method, path, {}, body);

export const writesEnabled = () => process.env.ALLOW_WRITES?.trim().toLowerCase() === "true";

// Pages through a list endpoint until done or maxRecords is reached.
export async function stGetAll(path: string, params: Params = {}, maxRecords = 2000): Promise<{ data: any[]; truncated: boolean }> {
  const data: any[] = [];
  for (let page = 1; data.length < maxRecords; page++) {
    const res = await stGet(path, { ...params, page, pageSize: 500 });
    data.push(...(res.data ?? []));
    if (!res.hasMore) return { data: data.slice(0, maxRecords), truncated: false };
  }
  return { data: data.slice(0, maxRecords), truncated: true };
}

// Small lookup tables (technicians, business units, job types, campaigns)
// cached for 10 minutes so tools can show names instead of ids.
const lookupCache = new Map<string, { at: number; map: Map<number, string> }>();

async function lookup(key: string, path: string, nameOf: (r: any) => string): Promise<Map<number, string>> {
  const hit = lookupCache.get(key);
  if (hit && Date.now() - hit.at < 600_000) return hit.map;
  const { data } = await stGetAll(path, {}, 5000);
  const map = new Map<number, string>(data.map((r) => [r.id, nameOf(r)]));
  lookupCache.set(key, { at: Date.now(), map });
  return map;
}

export const technicianNames = () => lookup("tech", "settings/v2/tenant/{tenant}/technicians", (r) => r.name);
export const businessUnitNames = () => lookup("bu", "settings/v2/tenant/{tenant}/business-units", (r) => r.name);
export const jobTypeNames = () => lookup("jt", "jpm/v2/tenant/{tenant}/job-types", (r) => r.name);
export const campaignNames = () => lookup("camp", "marketing/v2/tenant/{tenant}/campaigns", (r) => r.name);
export const tagTypeNames = () => lookup("tag", "settings/v2/tenant/{tenant}/tag-types", (r) => r.name);
export const cancelReasonNames = () => lookup("cancel", "jpm/v2/tenant/{tenant}/job-cancel-reasons", (r) => r.name);
export const bookingProviderNames = () => lookup("bp", "crm/v2/tenant/{tenant}/booking-provider-tags", (r) => r.tagName);

// Resolves a business unit / technician given as a name fragment or id.
export async function resolveId(map: Map<number, string>, value: string | undefined, label: string): Promise<number | undefined> {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const q = value.toLowerCase();
  const matches = [...map].filter(([, name]) => name?.toLowerCase().includes(q));
  if (matches.length === 1) return matches[0][0];
  if (matches.length === 0) throw new Error(`No ${label} matches "${value}".`);
  const exact = matches.find(([, name]) => name.toLowerCase() === q);
  if (exact) return exact[0];
  throw new Error(`"${value}" matches several ${label}s: ${matches.map(([, n]) => n).join(", ")}. Be more specific.`);
}

// ServiceTitan wants UTC timestamps. A plain YYYY-MM-DD or YYYY-MM-DDTHH:MM
// (no zone) is read as local time in BUSINESS_TIMEZONE (default Eastern).
export function dateParam(d: string | undefined): string | undefined {
  if (!d) return undefined;
  const m = d.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return d;
  const tz = process.env.BUSINESS_TIMEZONE || "America/New_York";
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(guess).map((p) => [p.type, p.value])
  );
  const asLocal = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return new Date(guess - (asLocal - guess)).toISOString();
}

export const money = (n: number) => Math.round(n * 100) / 100;
