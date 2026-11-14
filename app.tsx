import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  definePluginApp,
  useBbNavigate,
  type ExperimentalPluginBrowserPage,
  type ExperimentalPluginBrowserToolbarActionProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { companion, CompanionError, type CompanionStatus } from "@/lib/companion";
import {
  buildCloseExpression,
  buildFillExpression,
  buildInspectExpression,
  buildPickerExpression,
  buildStatusExpression,
  parsePageMessage,
  type FillResult,
  type PageInfo,
} from "@/lib/page-script";
import { cn } from "@/lib/utils";

const PANEL_PATH = "setup";
const INSTALL_COMMAND =
  "git clone https://github.com/Joesirven/bb-plugin-apple-passwords && node bb-plugin-apple-passwords/companion/cli.ts install";

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isDarkTheme(): boolean {
  return document.documentElement.classList.contains("dark") || matchMedia("(prefers-color-scheme: dark)").matches;
}

function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parsePageInfo(value: unknown): PageInfo | null {
  if (value === null || typeof value !== "object") return null;
  const info = value as Record<string, unknown>;
  if (typeof info.origin !== "string" || typeof info.hostname !== "string") return null;
  return { origin: info.origin, hostname: info.hostname, hasLoginField: info.hasLoginField === true };
}

function parseFillResult(value: unknown): FillResult {
  const result = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return { filled: result.filled === true, reason: typeof result.reason === "string" ? result.reason : null };
}

function isWebUrl(url: string): boolean {
  return url.startsWith("https://") || url.startsWith("http://");
}

interface PickerSession {
  nonce: string;
  origin: string;
  hostname: string;
}

function useFillFlow(page: ExperimentalPluginBrowserPage | null) {
  const session = useRef<PickerSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (page === null) return;
    return page.onMessage((data) => {
      const message = parsePageMessage(data);
      const current = session.current;
      if (!message || !current || message.nonce !== current.nonce) return;
      if (message.type === "apple-passwords-dismiss") {
        session.current = null;
        return;
      }
      setBusy(true);
      companion
        .password(current.origin, message.username)
        .then(
          async (credential) => {
            const result = parseFillResult(
              await page.evaluate(
                buildFillExpression({
                  origin: current.origin,
                  nonce: current.nonce,
                  username: credential.username,
                  password: credential.password,
                }),
              ),
            );
            session.current = null;
            setError(result.filled ? null : result.reason);
          },
          async (cause: unknown) => {
            const text = cause instanceof CompanionError && cause.code === "user-denied" ? "Touch ID was cancelled" : errorText(cause);
            setError(text);
            await page.evaluate(buildStatusExpression(current.nonce, text)).catch(() => undefined);
          },
        )
        .finally(() => setBusy(false));
    });
  }, [page]);

  useEffect(
    () => () => {
      if (session.current) page?.evaluate(buildCloseExpression()).catch(() => undefined);
      session.current = null;
    },
    [page],
  );

  const open = useCallback(async () => {
    if (page === null) return;
    setError(null);
    setBusy(true);
    try {
      const info = parsePageInfo(await page.evaluate(buildInspectExpression()));
      if (!info || !isWebUrl(info.origin)) throw new Error("Open a web page with a login form first");
      const { hostname, usernames } = await companion.logins(info.origin);
      const nonce = newNonce();
      session.current = { nonce, origin: info.origin, hostname };
      const message =
        usernames.length === 0
          ? `No saved passwords for ${hostname}`
          : info.hasLoginField
            ? null
            : "No login field found. Click a login field first.";
      await page.evaluate(
        buildPickerExpression({
          nonce,
          hostname,
          logins: usernames.map((username) => ({ username })),
          theme: { dark: isDarkTheme() },
          message,
        }),
      );
    } catch (cause) {
      session.current = null;
      setError(errorText(cause));
      throw cause;
    } finally {
      setBusy(false);
    }
  }, [page]);

  return { open, busy, error, setError };
}

function PasswordsToolbarAction({ url, experimental_page: page }: ExperimentalPluginBrowserToolbarActionProps) {
  const navigate = useBbNavigate();
  const { open, busy, error, setError } = useFillFlow(page);

  useEffect(() => setError(null), [url, setError]);

  const onClick = useCallback(() => {
    if (!companion.hasToken()) {
      navigate.toPluginPanel(PANEL_PATH);
      return;
    }
    open().catch((cause: unknown) => {
      if (cause instanceof CompanionError && ["offline", "not-connected", "unpaired"].includes(cause.code)) {
        navigate.toPluginPanel(PANEL_PATH);
      }
    });
  }, [navigate, open]);

  const disabled = page === null || !isWebUrl(url);
  const label =
    page === null ? "Apple Passwords works in the bb desktop app" : (error ?? "Fill a password from Apple Passwords");
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled || busy}
      onClick={onClick}
      className={cn(
        "relative flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40",
        error !== null && "text-destructive",
      )}
    >
      <Icon name={busy ? "LoaderCircle" : "KeyRound"} aria-hidden className={busy ? "animate-spin" : undefined} />
    </button>
  );
}

const PAIRING_TEXT: Record<CompanionStatus["pairing"], string> = {
  unavailable: "Apple Passwords is not available",
  unpaired: "Not paired with Apple Passwords",
  "awaiting-code": "Waiting for the code that macOS shows",
  paired: "Paired with Apple Passwords",
  starting: "Apple Passwords is starting",
};

function Step({ done, title, children }: { done: boolean; title: string; children: ReactNode }) {
  return (
    <section className="flex gap-3 rounded-lg border border-border p-4">
      <Icon name={done ? "CircleCheck" : "Circle"} className={done ? "text-success" : "text-muted-foreground"} aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <h2 className="text-sm font-medium">{title}</h2>
        {children}
      </div>
    </section>
  );
}

function SetupPage() {
  const [status, setStatus] = useState<CompanionStatus | null>(null);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pin, setPin] = useState("");

  const refresh = useCallback(() => {
    companion.status().then(
      (next) => {
        setStatus(next);
        setOffline(false);
      },
      (cause: unknown) => {
        setStatus(null);
        setOffline(cause instanceof CompanionError && cause.code === "offline");
        if (!(cause instanceof CompanionError && cause.code === "offline")) setError(errorText(cause));
      },
    );
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  }, [refresh]);

  const run = useCallback(
    (task: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      task()
        .catch((cause: unknown) => setError(errorText(cause)))
        .finally(() => {
          setBusy(false);
          refresh();
        });
    },
    [refresh],
  );

  const submitPin = (event: FormEvent) => {
    event.preventDefault();
    const code = pin.trim();
    setPin("");
    run(async () => {
      const state = await companion.verify(code);
      if (state !== "paired") throw new Error("Apple Passwords did not accept the code. Start pairing again.");
    });
  };

  const running = status !== null;
  const connected = status?.connected === true;
  const paired = status?.pairing === "paired";

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">Apple Passwords</h1>
        <p className="text-sm text-muted-foreground">
          Fill saved Apple Passwords into the bb browser. Every password needs Touch ID on this Mac.
        </p>
      </header>

      <Step done={running} title="1. Run the companion on this Mac">
        {running ? (
          <p className="text-sm text-muted-foreground">Companion {status.version} is running.</p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {offline ? "The companion is not running. " : ""}Run this in Terminal. It needs Node 24, Google Chrome and
              the iCloud Passwords extension from the Chrome Web Store.
            </p>
            <code className="block select-all break-all rounded-md bg-muted p-2 text-xs">{INSTALL_COMMAND}</code>
          </>
        )}
      </Step>

      <Step done={connected} title="2. Connect bb with Touch ID">
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={!running || busy} onClick={() => run(() => companion.connect())}>
            {connected ? "Connect again" : "Connect"}
          </Button>
          {connected ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => companion.disconnect())}>
              Disconnect
            </Button>
          ) : null}
        </div>
      </Step>

      <Step done={paired} title="3. Pair with Apple Passwords">
        <p className="text-sm text-muted-foreground">
          {status ? PAIRING_TEXT[status.pairing] : "Start the companion first."}
          {status?.detail ? ` ${status.detail}` : ""}
        </p>
        {status?.pairing === "awaiting-code" ? (
          <form className="flex items-center gap-2" onSubmit={submitPin}>
            <Input
              value={pin}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="6-digit code"
              aria-label="Code from macOS"
              className="w-36"
            />
            <Button size="sm" type="submit" disabled={busy || pin.length !== 6}>
              Pair
            </Button>
          </form>
        ) : (
          <div>
            <Button
              size="sm"
              disabled={!connected || busy || status?.pairing === "unavailable"}
              onClick={() =>
                run(async () => {
                  const state = await companion.challenge();
                  if (state !== "awaiting-code" && state !== "paired") {
                    throw new Error("Apple Passwords did not start pairing. Check that iCloud Keychain is on.");
                  }
                })
              }
            >
              {paired ? "Pair again" : "Start pairing"}
            </Button>
          </div>
        )}
      </Step>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {paired && connected ? (
        <p className="text-sm text-muted-foreground">
          Ready. Open a login page in the bb browser and click the key button beside the address bar.
        </p>
      ) : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "setup",
    title: "Apple Passwords",
    icon: "KeyRound",
    path: PANEL_PATH,
    component: SetupPage,
  });
  app.slots.experimental_browserToolbarAction({
    id: "fill",
    title: "Apple Passwords",
    component: PasswordsToolbarAction,
  });
});
