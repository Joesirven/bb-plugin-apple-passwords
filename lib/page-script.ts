export interface PickerLogin {
  username: string;
}

export interface PickerTheme {
  dark: boolean;
}

export interface PageInfo {
  origin: string;
  hostname: string;
  hasLoginField: boolean;
}

export interface FillResult {
  filled: boolean;
  reason: string | null;
}

export type PageMessage =
  | { type: "apple-passwords-pick"; nonce: string; username: string }
  | { type: "apple-passwords-dismiss"; nonce: string };

export function parsePageMessage(data: unknown): PageMessage | null {
  if (data === null || typeof data !== "object") return null;
  const value = data as Record<string, unknown>;
  if (typeof value.nonce !== "string") return null;
  if (value.type === "apple-passwords-pick" && typeof value.username === "string") {
    return { type: "apple-passwords-pick", nonce: value.nonce, username: value.username };
  }
  if (value.type === "apple-passwords-dismiss") return { type: "apple-passwords-dismiss", nonce: value.nonce };
  return null;
}

const PAGE_HELPERS = String.raw`
  const KEY = "__bbApplePasswords";
  const visible = (input) => {
    if (!(input instanceof HTMLInputElement) || input.disabled || input.readOnly) return false;
    const style = getComputedStyle(input);
    if (style.visibility === "hidden" || style.display === "none") return false;
    const rect = input.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const USER_HINT = /user|email|e-mail|login|account|identifier|phone|name/i;
  const TEXT_TYPES = new Set(["text", "email", "tel", ""]);
  const inputs = () => Array.from(document.querySelectorAll("input")).filter(visible);
  const passwordFields = () => inputs().filter((input) => input.type === "password");
  const isUserField = (input) => {
    if (!TEXT_TYPES.has(input.type)) return false;
    const auto = (input.autocomplete || "").toLowerCase();
    if (auto.includes("username") || auto.includes("email")) return true;
    if (input.type === "email") return true;
    return USER_HINT.test([input.name, input.id, input.placeholder, input.getAttribute("aria-label") || ""].join(" "));
  };
  const findFields = () => {
    const passwords = passwordFields();
    const all = inputs();
    const password = passwords.find((field) => !/new-password/i.test(field.autocomplete || "")) || passwords[0] || null;
    let user = null;
    if (password) {
      const before = all.slice(0, all.indexOf(password)).filter((input) => TEXT_TYPES.has(input.type));
      const sameForm = before.filter((input) => input.form === password.form);
      user = sameForm.reverse().find(isUserField) || before.reverse().find(isUserField) || null;
    } else {
      user = all.find(isUserField) || null;
    }
    return { user, password };
  };
`;

export function buildInspectExpression(): string {
  return `(() => {
${PAGE_HELPERS}
  const fields = findFields();
  return { origin: location.origin, hostname: location.hostname, hasLoginField: Boolean(fields.user || fields.password) };
})()`;
}

export function buildPickerExpression(input: {
  nonce: string;
  hostname: string;
  logins: PickerLogin[];
  theme: PickerTheme;
  message: string | null;
}): string {
  return `((options) => {
${PAGE_HELPERS}
  const previous = globalThis[KEY];
  if (previous && previous.close) previous.close();
  const fields = findFields();
  const anchor = fields.user || fields.password;
  const host = document.createElement("bb-apple-passwords");
  const root = host.attachShadow({ mode: "closed" });
  const dark = options.theme.dark;
  const colors = dark
    ? { bg: "#1f1f22", fg: "#f2f2f4", muted: "#a1a1aa", border: "#3a3a40", hover: "#2c2c31" }
    : { bg: "#ffffff", fg: "#18181b", muted: "#6b6b75", border: "#dedee3", hover: "#f2f2f5" };
  const style = document.createElement("style");
  style.textContent = [
    ":host { all: initial; }",
    ".panel { position: fixed; z-index: 2147483647; width: 280px; max-height: 320px; overflow: auto; box-sizing: border-box;",
    "  font: 13px/1.4 -apple-system, BlinkMacSystemFont, sans-serif; color: " + colors.fg + "; background: " + colors.bg + ";",
    "  border: 1px solid " + colors.border + "; border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.22); padding: 6px; }",
    ".title { display: flex; justify-content: space-between; align-items: center; padding: 4px 8px 6px; color: " + colors.muted + "; font-size: 12px; }",
    ".close { all: unset; cursor: pointer; padding: 0 4px; font-size: 16px; color: " + colors.muted + "; }",
    ".login { all: unset; box-sizing: border-box; display: block; width: 100%; padding: 8px; border-radius: 6px; cursor: pointer;",
    "  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    ".login:hover, .login:focus-visible { background: " + colors.hover + "; }",
    ".note { padding: 8px; color: " + colors.muted + "; }",
  ].join("\\n");
  const panel = document.createElement("div");
  panel.className = "panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Apple Passwords");
  const title = document.createElement("div");
  title.className = "title";
  const label = document.createElement("span");
  label.textContent = "Apple Passwords · " + options.hostname;
  const closeButton = document.createElement("button");
  closeButton.className = "close";
  closeButton.setAttribute("aria-label", "Close");
  closeButton.textContent = "×";
  title.append(label, closeButton);
  panel.append(title);
  if (options.message) {
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = options.message;
    panel.append(note);
  }
  for (const login of options.logins) {
    const button = document.createElement("button");
    button.className = "login";
    button.textContent = login.username || "(no user name)";
    button.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      label.textContent = "Confirm with Touch ID…";
      bb.postMessage({ type: "apple-passwords-pick", nonce: options.nonce, username: login.username });
    });
    panel.append(button);
  }
  root.append(style, panel);
  const place = () => {
    const rect = anchor ? anchor.getBoundingClientRect() : null;
    const top = rect ? Math.min(rect.bottom + 6, innerHeight - 60) : 12;
    const left = rect ? Math.max(8, Math.min(rect.left, innerWidth - 288)) : innerWidth - 292;
    panel.style.top = top + "px";
    panel.style.left = left + "px";
  };
  place();
  const onKey = (event) => {
    if (event.key === "Escape") close(true);
  };
  const onPointer = (event) => {
    if (event.isTrusted && !event.composedPath().includes(host)) close(true);
  };
  const close = (notify) => {
    host.remove();
    removeEventListener("keydown", onKey, true);
    removeEventListener("pointerdown", onPointer, true);
    removeEventListener("resize", place);
    removeEventListener("scroll", place, true);
    if (globalThis[KEY] && globalThis[KEY].nonce === options.nonce) delete globalThis[KEY];
    if (notify) bb.postMessage({ type: "apple-passwords-dismiss", nonce: options.nonce });
  };
  closeButton.addEventListener("click", (event) => {
    if (event.isTrusted) close(true);
  });
  addEventListener("keydown", onKey, true);
  addEventListener("pointerdown", onPointer, true);
  addEventListener("resize", place);
  addEventListener("scroll", place, true);
  (document.body || document.documentElement).append(host);
  globalThis[KEY] = { nonce: options.nonce, close: () => close(false), status: (text) => { label.textContent = text; } };
  const first = panel.querySelector(".login");
  if (first) first.focus({ preventScroll: true });
  return { shown: true, anchored: Boolean(anchor) };
})(${JSON.stringify(input)})`;
}

export function buildStatusExpression(nonce: string, text: string): string {
  return `(() => {
  const current = globalThis.__bbApplePasswords;
  if (current && current.nonce === ${JSON.stringify(nonce)}) current.status(${JSON.stringify(text)});
  return null;
})()`;
}

export function buildCloseExpression(): string {
  return `(() => {
  const current = globalThis.__bbApplePasswords;
  if (current) current.close();
  return null;
})()`;
}

export function buildFillExpression(input: { origin: string; nonce: string; username: string; password: string }): string {
  return `((options) => {
${PAGE_HELPERS}
  const current = globalThis[KEY];
  if (!current || current.nonce !== options.nonce) return { filled: false, reason: "The picker was closed" };
  if (location.origin !== options.origin) {
    current.close();
    return { filled: false, reason: "The page changed to another site" };
  }
  const setValue = (input, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    input.focus();
    setter.call(input, value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertReplacementText", data: value }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const fields = findFields();
  if (fields.user && options.username) setValue(fields.user, options.username);
  if (fields.password) setValue(fields.password, options.password);
  current.close();
  if (!fields.user && !fields.password) return { filled: false, reason: "No login field on this page" };
  return { filled: true, reason: null };
})(${JSON.stringify(input)})`;
}
