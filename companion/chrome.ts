import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { CdpPipe, evaluate } from "./cdp.ts";

export const APPLE_EXTENSION_ID = "pejdijmoenmkgeppbflobdenhhabjlaj";
export const APPLE_NATIVE_HOST_MANIFEST =
  "/Library/Google/Chrome/NativeMessagingHosts/com.apple.passwordmanager.json";

const CHROME_BINARIES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

const PROFILE_ROOTS = [
  "Google/Chrome",
  "Chromium",
  "BraveSoftware/Brave-Browser",
  "Microsoft Edge",
  "Arc/User Data",
  "Dia/User Data",
  "net.imput.helium",
];

export class SetupError extends Error {}

export function findChromeBinary(override: string | undefined): string {
  const candidates = override ? [override] : CHROME_BINARIES;
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new SetupError(
      "No Chromium browser found. Install Google Chrome, or set chromePath in the companion config.",
    );
  }
  return found;
}

function compareVersions(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

async function directories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

export async function findExtensionSource(home: string): Promise<{ path: string; version: string }> {
  const found: { path: string; version: string }[] = [];
  for (const root of PROFILE_ROOTS) {
    const base = join(home, "Library/Application Support", root);
    for (const profile of await directories(base)) {
      const extensionDir = join(base, profile, "Extensions", APPLE_EXTENSION_ID);
      for (const version of await directories(extensionDir)) {
        const path = join(extensionDir, version);
        if (existsSync(join(path, "manifest.json")) && existsSync(join(path, "background.js"))) {
          found.push({ path, version });
        }
      }
    }
  }
  found.sort((a, b) => compareVersions(b.version, a.version));
  const best = found[0];
  if (!best) {
    throw new SetupError(
      "Apple's iCloud Passwords extension is not installed in any Chromium browser. Install it from https://chromewebstore.google.com/detail/icloud-passwords/pejdijmoenmkgeppbflobdenhhabjlaj and run the companion again.",
    );
  }
  return best;
}

export async function prepareExtension(source: string, target: string): Promise<void> {
  const marker = join(target, ".source");
  const current = existsSync(marker) ? await readFile(marker, "utf8") : "";
  if (current === source && existsSync(join(target, "manifest.json"))) return;
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true, mode: 0o700 });
  await cp(source, target, { recursive: true });
  await rm(join(target, "_metadata"), { recursive: true, force: true });
  const manifest = JSON.parse(await readFile(join(target, "manifest.json"), "utf8")) as { key?: unknown };
  if (typeof manifest.key !== "string") {
    throw new SetupError("The copied extension has no signing key, so Apple's helper would reject it.");
  }
  await writeFile(marker, source, { mode: 0o600 });
}

export async function prepareProfile(profileDir: string): Promise<void> {
  if (!existsSync(APPLE_NATIVE_HOST_MANIFEST)) {
    throw new SetupError(
      "Apple's password helper manifest is missing. This needs macOS 14 or later with iCloud Keychain turned on.",
    );
  }
  const hosts = join(profileDir, "NativeMessagingHosts");
  await mkdir(hosts, { recursive: true, mode: 0o700 });
  await copyFile(APPLE_NATIVE_HOST_MANIFEST, join(hosts, "com.apple.passwordmanager.json"));
}

export interface ChromeSession {
  evaluateInExtension(expression: string, timeoutMs?: number): Promise<unknown>;
  stop(): Promise<void>;
  onExit(listener: (reason: string) => void): void;
}

export interface LaunchOptions {
  chromePath: string;
  profileDir: string;
  extensionDir: string;
  log: (message: string) => void;
}

const SERVICE_WORKER_URL = `chrome-extension://${APPLE_EXTENSION_ID}/background.js`;

export async function launchChrome(options: LaunchOptions): Promise<ChromeSession> {
  const child: ChildProcess = spawn(
    options.chromePath,
    [
      `--user-data-dir=${options.profileDir}`,
      "--remote-debugging-pipe",
      "--enable-unsafe-extension-debugging",
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-sync",
      "--disable-component-update",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  );
  const exitListeners = new Set<(reason: string) => void>();
  let exited = false;
  child.on("exit", (code, signal) => {
    exited = true;
    const reason = `Chrome exited (code ${code ?? "none"}, signal ${signal ?? "none"})`;
    cdp.close(new Error(reason));
    for (const listener of exitListeners) listener(reason);
  });
  const cdp = new CdpPipe(child.stdio[4] as Readable, child.stdio[3] as Writable);
  let sessionId: string | null = null;

  cdp.onEvent((event) => {
    if (event.method === "Target.detachedFromTarget" && event.params.sessionId === sessionId) {
      sessionId = null;
    }
  });

  async function stop(): Promise<void> {
    if (exited) return;
    await cdp.send("Browser.close", {}, { timeoutMs: 3000 }).catch(() => undefined);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async function findWorkerTarget(): Promise<string | null> {
    const result = await cdp.send("Target.getTargets");
    const infos = (result.targetInfos as { targetId: string; type: string; url: string }[]) ?? [];
    return infos.find((info) => info.type === "service_worker" && info.url === SERVICE_WORKER_URL)?.targetId ?? null;
  }

  async function wakeWorker(): Promise<void> {
    const created = await cdp.send("Target.createTarget", {
      url: `chrome-extension://${APPLE_EXTENSION_ID}/page_popup.html`,
    });
    const targetId = created.targetId as string;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
  }

  async function attach(): Promise<string> {
    if (sessionId !== null) return sessionId;
    let targetId: string | null = null;
    for (let attempt = 0; attempt < 40 && targetId === null; attempt++) {
      targetId = await findWorkerTarget();
      if (targetId === null) {
        if (attempt === 10) await wakeWorker();
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (targetId === null) throw new SetupError("Apple's extension service worker did not start");
    const attached = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    sessionId = attached.sessionId as string;
    return sessionId;
  }

  try {
    const loaded = await cdp.send("Extensions.loadUnpacked", { path: options.extensionDir }, { timeoutMs: 20_000 });
    if (loaded.id !== APPLE_EXTENSION_ID) {
      throw new SetupError(`Chrome loaded the extension with the wrong id ${String(loaded.id)}`);
    }
    await attach();
  } catch (error) {
    await stop();
    throw error;
  }
  options.log("Chrome started with Apple's iCloud Passwords extension");

  return {
    async evaluateInExtension(expression, timeoutMs) {
      try {
        return await evaluate(cdp, await attach(), expression, timeoutMs);
      } catch (error) {
        if (sessionId === null && !exited) return evaluate(cdp, await attach(), expression, timeoutMs);
        throw error;
      }
    },
    stop,
    onExit(listener) {
      exitListeners.add(listener);
    },
  };
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
