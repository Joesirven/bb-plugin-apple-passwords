import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createApplePasswords, type ApplePasswords } from "./apple.ts";
import { findChromeBinary, findExtensionSource, launchChrome, prepareExtension, prepareProfile, type ChromeSession } from "./chrome.ts";
import { createCompanionServer, type TokenStore } from "./http.ts";
import { createTouchIdCheck } from "./touchid.ts";

export const SUPPORT_DIR = join(homedir(), "Library/Application Support/bb-apple-passwords");
export const CONFIG_PATH = join(SUPPORT_DIR, "config.json");
export const DEFAULT_PORT = 47823;

export interface CompanionConfig {
  port: number;
  allowedOrigins: string[];
  chromePath: string | null;
  biometricsOnly: boolean;
}

export function parseConfig(raw: unknown): CompanionConfig {
  const value = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const port = typeof value.port === "number" && Number.isInteger(value.port) ? value.port : DEFAULT_PORT;
  const origins = Array.isArray(value.allowedOrigins)
    ? value.allowedOrigins.filter((origin): origin is string => typeof origin === "string")
    : [];
  return {
    port,
    allowedOrigins: origins.map((origin) => new URL(origin).origin),
    chromePath: typeof value.chromePath === "string" ? value.chromePath : null,
    biometricsOnly: value.biometricsOnly === true,
  };
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function createFileTokenStore(path: string): Promise<TokenStore> {
  let hashes: string[] = [];
  if (existsSync(path)) {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const list = (parsed as { hashes?: unknown }).hashes;
    if (Array.isArray(list)) hashes = list.filter((hash): hash is string => /^[0-9a-f]{64}$/.test(String(hash)));
  }
  return {
    hashes: () => hashes,
    async add(hash) {
      hashes = [...hashes.filter((stored) => stored !== hash), hash].slice(-8);
      await writeJsonAtomic(path, { hashes });
    },
    async remove(hash) {
      hashes = hashes.filter((stored) => stored !== hash);
      await writeJsonAtomic(path, { hashes });
    },
  };
}

function log(message: string): void {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

function createAppleSupervisor(config: CompanionConfig): {
  get: () => Promise<ApplePasswords>;
  stop: () => Promise<void>;
} {
  let session: Promise<ChromeSession> | null = null;
  let apple: ApplePasswords | null = null;

  async function start(): Promise<ChromeSession> {
    const chromePath = findChromeBinary(config.chromePath ?? undefined);
    const source = await findExtensionSource(homedir());
    const extensionDir = join(SUPPORT_DIR, "extension");
    const profileDir = join(SUPPORT_DIR, "chrome-profile");
    await prepareExtension(source.path, extensionDir);
    await prepareProfile(profileDir);
    const started = await launchChrome({ chromePath, profileDir, extensionDir, log });
    started.onExit((reason) => {
      log(reason);
      session = null;
      apple = null;
    });
    return started;
  }

  return {
    async get() {
      if (!session) {
        session = start();
        session.catch(() => {
          session = null;
        });
      }
      const current = await session;
      if (!apple) {
        apple = createApplePasswords((expression, timeoutMs) => current.evaluateInExtension(expression, timeoutMs), log);
      }
      return apple;
    },
    async stop() {
      const current = session;
      session = null;
      if (current) await (await current.catch(() => null))?.stop();
    },
  };
}

export async function runCompanion(): Promise<void> {
  await mkdir(SUPPORT_DIR, { recursive: true, mode: 0o700 });
  const config = parseConfig(existsSync(CONFIG_PATH) ? JSON.parse(await readFile(CONFIG_PATH, "utf8")) : {});
  const tokens = await createFileTokenStore(join(SUPPORT_DIR, "tokens.json"));
  const supervisor = createAppleSupervisor(config);
  const touchIdBinary = join(SUPPORT_DIR, "bin/touchid");
  const server = createCompanionServer({
    port: config.port,
    allowedOrigins: config.allowedOrigins,
    apple: supervisor.get,
    userCheck: createTouchIdCheck(touchIdBinary, config.biometricsOnly),
    tokens,
    log,
    iconDirectory: join(SUPPORT_DIR, "extension"),
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", () => resolve());
  });
  log(`Companion listening on http://127.0.0.1:${config.port} for ${config.allowedOrigins.join(", ") || "no origins"}`);
  supervisor.get().then(
    () => log("Apple Passwords bridge is ready"),
    (error: unknown) => log(`Apple Passwords bridge is not ready: ${error instanceof Error ? error.message : String(error)}`),
  );
  const shutdown = () => {
    log("Stopping");
    server.close();
    supervisor.stop().finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
