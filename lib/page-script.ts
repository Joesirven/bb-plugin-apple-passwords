export interface PickerLogin {
  username: string;
  site: string | null;
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
  | { type: "apple-passwords-field"; nonce: string }
  | { type: "apple-passwords-pick"; nonce: string; username: string; site: string | null; confirmed: boolean }
  | { type: "apple-passwords-search"; nonce: string; query: string }
  | { type: "apple-passwords-action"; nonce: string }
  | { type: "apple-passwords-dismiss"; nonce: string };

export function parsePageMessage(data: unknown): PageMessage | null {
  if (data === null || typeof data !== "object") return null;
  const value = data as Record<string, unknown>;
  if (typeof value.nonce !== "string") return null;
  const nonce = value.nonce;
  switch (value.type) {
    case "apple-passwords-field":
      return { type: value.type, nonce };
    case "apple-passwords-pick":
      if (typeof value.username !== "string") return null;
      return {
        type: value.type,
        nonce,
        username: value.username,
        site: typeof value.site === "string" ? value.site : null,
        confirmed: value.confirmed === true,
      };
    case "apple-passwords-search":
      if (typeof value.query !== "string" || value.query.length > 253) return null;
      return { type: value.type, nonce, query: value.query };
    case "apple-passwords-action":
    case "apple-passwords-dismiss":
      return { type: value.type, nonce };
    default:
      return null;
  }
}

export function isSameSite(site: string, hostname: string): boolean {
  const a = site.toLowerCase();
  const b = hostname.toLowerCase();
  return a === b || b.endsWith(`.${a}`) || a.endsWith(`.${b}`);
}

export const ARM_VERSION = 1;

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
  const sameSite = (site, hostname) => {
    const a = site.toLowerCase();
    const b = hostname.toLowerCase();
    return a === b || b.endsWith("." + a) || a.endsWith("." + b);
  };
  const suppress = () => {
    const arm = globalThis.__bbApplePasswordsArm;
    if (arm) arm.suppressed = true;
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
  action: string | null;
  searchable: boolean;
  focus: boolean;
}): string {
  return `((options) => {
${PAGE_HELPERS}
  const previous = globalThis[KEY];
  if (previous && previous.close) previous.close();
  const fields = findFields();
  const focused = document.activeElement instanceof HTMLInputElement && visible(document.activeElement) ? document.activeElement : null;
  const anchor = focused || fields.user || fields.password;
  const host = document.createElement("bb-apple-passwords");
  const root = host.attachShadow({ mode: "closed" });
  const dark = options.theme.dark;
  const colors = dark
    ? { bg: "#1f1f22", fg: "#f2f2f4", muted: "#a1a1aa", border: "#3a3a40", hover: "#2c2c31", accent: "#0a84ff" }
    : { bg: "#ffffff", fg: "#18181b", muted: "#6b6b75", border: "#dedee3", hover: "#f2f2f5", accent: "#007aff" };
  const style = document.createElement("style");
  style.textContent = [
    ":host { all: initial; }",
    ".panel { position: fixed; z-index: 2147483647; width: 300px; max-height: 360px; overflow: auto; box-sizing: border-box;",
    "  font: 13px/1.4 -apple-system, BlinkMacSystemFont, sans-serif; color: " + colors.fg + "; background: " + colors.bg + ";",
    "  border: 1px solid " + colors.border + "; border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.22); padding: 6px; }",
    ".title { display: flex; justify-content: space-between; align-items: center; padding: 4px 8px 6px; color: " + colors.muted + "; font-size: 12px; }",
    ".close { all: unset; cursor: pointer; padding: 0 4px; font-size: 16px; color: " + colors.muted + "; }",
    ".search { all: unset; box-sizing: border-box; display: block; width: 100%; margin: 0 0 4px; padding: 6px 8px; border-radius: 6px;",
    "  border: 1px solid " + colors.border + "; color: " + colors.fg + "; font: inherit; }",
    ".login { all: unset; box-sizing: border-box; display: block; width: 100%; padding: 7px 8px; border-radius: 6px; cursor: pointer; }",
    ".login:hover, .login:focus-visible { background: " + colors.hover + "; }",
    ".name, .site { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    ".site { color: " + colors.muted + "; font-size: 11px; }",
    ".note { padding: 8px; color: " + colors.muted + "; }",
    ".action { all: unset; box-sizing: border-box; display: block; margin: 2px 8px 8px; padding: 6px 10px; border-radius: 6px; cursor: pointer;",
    "  background: " + colors.accent + "; color: #fff; text-align: center; }",
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
  const list = document.createElement("div");
  let searchTimer = null;
  if (options.searchable) {
    const search = document.createElement("input");
    search.className = "search";
    search.type = "search";
    search.placeholder = "Search by site";
    search.setAttribute("aria-label", "Search by site");
    search.addEventListener("input", (event) => {
      if (!event.isTrusted) return;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        bb.postMessage({ type: "apple-passwords-search", nonce: options.nonce, query: search.value.trim() });
      }, 300);
    });
    panel.append(search);
  }
  panel.append(list);
  const confirmFill = (login) => {
    list.replaceChildren();
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = "Saved for " + login.site + ". Fill it on " + options.hostname + "?";
    const confirm = document.createElement("button");
    confirm.className = "action";
    confirm.textContent = "Fill on " + options.hostname;
    confirm.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      label.textContent = "Confirm with Touch ID…";
      bb.postMessage({ type: "apple-passwords-pick", nonce: options.nonce, username: login.username, site: login.site, confirmed: true });
    });
    list.append(note, confirm);
    confirm.focus({ preventScroll: true });
  };
  const render = (logins, message, action) => {
    list.replaceChildren();
    if (message) {
      const note = document.createElement("div");
      note.className = "note";
      note.textContent = message;
      list.append(note);
    }
    if (action) {
      const button = document.createElement("button");
      button.className = "action";
      button.textContent = action;
      button.addEventListener("click", (event) => {
        if (!event.isTrusted) return;
        bb.postMessage({ type: "apple-passwords-action", nonce: options.nonce });
      });
      list.append(button);
    }
    for (const login of logins) {
      const button = document.createElement("button");
      button.className = "login";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = login.username || "(no user name)";
      button.append(name);
      if (login.site) {
        const site = document.createElement("span");
        site.className = "site";
        site.textContent = login.site;
        button.append(site);
      }
      button.addEventListener("click", (event) => {
        if (!event.isTrusted) return;
        if (login.site && !sameSite(login.site, options.hostname)) {
          confirmFill(login);
          return;
        }
        label.textContent = "Confirm with Touch ID…";
        bb.postMessage({ type: "apple-passwords-pick", nonce: options.nonce, username: login.username, site: login.site, confirmed: false });
      });
      list.append(button);
    }
  };
  render(options.logins, options.message, options.action);
  root.append(style, panel);
  const place = () => {
    const rect = anchor ? anchor.getBoundingClientRect() : null;
    const top = rect ? Math.min(rect.bottom + 6, innerHeight - 80) : 12;
    const left = rect ? Math.max(8, Math.min(rect.left, innerWidth - 308)) : innerWidth - 312;
    panel.style.top = top + "px";
    panel.style.left = left + "px";
  };
  place();
  const onKey = (event) => {
    if (event.key === "Escape") close(true);
  };
  const onPointer = (event) => {
    if (!event.isTrusted) return;
    const path = event.composedPath();
    if (path.includes(host) || (anchor && path.includes(anchor))) return;
    close(true);
  };
  const close = (notify) => {
    clearTimeout(searchTimer);
    host.remove();
    removeEventListener("keydown", onKey, true);
    removeEventListener("pointerdown", onPointer, true);
    removeEventListener("resize", place);
    removeEventListener("scroll", place, true);
    if (globalThis[KEY] && globalThis[KEY].nonce === options.nonce) delete globalThis[KEY];
    if (notify) {
      suppress();
      bb.postMessage({ type: "apple-passwords-dismiss", nonce: options.nonce });
    }
  };
  closeButton.addEventListener("click", (event) => {
    if (event.isTrusted) close(true);
  });
  addEventListener("keydown", onKey, true);
  addEventListener("pointerdown", onPointer, true);
  addEventListener("resize", place);
  addEventListener("scroll", place, true);
  (document.body || document.documentElement).append(host);
  globalThis[KEY] = {
    nonce: options.nonce,
    close: () => close(false),
    status: (text) => { label.textContent = text; },
    results: (logins, message) => render(logins, message, null),
  };
  if (options.focus) {
    const first = panel.querySelector(".login") || panel.querySelector(".action") || panel.querySelector(".search");
    if (first) first.focus({ preventScroll: true });
  }
  return { shown: true, anchored: Boolean(anchor) };
})(${JSON.stringify(input)})`;
}

export function buildResultsExpression(nonce: string, logins: PickerLogin[], message: string | null): string {
  return `(() => {
  const current = globalThis.__bbApplePasswords;
  if (!current || current.nonce !== ${JSON.stringify(nonce)}) return false;
  current.results(${JSON.stringify(logins)}, ${JSON.stringify(message)});
  return true;
})()`;
}

export function buildArmExpression(input: { nonce: string; reset: boolean }): string {
  return `((options) => {
${PAGE_HELPERS}
  const ARM = "__bbApplePasswordsArm";
  const existing = globalThis[ARM];
  if (existing && existing.version === ${ARM_VERSION} && existing.nonce === options.nonce) {
    if (options.reset) existing.suppressed = false;
    return { installed: false };
  }
  if (existing) existing.disarm();
  const isLoginTarget = (target) => {
    if (!visible(target)) return false;
    const auto = (target.autocomplete || "").toLowerCase();
    if (auto.includes("new-password") || auto.includes("one-time-code")) return false;
    if (target.type === "password") return true;
    if (!isUserField(target)) return false;
    return auto.includes("username") || Boolean(findFields().password);
  };
  const state = { version: ${ARM_VERSION}, nonce: options.nonce, suppressed: false, disarm: () => {} };
  let last = { target: null, at: 0 };
  const offer = (target, explicit) => {
    if (globalThis[KEY] || !isLoginTarget(target)) return;
    if (state.suppressed && !explicit) return;
    const now = Date.now();
    if (last.target === target && now - last.at < 1000) return;
    last = { target, at: now };
    state.suppressed = false;
    bb.postMessage({ type: "apple-passwords-field", nonce: options.nonce });
  };
  const onFocus = (event) => {
    if (event.isTrusted) offer(event.composedPath()[0], false);
  };
  const onClick = (event) => {
    if (event.isTrusted) offer(event.composedPath()[0], true);
  };
  addEventListener("focusin", onFocus, true);
  addEventListener("click", onClick, true);
  state.disarm = () => {
    removeEventListener("focusin", onFocus, true);
    removeEventListener("click", onClick, true);
    if (globalThis[ARM] === state) delete globalThis[ARM];
  };
  globalThis[ARM] = state;
  if (document.activeElement instanceof HTMLInputElement) offer(document.activeElement, false);
  return { installed: true };
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
  suppress();
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
