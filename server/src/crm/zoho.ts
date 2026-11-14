/**
 * Small Zoho CRM REST client (API v8, India data centre by default).
 * Auth: Self Client refresh token -> short-lived access token, cached in memory and refreshed
 * 5 minutes before expiry. 429 / 5xx are retried with Retry-After (or exponential) backoff.
 * Docs: https://www.zoho.com/crm/developer/docs/api/v8/
 */

export const ZOHO_API_VERSION = "v8";
const REFRESH_MARGIN_MS = 5 * 60_000;
const MAX_TRIES = 4;

export interface ZohoOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accountsUrl: string;
  apiUrl: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** A failed token refresh is remembered this long, so a bad refresh token isn't retried on every call. */
export const REFRESH_FAIL_CACHE_MS = 5 * 60_000;
/** Zoho error codes meaning our credentials / scopes are wrong (no single call can fix them). */
const GLOBAL_CODES = new Set([
  "OAUTH_SCOPE_MISMATCH",
  "INVALID_TOKEN",
  "AUTHENTICATION_FAILURE",
  "invalid_code",
  "invalid_client",
  "invalid_client_secret",
]);

export class ZohoError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    /** Per-record error details from Zoho, e.g. { api_name: "id" } for an unknown record id. */
    readonly details?: Record<string, unknown>,
    /** Auth / config / outage error: affects every call, so the loop backs off instead of failing calls. */
    readonly global = false,
  ) {
    super(message);
  }
}

/** True for errors no single call is to blame for: auth, scopes, rate limit, Zoho outage, network. */
export function isGlobalError(err: unknown): boolean {
  if (err instanceof ZohoError) {
    return err.global || err.status === 401 || err.status === 429 || err.status >= 500 || GLOBAL_CODES.has(err.code ?? "");
  }
  // fetch() network failures (DNS, connection reset) are TypeErrors.
  return err instanceof TypeError;
}

export type ZohoModule = "Leads" | "Contacts";

export interface ZohoRecord {
  id: string;
  Modified_Time?: string;
  Full_Name?: string;
  Last_Name?: string;
  [k: string]: unknown;
}

export interface ZohoUser {
  id: string;
  email: string;
  status?: string;
}

/** Zoho's per-record result inside { data: [...] } for create / update. */
interface WriteResult {
  code: string;
  status: string;
  message: string;
  details?: { id?: string; [k: string]: unknown };
}

export class ZohoClient {
  private token: { value: string; expiresAt: number } | undefined;
  private refreshing: Promise<string> | undefined;
  private refreshFailed: { until: number; err: ZohoError } | undefined;
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly o: ZohoOptions) {
    this.fetch = o.fetch ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = o.now ?? Date.now;
  }

  /** Cached access token; one refresh at a time. */
  async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - REFRESH_MARGIN_MS > this.now()) return this.token.value;
    if (this.refreshFailed && this.refreshFailed.until > this.now()) throw this.refreshFailed.err;
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private failRefresh(message: string, status: number, code?: string): ZohoError {
    const err = new ZohoError(status, message, code, undefined, true);
    this.refreshFailed = { until: this.now() + REFRESH_FAIL_CACHE_MS, err };
    return err;
  }

  private async refresh(): Promise<string> {
    const q = new URLSearchParams({
      refresh_token: this.o.refreshToken,
      client_id: this.o.clientId,
      client_secret: this.o.clientSecret,
      grant_type: "refresh_token",
    });
    let res: Response;
    try {
      res = await this.withRetry(() =>
        this.fetch(`${this.o.accountsUrl.replace(/\/$/, "")}/oauth/v2/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: q.toString(),
        }),
      );
    } catch (err) {
      throw this.failRefresh(`Zoho token refresh failed: ${err instanceof Error ? err.message : "network error"}`, 0);
    }
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    // Zoho answers 200 with { error: "invalid_code" } for a bad / revoked refresh token. Never log the token.
    if (!res.ok || !body.access_token) {
      throw this.failRefresh(`Zoho token refresh failed: ${body.error ?? `HTTP ${res.status}`}`, res.status, body.error);
    }
    this.refreshFailed = undefined;
    this.token = { value: body.access_token, expiresAt: this.now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  /** Retries 429 and 5xx (and network errors) with Retry-After or exponential backoff. */
  private async withRetry(send: () => Promise<Response>): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await send();
      } catch (err) {
        if (attempt >= MAX_TRIES) throw err;
        await this.sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_TRIES) {
        const ra = Number(res.headers.get("retry-after"));
        await this.sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) * 1000 : 1000 * 2 ** (attempt - 1));
        continue;
      }
      return res;
    }
  }

  /** Authenticated JSON request to /crm/v8/<path>. Returns null for 204 No Content. */
  async request<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    const url = `${this.o.apiUrl.replace(/\/$/, "")}/crm/${ZOHO_API_VERSION}/${path}`;
    let retriedAuth = false;
    for (;;) {
      const token = await this.accessToken();
      const res = await this.withRetry(() =>
        this.fetch(url, {
          method,
          headers: {
            authorization: `Zoho-oauthtoken ${token}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
      if (res.status === 401 && !retriedAuth) {
        // Token revoked or expired early: refresh once.
        retriedAuth = true;
        this.token = undefined;
        continue;
      }
      if (res.status === 204) return null;
      const text = await res.text();
      const json = text ? (JSON.parse(text) as T & { code?: string; message?: string }) : null;
      if (!res.ok) {
        // Per-record errors come inside data[0] (e.g. INVALID_DATA for a deleted record id).
        type Err = { code?: string; message?: string; details?: Record<string, unknown> };
        const top = json as (Err & { data?: Err[] }) | null;
        const j: Err | null = top?.code ? top : (top?.data?.[0] ?? top);
        const msg = `Zoho ${method} ${path.split("?")[0]}: ${j?.code ?? res.status} ${j?.message ?? ""}`.trim();
        // A second 401 (after a fresh token) means the credentials themselves are bad.
        throw new ZohoError(res.status, msg, j?.code, j?.details, res.status === 401);
      }
      return json;
    }
  }

  /** Records whose phone fields match. 204 (and an empty list) = not found. */
  async searchByPhone(module: ZohoModule, phone: string): Promise<ZohoRecord[]> {
    const r = await this.request<{ data?: ZohoRecord[] }>("GET", `${module}/search?phone=${encodeURIComponent(phone)}`);
    return r?.data ?? [];
  }

  async activeUsers(): Promise<ZohoUser[]> {
    const users: ZohoUser[] = [];
    for (let page = 1; page <= 10; page++) {
      const r = await this.request<{ users?: ZohoUser[]; info?: { more_records?: boolean } }>(
        "GET",
        `users?type=ActiveUsers&per_page=200&page=${page}`,
      );
      users.push(...(r?.users ?? []));
      if (!r?.info?.more_records) break;
    }
    return users;
  }

  /** Inserts one record and returns its id. */
  async create(module: string, record: Record<string, unknown>): Promise<string> {
    const r = await this.request<{ data: WriteResult[] }>("POST", module, { data: [record] });
    return writeId(r, `create ${module}`);
  }

  async update(module: string, id: string, record: Record<string, unknown>): Promise<string> {
    const r = await this.request<{ data: WriteResult[] }>("PUT", `${module}/${id}`, { data: [record] });
    return writeId(r, `update ${module}`);
  }
}

function writeId(r: { data: WriteResult[] } | null, what: string): string {
  const row = r?.data?.[0];
  if (!row || row.status !== "success" || !row.details?.id) {
    throw new ZohoError(400, `Zoho ${what}: ${row?.code ?? "no result"} ${row?.message ?? ""}`.trim(), row?.code, row?.details);
  }
  return row.details.id;
}
