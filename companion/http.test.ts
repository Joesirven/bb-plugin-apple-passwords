import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { AppleError, type ApplePasswords, type PairingState } from "./apple.ts";
import { createCompanionServer, type TokenStore } from "./http.ts";
import type { UserCheckResult } from "./touchid.ts";

const ORIGIN = "https://bb.example";
let port = 0;
let server: Server | null = null;
let userAnswer: UserCheckResult = "approved";
let userPrompts: string[] = [];
let pairing: PairingState = "paired";
let lastPin: string | null = null;
let hashes: string[] = [];

const fakeApple: ApplePasswords = {
  state: async () => pairing,
  challenge: async () => {
    pairing = "awaiting-code";
    return pairing;
  },
  verify: async (pin) => {
    lastPin = pin;
    pairing = "paired";
    return pairing;
  },
  logins: async (host) => {
    if (pairing !== "paired") throw new AppleError("unpaired", "Pair with Apple Passwords first");
    return host === "example.com" ? [{ username: "ana@example.com", sites: ["example.com"] }] : [];
  },
  password: async (host, username) =>
    host === "example.com" && username === "ana@example.com" ? { username, password: "fake-secret-value" } : null,
  search: async (query) =>
    query === "exam"
      ? [
          { username: "ana@example.com", sites: ["example.com"] },
          { username: "orphan", sites: [] },
        ]
      : [],
};

const iconDirectory = mkdtempSync(join(tmpdir(), "apw-icons-"));
mkdirSync(join(iconDirectory, "images"));
writeFileSync(join(iconDirectory, "images", "PasswordsToolbar_icon32.png"), "fake-png");
writeFileSync(join(iconDirectory, "images", "PasswordsExtensionIcon_32.png"), "fake-color-png");
writeFileSync(join(iconDirectory, "secret.txt"), "do-not-serve");

const tokens: TokenStore = {
  hashes: () => hashes,
  add: async (hash) => {
    hashes = [...hashes, hash];
  },
  remove: async (hash) => {
    hashes = hashes.filter((stored) => stored !== hash);
  },
};

async function call(
  path: string,
  options: { method?: string; body?: unknown; token?: string; origin?: string | null; host?: string } = {},
) {
  const headers: Record<string, string> = { Host: options.host ?? `127.0.0.1:${port}` };
  if (options.origin !== null) headers.Origin = options.origin ?? ORIGIN;
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const { request } = await import("node:http");
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; json: Record<string, unknown> }>(
    (resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, path, method: options.method ?? (options.body === undefined ? "GET" : "POST"), headers },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (text += chunk));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, json: text ? JSON.parse(text) : {} }),
          );
        },
      );
      req.on("error", reject);
      if (options.body !== undefined) req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
      req.end();
    },
  );
}

async function connect(): Promise<string> {
  const response = await call("/v1/connect", { body: {} });
  assert.equal(response.status, 200);
  return response.json.token as string;
}

describe("companion HTTP API", () => {
  before(async () => {
    const { createServer } = await import("node:net");
    port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        const free = (probe.address() as AddressInfo).port;
        probe.close(() => resolve(free));
      });
    });
    server = createCompanionServer({
      port,
      allowedOrigins: [ORIGIN],
      apple: async () => fakeApple,
      userCheck: async (reason) => {
        userPrompts.push(reason);
        return userAnswer;
      },
      tokens,
      log: () => undefined,
      iconDirectory,
    });
    await new Promise<void>((resolve) => server?.listen(port, "127.0.0.1", resolve));
  });

  after(() => {
    server?.close();
    rmSync(iconDirectory, { recursive: true, force: true });
  });

  beforeEach(() => {
    userAnswer = "approved";
    userPrompts = [];
    pairing = "paired";
    lastPin = null;
    hashes = [];
  });

  it("rejects a foreign Host header, which blocks DNS rebinding", async () => {
    const response = await call("/v1/status", { host: "attacker.example" });
    assert.equal(response.status, 421);
  });

  it("rejects an origin that is not on the allowlist", async () => {
    const response = await call("/v1/status", { origin: "https://attacker.example" });
    assert.equal(response.status, 403);
    assert.equal(response.headers["access-control-allow-origin"], undefined);
  });

  it("answers the preflight with exact-origin CORS and private network access", async () => {
    const response = await call("/v1/logins", { method: "OPTIONS" });
    assert.equal(response.status, 204);
    assert.equal(response.headers["access-control-allow-origin"], ORIGIN);
    assert.equal(response.headers["access-control-allow-private-network"], "true");
  });

  it("reports status without a token", async () => {
    const response = await call("/v1/status");
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { version: "0.2.0", connected: false, pairing: "paired", detail: null });
  });

  it("issues a token only after Touch ID and stores only its hash", async () => {
    const token = await connect();
    assert.equal(userPrompts.length, 1);
    assert.equal(hashes.length, 1);
    assert.notEqual(hashes[0], token);
    const status = await call("/v1/status", { token });
    assert.equal(status.json.connected, true);
  });

  it("refuses to connect when Touch ID is cancelled", async () => {
    userAnswer = "denied";
    const response = await call("/v1/connect", { body: {} });
    assert.equal(response.status, 403);
    assert.equal(response.json.code, "user-denied");
    assert.equal(hashes.length, 0);
  });

  it("requires a token for every Apple route", async () => {
    for (const path of ["/v1/logins", "/v1/search", "/v1/password", "/v1/apple/challenge", "/v1/apple/verify"]) {
      const response = await call(path, { body: { url: "example.com", username: "ana@example.com", pin: "123456" } });
      assert.equal(response.status, 401, path);
    }
    const forged = await call("/v1/logins", { body: { url: "example.com" }, token: "x".repeat(43) });
    assert.equal(forged.status, 401);
  });

  it("lists user names without passwords", async () => {
    const token = await connect();
    const response = await call("/v1/logins", { body: { url: "https://example.com/login?next=1" }, token });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { hostname: "example.com", logins: [{ username: "ana@example.com" }] });
  });

  it("asks for Touch ID before each password and marks it no-store", async () => {
    const token = await connect();
    userPrompts = [];
    const first = await call("/v1/password", { body: { url: "https://example.com", username: "ana@example.com" }, token });
    assert.equal(first.status, 200);
    assert.equal(first.json.password, "fake-secret-value");
    assert.equal(first.headers["cache-control"], "no-store");
    await call("/v1/password", { body: { url: "https://example.com", username: "ana@example.com" }, token });
    assert.equal(userPrompts.length, 2);
    assert.match(userPrompts[0] ?? "", /ana@example\.com on example\.com/);
  });

  it("does not release a password when Touch ID is cancelled", async () => {
    const token = await connect();
    userAnswer = "denied";
    const response = await call("/v1/password", { body: { url: "example.com", username: "ana@example.com" }, token });
    assert.equal(response.status, 403);
    assert.equal(response.json.password, undefined);
  });

  it("returns 404 when Apple Passwords has no such login", async () => {
    const token = await connect();
    const response = await call("/v1/password", { body: { url: "example.com", username: "nobody" }, token });
    assert.equal(response.status, 404);
  });

  it("reports an unpaired session as 409", async () => {
    const token = await connect();
    pairing = "unpaired";
    const response = await call("/v1/logins", { body: { url: "example.com" }, token });
    assert.equal(response.status, 409);
    assert.equal(response.json.code, "unpaired");
  });

  it("validates the pairing code", async () => {
    const token = await connect();
    const bad = await call("/v1/apple/verify", { body: { pin: "12ab56" }, token });
    assert.equal(bad.status, 400);
    assert.equal(lastPin, null);
    const challenge = await call("/v1/apple/challenge", { body: {}, token });
    assert.equal(challenge.json.pairing, "awaiting-code");
    const good = await call("/v1/apple/verify", { body: { pin: "123456" }, token });
    assert.equal(good.json.pairing, "paired");
    assert.equal(lastPin, "123456");
  });

  it("rejects non-web addresses and oversized bodies", async () => {
    const token = await connect();
    const fileUrl = await call("/v1/logins", { body: { url: "file:///etc/passwd" }, token });
    assert.equal(fileUrl.status, 502);
    const large = await call("/v1/logins", { body: JSON.stringify({ url: "a".repeat(20_000) }), token }).catch(
      () => ({ status: 413 }),
    );
    assert.equal(large.status, 413);
  });

  it("forgets the token on disconnect", async () => {
    const token = await connect();
    await call("/v1/disconnect", { body: {}, token });
    const response = await call("/v1/logins", { body: { url: "example.com" }, token });
    assert.equal(response.status, 401);
  });

  it("searches user names and sites without passwords", async () => {
    const token = await connect();
    const response = await call("/v1/search", { body: { query: "exam" }, token });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, {
      results: [
        { username: "ana@example.com", site: "example.com" },
        { username: "orphan", site: null },
      ],
    });
    assert.ok(!JSON.stringify(response.json).includes("fake-"));
    assert.equal(userPrompts.length, 1);
  });

  it("names both sites in the Touch ID reason when the saved site is not the page", async () => {
    const token = await connect();
    userPrompts = [];
    const response = await call("/v1/password", {
      body: { url: "https://login.other.example", site: "example.com", username: "ana@example.com" },
      token,
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.hostname, "example.com");
    assert.match(userPrompts[0] ?? "", /saved for example\.com, on login\.other\.example/);
  });

  it("asks Touch ID to copy a password when no page is given", async () => {
    const token = await connect();
    userPrompts = [];
    const response = await call("/v1/password", { body: { site: "example.com", username: "ana@example.com" }, token });
    assert.equal(response.status, 200);
    assert.match(userPrompts[0] ?? "", /^copy the password for ana@example\.com on example\.com$/);
  });

  it("serves only Apple's named toolbar icons", async () => {
    const { request } = await import("node:http");
    const fetchRaw = (path: string) =>
      new Promise<{ status: number; type: string | undefined; body: string }>((resolve, reject) => {
        const req = request(
          { host: "127.0.0.1", port, path, headers: { Host: `127.0.0.1:${port}`, Origin: ORIGIN } },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => (body += chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, type: res.headers["content-type"], body }));
          },
        );
        req.on("error", reject);
        req.end();
      });
    const icon = await fetchRaw("/v1/icon/PasswordsToolbar_icon32.png");
    assert.equal(icon.status, 200);
    assert.equal(icon.type, "image/png");
    const colorIcon = await fetchRaw("/v1/icon/PasswordsExtensionIcon_32.png");
    assert.equal(colorIcon.status, 200);
    assert.equal(colorIcon.body, "fake-color-png");
    for (const path of ["/v1/icon/secret.txt", "/v1/icon/..%2Fsecret.txt", "/v1/icon/../secret.txt", "/v1/icon/PasswordsToolbarUnpaired_icon32.png"]) {
      const refused = await fetchRaw(path);
      assert.equal(refused.status, 404, path);
      assert.ok(!refused.body.includes("do-not-serve"), path);
    }
    const foreign = await call("/v1/icon/PasswordsToolbar_icon32.png", { origin: "https://attacker.example" });
    assert.equal(foreign.status, 403);
  });
});
