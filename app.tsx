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
import { companion, CompanionError, type CompanionStatus, type SearchResult } from "@/lib/companion";
import {
  buildCloseExpression,
  buildFillExpression,
  buildInspectExpression,
  buildArmExpression,
  buildPickerExpression,
  buildResultsExpression,
  buildStatusExpression,
  isSameSite,
  parsePageMessage,
  type FillResult,
  type PageInfo,
  type PickerLogin,
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
  logins: PickerLogin[];
}

type OpenMode = "explicit" | "field";

const NEEDS_CONNECT = new Set(["not-connected"]);
const ICON_CACHE = new Map<string, Promise<string>>();

function appleIconUrl(paired: boolean, dark: boolean): Promise<string> {
  const name = `PasswordsToolbar${paired ? "" : "Unpaired"}${dark ? "-darkmode" : ""}_icon32.png`;
  let cached = ICON_CACHE.get(name);
  if (!cached) {
    cached = companion.icon(name).then((blob) => URL.createObjectURL(blob));
    cached.catch(() => ICON_CACHE.delete(name));
    ICON_CACHE.set(name, cached);
  }
  return cached;
}

function useFillFlow(page: ExperimentalPluginBrowserPage | null, url: string) {
  const navigate = useBbNavigate();
  const armNonce = useRef(newNonce());
  const session = useRef<PickerSession | null>(null);
  const opening = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paired, setPaired] = useState(false);

  const refreshPairing = useCallback(() => {
    if (!companion.hasToken()) {
      setPaired(false);
      return;
    }
    companion.status().then(
      (status) => setPaired(status.connected && status.pairing === "paired"),
      () => setPaired(false),
    );
  }, []);

  const showPicker = useCallback(
    async (
      info: PageInfo,
      options: { logins: PickerLogin[]; message: string | null; action: string | null; searchable: boolean; focus: boolean },
    ) => {
      if (page === null) return;
      const nonce = newNonce();
      session.current = { nonce, origin: info.origin, hostname: info.hostname, logins: options.logins };
      await page.evaluate(
        buildPickerExpression({ nonce, hostname: info.hostname, theme: { dark: isDarkTheme() }, ...options }),
      );
    },
    [page],
  );

  const startPairing = useCallback(
    async (info: PageInfo) => {
      const state = await companion.challenge();
      if (state === "paired") return true;
      if (state !== "awaiting-code") throw new Error("Apple Passwords did not start pairing. Check that iCloud Keychain is on.");
      await showPicker(info, {
        logins: [],
        message: "macOS shows a six-digit code. Type it in the Apple Passwords panel in bb.",
        action: null,
        searchable: false,
        focus: false,
      });
      navigate.toPluginPanel(PANEL_PATH);
      return false;
    },
    [navigate, showPicker],
  );

  const open = useCallback(
    async (mode: OpenMode): Promise<void> => {
      if (page === null || opening.current) return;
      opening.current = true;
      setError(null);
      setBusy(mode === "explicit");
      try {
        const info = parsePageInfo(await page.evaluate(buildInspectExpression()));
        if (!info || !isWebUrl(info.origin)) {
          if (mode === "explicit") throw new Error("Open a web page with a login form first");
          return;
        }
        if (!companion.hasToken()) {
          if (mode === "field") {
            await showPicker(info, {
              logins: [],
              message: "Apple Passwords is not connected to bb.",
              action: "Connect with Touch ID",
              searchable: false,
              focus: false,
            });
            return;
          }
          await companion.connect();
        }
        let result: { hostname: string; usernames: string[] };
        try {
          result = await companion.logins(info.origin);
        } catch (cause) {
          if (!(cause instanceof CompanionError)) throw cause;
          if (cause.code === "offline") {
            if (mode === "explicit") navigate.toPluginPanel(PANEL_PATH);
            return;
          }
          if (NEEDS_CONNECT.has(cause.code) || cause.code === "unpaired") {
            if (mode === "field") {
              await showPicker(info, {
                logins: [],
                message: cause.code === "unpaired" ? "Apple Passwords needs to pair with bb again." : "Apple Passwords is not connected to bb.",
                action: cause.code === "unpaired" ? "Pair with Apple Passwords" : "Connect with Touch ID",
                searchable: false,
                focus: false,
              });
              return;
            }
            if (NEEDS_CONNECT.has(cause.code)) await companion.connect();
            else if (!(await startPairing(info))) return;
            result = await companion.logins(info.origin);
          } else {
            throw cause;
          }
        }
        setPaired(true);
        if (result.usernames.length === 0 && mode === "field") return;
        await showPicker(info, {
          logins: result.usernames.map((username) => ({ username, site: null })),
          message: result.usernames.length === 0 ? `No saved passwords for ${result.hostname}. Search below.` : null,
          action: null,
          searchable: true,
          focus: mode === "explicit",
        });
      } catch (cause) {
        if (mode === "explicit") {
          setError(cause instanceof CompanionError && cause.code === "user-denied" ? "Touch ID was cancelled" : errorText(cause));
        }
      } finally {
        opening.current = false;
        setBusy(false);
        refreshPairing();
      }
    },
    [navigate, page, refreshPairing, showPicker, startPairing],
  );

  useEffect(() => {
    if (page === null) return;
    return page.onMessage((data) => {
      const message = parsePageMessage(data);
      if (!message) return;
      if (message.type === "apple-passwords-field") {
        if (message.nonce === armNonce.current) void open("field");
        return;
      }
      const current = session.current;
      if (!current || message.nonce !== current.nonce) return;
      if (message.type === "apple-passwords-dismiss") {
        session.current = null;
        return;
      }
      if (message.type === "apple-passwords-action") {
        page.evaluate(buildCloseExpression()).catch(() => undefined);
        session.current = null;
        void open("explicit");
        return;
      }
      if (message.type === "apple-passwords-search") {
        const reply = (logins: PickerLogin[], text: string | null) =>
          page.evaluate(buildResultsExpression(current.nonce, logins, text)).catch(() => undefined);
        if (message.query === "") {
          void reply(current.logins, current.logins.length === 0 ? "Type a site or a user name." : null);
          return;
        }
        companion.search(message.query).then(
          (results) => reply(results, results.length === 0 ? `Nothing found for “${message.query}”.` : null),
          (cause: unknown) => reply([], errorText(cause)),
        );
        return;
      }
      if (message.site !== null && !isSameSite(message.site, current.hostname) && !message.confirmed) return;
      setBusy(true);
      companion
        .password({ url: current.origin, ...(message.site ? { site: message.site } : {}), username: message.username })
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
  }, [open, page]);

  useEffect(() => {
    if (page === null || !isWebUrl(url)) return;
    const arm = (reset: boolean) =>
      page.evaluate(buildArmExpression({ nonce: armNonce.current, reset })).catch(() => undefined);
    void arm(true);
    const timer = setInterval(() => void arm(false), 1500);
    return () => clearInterval(timer);
  }, [page, url]);

  useEffect(() => {
    refreshPairing();
    setError(null);
  }, [url, refreshPairing]);

  useEffect(
    () => () => {
      if (session.current) page?.evaluate(buildCloseExpression()).catch(() => undefined);
      session.current = null;
    },
    [page],
  );

  return { open, busy, error, paired };
}

function AppleKeysIcon({ paired, busy }: { paired: boolean; busy: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    appleIconUrl(paired, isDarkTheme()).then(
      (next) => active && setSrc(next),
      () => active && setSrc(null),
    );
    return () => {
      active = false;
    };
  }, [paired]);
  if (busy) return <Icon name="LoaderCircle" aria-hidden className="animate-spin" />;
  if (src === null) return <Icon name="KeyRound" aria-hidden />;
  return <img src={src} alt="" aria-hidden className="size-4" draggable={false} />;
}

function PasswordsToolbarAction({ url, experimental_page: page }: ExperimentalPluginBrowserToolbarActionProps) {
  const { open, busy, error, paired } = useFillFlow(page, url);
  const disabled = page === null || !isWebUrl(url);
  const label =
    page === null ? "Apple Passwords works in the bb desktop app" : (error ?? "Fill a password from Apple Passwords");
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled || busy}
      onClick={() => void open("explicit")}
      className={cn(
        "relative flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40",
        error !== null && "text-destructive",
      )}
    >
      <AppleKeysIcon paired={paired} busy={busy} />
      {error !== null ? <span className="absolute right-1 top-1 size-1.5 rounded-full bg-destructive" aria-hidden /> : null}
    </button>
  );
}

function PasswordSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const term = query.trim();
    if (term === "") {
      setResults([]);
      setNote(null);
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      companion.search(term).then(
        (next) => {
          if (!active) return;
          setResults(next);
          setNote(next.length === 0 ? `Nothing found for “${term}”.` : null);
        },
        (cause: unknown) => active && setNote(errorText(cause)),
      );
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query]);

  const copy = (result: SearchResult) => {
    if (result.site === null) return;
    setBusy(true);
    setNote(null);
    companion
      .password({ site: result.site, username: result.username })
      .then(async (credential) => {
        await navigator.clipboard.writeText(credential.password);
        setNote(`Copied the password for ${result.username}.`);
      })
      .catch((cause: unknown) =>
        setNote(cause instanceof CompanionError && cause.code === "user-denied" ? "Touch ID was cancelled" : errorText(cause)),
      )
      .finally(() => setBusy(false));
  };

  return (
    <Step done={false} title="Search your passwords">
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value.slice(0, 253))}
        placeholder="A site or a user name"
        aria-label="Search passwords"
      />
      {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
      <ul className="flex flex-col divide-y divide-border">
        {results.map((result) => (
          <li key={`${result.username}@${result.site ?? ""}`} className="flex items-center gap-2 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{result.username || "(no user name)"}</p>
              <p className="truncate text-xs text-muted-foreground">{result.site ?? "Unknown site"}</p>
            </div>
            <Button size="sm" variant="outline" disabled={busy || result.site === null} onClick={() => copy(result)}>
              Copy password
            </Button>
          </li>
        ))}
      </ul>
    </Step>
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
              {offline
                ? "bb cannot reach the companion. Either it is not running on this Mac, or it does not allow this bb address. "
                : ""}
              Run this in Terminal on this Mac. It needs Node 24, Google Chrome and the iCloud Passwords extension from
              the Chrome Web Store.
            </p>
            <code className="block select-all break-all rounded-md bg-muted p-2 text-xs">
              {`${INSTALL_COMMAND} --origin ${location.origin}`}
            </code>
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
              autoFocus
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
        <>
          <p className="text-sm text-muted-foreground">
            Ready. When you click a login field in the bb browser, your saved logins appear below it. The keys button
            beside the address bar opens them too.
          </p>
          <PasswordSearch />
        </>
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
