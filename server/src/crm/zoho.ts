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

export class ZohoError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
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
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async refresh(): Promise<string> {
    const q = new URLSearchParams({
      refresh_token: this.o.refreshToken,
      client_id: this.o.clientId,
      client_secret: this.o.clientSecret,
      grant_type: "refresh_token",
    });
    const res = await this.withRetry(() =>
      this.fetch(`${this.o.accountsUrl.replace(/\/$/, "")}/oauth/v2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: q.toString(),
      }),
    );
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    // Zoho answers 200 with { error: "invalid_code" } for a bad / revoked refresh token. Never log the token.
    if (!res.ok || !body.access_token) {
      throw new ZohoError(res.status, `Zoho token refresh failed: ${body.error ?? `HTTP ${res.status}`}`, body.error);
    }
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
        const top = json as { code?: string; message?: string; data?: { code?: string; message?: string }[] } | null;
        const j = top?.code ? top : (top?.data?.[0] ?? top);
        throw new ZohoError(res.status, `Zoho ${method} ${path.split("?")[0]}: ${j?.code ?? res.status} ${j?.message ?? ""}`.trim(), j?.code);
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
    throw new ZohoError(400, `Zoho ${what}: ${row?.code ?? "no result"} ${row?.message ?? ""}`.trim(), row?.code);
  }
  return row.details.id;
}
