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
  search(query: string): Promise<LoginSummary[]>;
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

export function searchCandidates(query: string): string[] {
  const term = query.trim().toLowerCase();
  if (term.length > 253) throw new AppleError("apple-error", "The search is too long");
  if (/[\s/:?#@]/.test(term)) {
    try {
      return [normalizeHostname(term)];
    } catch {
      return [];
    }
  }
  if (term === "") return [""];
  return term.includes(".") ? [term] : [term, `${term}.com`];
}

function summarize(entries: Record<string, unknown>[], seen: Set<string>): LoginSummary[] {
  const logins: LoginSummary[] = [];
  for (const entry of entries) {
    if (typeof entry.USR !== "string") continue;
    const sites = sitesOf(entry);
    const key = `${entry.USR}\u0000${sites[0] ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    logins.push({ username: entry.USR, sites });
  }
  return logins;
}

export function createApplePasswords(
  evaluateInExtension: Evaluator,
  log: (message: string) => void = () => undefined,
): ApplePasswords {
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
    search: (query) =>
      serialize(async () => {
        const ghostSearch = async (candidate: string): Promise<Record<string, unknown>[]> => {
          try {
            const payload = asRecord(
              await call("query", [4, "CmdGetLoginNames4URL", candidate, { ACT: 5, URL: candidate }]).catch(translate),
            );
            return checkStatus(payload) === "empty" ? [] : entriesOf(payload);
          } catch (error) {
            if (error instanceof AppleError && error.code === "unpaired") throw error;
            log(`Search candidate of length ${candidate.length} failed: ${error instanceof Error ? error.message : String(error)}`);
            return [];
          }
        };
        const seen = new Set<string>();
        const results: LoginSummary[] = [];
        for (const candidate of searchCandidates(query)) {
          const found = summarize(await ghostSearch(candidate), seen);
          log(`Search candidate of length ${candidate.length} returned ${found.length} entries`);
          results.push(...found);
        }
        const term = query.trim().toLowerCase();
        if (term !== "" && !/[\s/:?#@]/.test(term)) {
          const all = await ghostSearch("");
          const matching = all.filter(
            (entry) =>
              (typeof entry.USR === "string" && entry.USR.toLowerCase().includes(term)) ||
              sitesOf(entry).some((site) => site.toLowerCase().includes(term)),
          );
          log(`Search of the whole store returned ${all.length} entries, ${matching.length} matching`);
          results.push(...summarize(matching, seen));
        }
        return results;
      }),
  };
}
