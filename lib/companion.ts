export const COMPANION_URL = "http://127.0.0.1:47823";
const TOKEN_KEY = "bb-apple-passwords:companion-token";

export type PairingState = "unavailable" | "unpaired" | "awaiting-code" | "paired" | "starting";

export interface CompanionStatus {
  version: string;
  connected: boolean;
  pairing: PairingState;
  detail: string | null;
}

export class CompanionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const PAIRING_STATES = new Set<string>(["unavailable", "unpaired", "awaiting-code", "paired", "starting"]);

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeToken(token: string | null): void {
  try {
    if (token === null) localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, token);
  } catch {
    return;
  }
}

async function request(path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const token = readToken();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(`${COMPANION_URL}${path}`, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      credentials: "omit",
    });
  } catch {
    throw new CompanionError("offline", "The Apple Passwords companion is not running on this Mac");
  }
  const parsed: unknown = await response.json().catch(() => ({}));
  const payload = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  if (!response.ok) {
    const code = typeof payload.code === "string" ? payload.code : "error";
    if (code === "not-connected") writeToken(null);
    throw new CompanionError(code, typeof payload.error === "string" ? payload.error : `Request failed (${response.status})`);
  }
  return payload;
}

function pairingOf(payload: Record<string, unknown>): PairingState {
  return typeof payload.pairing === "string" && PAIRING_STATES.has(payload.pairing)
    ? (payload.pairing as PairingState)
    : "unavailable";
}

export const companion = {
  hasToken: () => readToken() !== null,
  async status(): Promise<CompanionStatus> {
    const payload = await request("/v1/status");
    return {
      version: typeof payload.version === "string" ? payload.version : "unknown",
      connected: payload.connected === true,
      pairing: pairingOf(payload),
      detail: typeof payload.detail === "string" ? payload.detail : null,
    };
  },
  async connect(): Promise<void> {
    const payload = await request("/v1/connect", {});
    if (typeof payload.token !== "string") throw new CompanionError("error", "The companion returned no token");
    writeToken(payload.token);
  },
  async disconnect(): Promise<void> {
    await request("/v1/disconnect", {}).catch(() => undefined);
    writeToken(null);
  },
  async challenge(): Promise<PairingState> {
    return pairingOf(await request("/v1/apple/challenge", {}));
  },
  async verify(pin: string): Promise<PairingState> {
    return pairingOf(await request("/v1/apple/verify", { pin }));
  },
  async logins(url: string): Promise<{ hostname: string; usernames: string[] }> {
    const payload = await request("/v1/logins", { url });
    const logins = Array.isArray(payload.logins) ? payload.logins : [];
    return {
      hostname: typeof payload.hostname === "string" ? payload.hostname : "",
      usernames: logins
        .map((login: unknown) => (login as { username?: unknown }).username)
        .filter((username): username is string => typeof username === "string"),
    };
  },
  async password(url: string, username: string): Promise<{ username: string; password: string }> {
    const payload = await request("/v1/password", { url, username });
    if (typeof payload.password !== "string" || typeof payload.username !== "string") {
      throw new CompanionError("error", "The companion returned no password");
    }
    return { username: payload.username, password: payload.password };
  },
};
