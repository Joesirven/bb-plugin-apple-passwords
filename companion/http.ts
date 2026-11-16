import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AppleError, normalizeHostname, type ApplePasswords } from "./apple.ts";
import type { UserCheck } from "./touchid.ts";

export const COMPANION_VERSION = "0.2.0";
export const ICON_NAMES = new Set([
  "PasswordsToolbar_icon32.png",
  "PasswordsToolbar-darkmode_icon32.png",
  "PasswordsToolbarUnpaired_icon32.png",
  "PasswordsToolbarUnpaired-darkmode_icon32.png",
  "PasswordsExtensionIcon_16.png",
  "PasswordsExtensionIcon_32.png",
  "PasswordsExtensionIcon_128.png",
]);
const MAX_BODY_BYTES = 16 * 1024;

export interface TokenStore {
  hashes(): string[];
  add(hash: string): Promise<void>;
  remove(hash: string): Promise<void>;
}

export interface CompanionDeps {
  port: number;
  allowedOrigins: string[];
  apple: () => Promise<ApplePasswords>;
  userCheck: UserCheck;
  tokens: TokenStore;
  log: (message: string) => void;
  iconDirectory: string | null;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "too-large", "The request body is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (size === 0) return resolve({});
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(new HttpError(400, "bad-request", "The body must be a JSON object"));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, "bad-request", "The body is not valid JSON"));
      }
    });
    request.on("error", reject);
  });
}

function requireString(body: Record<string, unknown>, key: string, maxLength = 2048): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new HttpError(400, "bad-request", `The field ${key} is required`);
  }
  return value;
}

export function createCompanionServer(deps: CompanionDeps): Server {
  const allowedHosts = new Set([`127.0.0.1:${deps.port}`, `localhost:${deps.port}`]);
  const allowedOrigins = new Set(deps.allowedOrigins);

  function authorize(request: IncomingMessage): string {
    const header = request.headers.authorization ?? "";
    const match = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(header);
    if (!match?.[1]) throw new HttpError(401, "not-connected", "Connect bb to the companion first");
    const hash = hashToken(match[1]);
    if (!deps.tokens.hashes().some((stored) => sameHash(stored, hash))) {
      throw new HttpError(401, "not-connected", "Connect bb to the companion first");
    }
    return hash;
  }

  function isConnected(request: IncomingMessage): boolean {
    try {
      authorize(request);
      return true;
    } catch {
      return false;
    }
  }

  async function requireUser(reason: string): Promise<void> {
    const result = await deps.userCheck(reason);
    if (result === "denied") throw new HttpError(403, "user-denied", "Touch ID was cancelled");
    if (result === "unavailable") {
      throw new HttpError(503, "auth-unavailable", "Touch ID and the Mac password check are not available");
    }
  }

  async function route(request: IncomingMessage, method: string, path: string): Promise<unknown> {
    if (method === "GET" && path === "/v1/status") {
      const connected = isConnected(request);
      try {
        const pairing = await (await deps.apple()).state();
        return { version: COMPANION_VERSION, connected, pairing, detail: null };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { version: COMPANION_VERSION, connected, pairing: "unavailable", detail };
      }
    }
    if (method !== "POST") throw new HttpError(404, "not-found", "Not found");
    const body = await readBody(request);
    if (path === "/v1/connect") {
      await requireUser("connect bb to Apple Passwords");
      const token = randomBytes(32).toString("base64url");
      await deps.tokens.add(hashToken(token));
      deps.log("A bb client connected");
      return { token };
    }
    const tokenHash = authorize(request);
    switch (path) {
      case "/v1/disconnect":
        await deps.tokens.remove(tokenHash);
        return { ok: true };
      case "/v1/apple/challenge":
        return { pairing: await (await deps.apple()).challenge() };
      case "/v1/apple/verify": {
        const pin = requireString(body, "pin", 6);
        if (!/^\d{6}$/.test(pin)) throw new HttpError(400, "bad-request", "The code must have six digits");
        return { pairing: await (await deps.apple()).verify(pin) };
      }
      case "/v1/logins": {
        const host = normalizeHostname(requireString(body, "url"));
        const logins = await (await deps.apple()).logins(host);
        return { hostname: host, logins: logins.map((login) => ({ username: login.username })) };
      }
      case "/v1/search": {
        const query = typeof body.query === "string" ? body.query : "";
        if (query.length > 253) throw new HttpError(400, "bad-request", "The search is too long");
        const results = await (await deps.apple()).search(query);
        return { results: results.map((login) => ({ username: login.username, site: login.sites[0] ?? null })) };
      }
      case "/v1/password": {
        const pageHost = typeof body.url === "string" ? normalizeHostname(requireString(body, "url")) : null;
        const savedHost = typeof body.site === "string" ? normalizeHostname(requireString(body, "site")) : pageHost;
        if (savedHost === null) throw new HttpError(400, "bad-request", "The field url or site is required");
        const username = requireString(body, "username", 512);
        const reason =
          pageHost === null
            ? `copy the password for ${username} on ${savedHost}`
            : pageHost === savedHost
              ? `fill the password for ${username} on ${pageHost}`
              : `fill the password for ${username}, saved for ${savedHost}, on ${pageHost}`;
        await requireUser(reason);
        const credential = await (await deps.apple()).password(savedHost, username);
        if (!credential) throw new HttpError(404, "no-password", "Apple Passwords has no password for this login");
        deps.log(`Released a password for ${savedHost}`);
        return { hostname: savedHost, username: credential.username, password: credential.password };
      }
      default:
        throw new HttpError(404, "not-found", "Not found");
    }
  }

  return createServer((request, response: ServerResponse) => {
    const host = request.headers.host ?? "";
    const origin = request.headers.origin;
    const send = (status: number, payload: unknown) => {
      response.statusCode = status;
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Cache-Control", "no-store");
      response.end(JSON.stringify(payload));
    };
    if (!allowedHosts.has(host)) return send(421, { error: "This host name is not allowed", code: "bad-host" });
    if (origin !== undefined) {
      if (!allowedOrigins.has(origin)) return send(403, { error: "This origin is not allowed", code: "bad-origin" });
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
    }
    const method = request.method ?? "GET";
    if (method === "OPTIONS") {
      response.setHeader("Access-Control-Allow-Methods", "GET, POST");
      response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      response.setHeader("Access-Control-Allow-Private-Network", "true");
      response.setHeader("Access-Control-Max-Age", "600");
      response.statusCode = 204;
      response.end();
      return;
    }
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (method === "GET" && path.startsWith("/v1/icon/")) {
      const name = path.slice("/v1/icon/".length);
      if (!ICON_NAMES.has(name) || deps.iconDirectory === null) return send(404, { error: "Not found", code: "not-found" });
      readFile(join(deps.iconDirectory, "images", name)).then(
        (image) => {
          response.statusCode = 200;
          response.setHeader("Content-Type", "image/png");
          response.setHeader("Cache-Control", "max-age=3600");
          response.end(image);
        },
        () => send(404, { error: "Not found", code: "not-found" }),
      );
      return;
    }
    route(request, method, path).then(
      (payload) => send(200, payload),
      (error: unknown) => {
        if (error instanceof HttpError) return send(error.status, { error: error.message, code: error.code });
        if (error instanceof AppleError) {
          return send(error.code === "unpaired" ? 409 : 502, { error: error.message, code: error.code });
        }
        const message = error instanceof Error ? error.message : String(error);
        deps.log(`Request failed: ${message}`);
        send(503, { error: message, code: "companion-error" });
      },
    );
  });
}
