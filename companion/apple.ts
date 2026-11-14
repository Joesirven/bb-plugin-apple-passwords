import { bridgeCall } from "./bridge.ts";

export type PairingState = "unavailable" | "unpaired" | "awaiting-code" | "paired" | "starting";

export interface LoginSummary {
  username: string;
  sites: string[];
}

export interface Credential {
  username: string;
  password: string;
}

export interface ApplePasswords {
  state(): Promise<PairingState>;
  challenge(): Promise<PairingState>;
  verify(pin: string): Promise<PairingState>;
  logins(hostname: string): Promise<LoginSummary[]>;
  password(hostname: string, username: string): Promise<Credential | null>;
}

export type Evaluator = (expression: string, timeoutMs?: number) => Promise<unknown>;

const STATE_NAMES: Record<string, PairingState> = {
  IncompatibleOS: "unavailable",
  NotInSession: "unpaired",
  NativeSupportNotInstalled: "unavailable",
  CheckEngine: "starting",
  ChallengeSent: "unpaired",
  MSG1Set: "awaiting-code",
  SessionKeySet: "paired",
};

const STATUS_SUCCESS = 0;
const STATUS_NO_RESULTS = 3;
const STATUS_INVALID_SESSION = 9;

export class AppleError extends Error {
  readonly code: "unpaired" | "apple-error";
  constructor(code: "unpaired" | "apple-error", message: string) {
    super(message);
    this.code = code;
  }
}

export function normalizeHostname(input: string): string {
  const trimmed = input.trim();
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AppleError("apple-error", "Only web addresses can have saved passwords");
  }
  if (!url.hostname) throw new AppleError("apple-error", "The address has no host name");
  return url.hostname.toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function toPairingState(value: unknown): PairingState {
  return typeof value === "string" ? (STATE_NAMES[value] ?? "unavailable") : "unavailable";
}

function entriesOf(payload: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(payload.Entries)) return payload.Entries.map(asRecord);
  return Object.keys(payload)
    .filter((key) => key.includes("Entry_"))
    .sort()
    .map((key) => asRecord(payload[key]));
}

function sitesOf(entry: Record<string, unknown>): string[] {
  return Array.isArray(entry.sites) ? entry.sites.filter((site): site is string => typeof site === "string") : [];
}

function checkStatus(payload: Record<string, unknown>): "ok" | "empty" {
  const status = payload.STATUS;
  if (status === STATUS_SUCCESS) return "ok";
  if (status === STATUS_NO_RESULTS) return "empty";
  if (status === STATUS_INVALID_SESSION) {
    throw new AppleError("unpaired", "Apple Passwords ended the session. Pair again.");
  }
  throw new AppleError("apple-error", `Apple Passwords returned status ${String(status)}`);
}

function translate(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("unpaired")) throw new AppleError("unpaired", "Pair with Apple Passwords first");
  throw new AppleError("apple-error", message);
}

export function createApplePasswords(evaluateInExtension: Evaluator): ApplePasswords {
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  };
  const call = (method: "state" | "challenge" | "verify" | "query", args: unknown[], timeoutMs = 35_000) =>
    evaluateInExtension(bridgeCall(method, args), timeoutMs);

  return {
    state: () => serialize(async () => toPairingState(await call("state", []))),
    challenge: () => serialize(async () => toPairingState(await call("challenge", []))),
    verify: (pin) =>
      serialize(async () => {
        if (!/^\d{6}$/.test(pin)) throw new AppleError("apple-error", "The code must have six digits");
        return toPairingState(await call("verify", [pin]));
      }),
    logins: (hostname) =>
      serialize(async () => {
        const host = normalizeHostname(hostname);
        const payload = asRecord(
          await call("query", [4, "CmdGetLoginNames4URL", host, { ACT: 5, URL: host }]).catch(translate),
        );
        if (checkStatus(payload) === "empty") return [];
        const seen = new Set<string>();
        const logins: LoginSummary[] = [];
        for (const entry of entriesOf(payload)) {
          if (typeof entry.USR !== "string" || seen.has(entry.USR)) continue;
          seen.add(entry.USR);
          logins.push({ username: entry.USR, sites: sitesOf(entry) });
        }
        return logins;
      }),
    password: (hostname, username) =>
      serialize(async () => {
        const host = normalizeHostname(hostname);
        const payload = asRecord(
          await call("query", [5, "CmdGetPassword4LoginName", host, { ACT: 2, URL: host, USR: username }]).catch(
            translate,
          ),
        );
        if (checkStatus(payload) === "empty") return null;
        const entries = entriesOf(payload).filter(
          (entry) => entry.USR === username && typeof entry.PWD === "string",
        );
        const match = entries.find((entry) => sitesOf(entry).includes(host)) ?? entries[0];
        if (!match) return null;
        return { username, password: match.PWD as string };
      }),
  };
}
