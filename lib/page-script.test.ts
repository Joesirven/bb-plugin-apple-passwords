import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { after, before, beforeEach, describe, it } from "node:test";
import { CdpPipe } from "../companion/cdp.ts";
import {
  buildArmExpression,
  buildCloseExpression,
  buildResultsExpression,
  buildFillExpression,
  buildInspectExpression,
  buildPickerExpression,
  isSameSite,
  parsePageMessage,
  type PickerLogin,
} from "./page-script.ts";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const LOGIN_PAGE = `<!doctype html><html><body>
<form id="login">
  <label>Search <input id="search" type="search"></label>
  <label>Email <input id="email" name="email" type="email" autocomplete="username"></label>
  <label>Password <input id="password" name="password" type="password" autocomplete="current-password"></label>
  <button type="submit">Sign in</button>
</form>
<script>
  window.events = [];
  for (const id of ["email", "password"]) {
    const input = document.getElementById(id);
    input.addEventListener("input", (event) => window.events.push(id + ":" + event.type + ":" + input.value.length));
    input.addEventListener("change", (event) => window.events.push(id + ":" + event.type));
  }
</script>
</body></html>`;

let chrome: ChildProcess;
let cdp: CdpPipe;
let http: Server;
let profile: string;
let sessionId = "";
let origin = "";
let isolatedContext = 0;

async function send(method: string, params: Record<string, unknown> = {}) {
  return cdp.send(method, params, { sessionId });
}

async function evaluateIn(contextId: number | null, expression: string): Promise<unknown> {
  const wrapped =
    contextId === null
      ? expression
      : `(async (bb) => { const json = JSON.stringify(await (${expression}\n)); return json === undefined ? null : JSON.parse(json); })({ postMessage: (data) => (globalThis.__messages ||= []).push(data) })`;
  const result = await send("Runtime.evaluate", {
    expression: wrapped,
    awaitPromise: true,
    returnByValue: true,
    ...(contextId === null ? {} : { contextId }),
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return (result.result as { value?: unknown }).value;
}

const isolated = (expression: string) => evaluateIn(isolatedContext, expression);
const main = (expression: string) => evaluateIn(null, expression);

async function messages(): Promise<unknown[]> {
  return ((await isolated("globalThis.__messages || []")) as unknown[]) ?? [];
}

async function pressKey(key: string, code: string, keyCode: number) {
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: keyCode });
  if (key === "Enter") await send("Input.dispatchKeyEvent", { type: "char", key, code, text: "\r", windowsVirtualKeyCode: keyCode });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
}

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return read();
}

async function showPicker(
  nonce: string,
  logins: PickerLogin[] = [
    { username: "ana@example.com", site: null },
    { username: "bo", site: null },
  ],
) {
  return isolated(
    buildPickerExpression({
      nonce,
      hostname: "127.0.0.1",
      logins,
      theme: { dark: false },
      message: null,
      action: null,
      searchable: true,
      focus: true,
    }),
  );
}

async function clickElement(selector: string) {
  const rect = (await main(`(() => {
    const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  })()`)) as { x: number; y: number };
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  }
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 150));
}

async function parsedMessages() {
  return (await messages()).map(parsePageMessage);
}

describe("page script in headless Chrome", { skip: !existsSync(CHROME) && "Google Chrome is not installed" }, () => {
  before(async () => {
    http = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(LOGIN_PAGE);
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    profile = mkdtempSync(join(tmpdir(), "apw-page-test-"));
    chrome = spawn(
      CHROME,
      [`--user-data-dir=${profile}`, "--remote-debugging-pipe", "--headless=new", "--no-first-run", "about:blank"],
      { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
    );
    cdp = new CdpPipe(chrome.stdio[4] as Readable, chrome.stdio[3] as Writable);
    const created = await cdp.send("Target.createTarget", { url: "about:blank" });
    const attached = await cdp.send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
    sessionId = attached.sessionId as string;
    await send("Page.enable");
  });

  after(async () => {
    const exited = new Promise((resolve) => chrome.once("exit", resolve));
    await cdp.send("Browser.close").catch(() => undefined);
    chrome.kill();
    await exited;
    http.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  });

  beforeEach(async () => {
    const loaded = new Promise<void>((resolve) => {
      const stop = cdp.onEvent((event) => {
        if (event.method === "Page.loadEventFired") {
          stop();
          resolve();
        }
      });
    });
    const navigation = await send("Page.navigate", { url: `${origin}/login` });
    await loaded;
    const world = await send("Page.createIsolatedWorld", { frameId: navigation.frameId, worldName: "bb-test" });
    isolatedContext = world.executionContextId as number;
    await send("Page.bringToFront");
  });

  it("finds the login fields and reports the page origin", async () => {
    assert.deepEqual(await isolated(buildInspectExpression()), {
      origin,
      hostname: "127.0.0.1",
      hasLoginField: true,
    });
  });

  it("puts the picker in a closed shadow root that the page cannot open", async () => {
    await showPicker("n1");
    assert.equal(await main("document.querySelectorAll('bb-apple-passwords').length"), 1);
    assert.equal(await main("document.querySelector('bb-apple-passwords').shadowRoot"), null);
    assert.equal(await main("document.body.innerText.includes('ana@example.com')"), false);
  });

  it("sends a pick message when the user presses Enter on a login", async () => {
    await showPicker("n2");
    await pressKey("Enter", "Enter", 13);
    const received = await waitFor(messages, (list) => list.length > 0);
    assert.deepEqual(received.map(parsePageMessage), [
      { type: "apple-passwords-pick", nonce: "n2", username: "ana@example.com", site: null, confirmed: false },
    ]);
  });

  it("ignores synthetic clicks that the page dispatches", async () => {
    await showPicker("n3");
    await main(`(() => {
      const host = document.querySelector('bb-apple-passwords');
      host.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    })()`);
    assert.deepEqual(await messages(), []);
    assert.equal(await main("document.querySelectorAll('bb-apple-passwords').length"), 1);
  });

  it("closes on Escape and reports the dismissal", async () => {
    await showPicker("n4");
    await pressKey("Escape", "Escape", 27);
    const received = await waitFor(messages, (list) => list.length > 0);
    assert.deepEqual(received.map(parsePageMessage), [{ type: "apple-passwords-dismiss", nonce: "n4" }]);
    assert.equal(await main("document.querySelectorAll('bb-apple-passwords').length"), 0);
  });

  it("fills the user name and password with input and change events", async () => {
    await showPicker("n5");
    const result = await isolated(
      buildFillExpression({ origin, nonce: "n5", username: "ana@example.com", password: "fake-password-123" }),
    );
    assert.deepEqual(result, { filled: true, reason: null });
    assert.equal(await main("document.getElementById('email').value"), "ana@example.com");
    assert.equal(await main("document.getElementById('password').value.length"), 17);
    assert.equal(await main("document.getElementById('search').value"), "");
    assert.deepEqual(await main("window.events"), [
      "email:input:15",
      "email:change",
      "password:input:17",
      "password:change",
    ]);
    assert.equal(await main("document.querySelectorAll('bb-apple-passwords').length"), 0);
  });

  it("refuses to fill when the page is on another origin", async () => {
    await showPicker("n6");
    const result = await isolated(
      buildFillExpression({ origin: "https://example.com", nonce: "n6", username: "ana", password: "fake" }),
    );
    assert.deepEqual(result, { filled: false, reason: "The page changed to another site" });
    assert.equal(await main("document.getElementById('password').value"), "");
  });

  it("refuses to fill for a picker that is no longer open", async () => {
    await showPicker("n7");
    await isolated(buildCloseExpression());
    const result = await isolated(buildFillExpression({ origin, nonce: "n7", username: "ana", password: "fake" }));
    assert.deepEqual(result, { filled: false, reason: "The picker was closed" });
    assert.equal(await main("document.getElementById('password').value"), "");
  });

  it("offers logins when a login field gets focus, once per arm", async () => {
    assert.deepEqual(await isolated(buildArmExpression({ nonce: "arm1", reset: true })), { installed: true });
    assert.deepEqual(await isolated(buildArmExpression({ nonce: "arm1", reset: false })), { installed: false });
    await clickElement("#password");
    const received = await waitFor(parsedMessages, (list) => list.length > 0);
    await settle();
    assert.deepEqual(await parsedMessages(), [{ type: "apple-passwords-field", nonce: "arm1" }]);
    assert.ok(received.length > 0);
  });

  it("ignores focus on fields that are not login fields and synthetic focus from the page", async () => {
    await isolated(buildArmExpression({ nonce: "arm2", reset: true }));
    await clickElement("#search");
    await main("document.getElementById('password').dispatchEvent(new FocusEvent('focusin', { bubbles: true }))");
    await settle();
    assert.deepEqual(await messages(), []);
  });

  it("stays quiet on focus after a dismissal, but a click opens it again", async () => {
    await isolated(buildArmExpression({ nonce: "arm3", reset: true }));
    await showPicker("p3");
    await pressKey("Escape", "Escape", 27);
    await waitFor(messages, (list) => list.length > 0);
    await isolated("(globalThis.__messages = [], null)");
    await main("document.getElementById('email').focus()");
    await pressKey("Tab", "Tab", 9);
    await settle();
    assert.deepEqual(await messages(), []);
    await clickElement("#email");
    await waitFor(messages, (list) => list.length > 0);
    assert.deepEqual(await parsedMessages(), [{ type: "apple-passwords-field", nonce: "arm3" }]);
  });

  it("does not offer again when the fill moves focus between the fields", async () => {
    await isolated(buildArmExpression({ nonce: "arm4", reset: true }));
    await showPicker("p4");
    const result = await isolated(buildFillExpression({ origin, nonce: "p4", username: "ana", password: "fake" }));
    assert.deepEqual(result, { filled: true, reason: null });
    await settle();
    assert.deepEqual(await messages(), []);
  });

  it("asks before it fills a login that is saved for another site", async () => {
    await showPicker("p5", [{ username: "ana", site: "other.example" }]);
    await pressKey("Enter", "Enter", 13);
    await settle();
    assert.deepEqual(await messages(), []);
    await pressKey("Enter", "Enter", 13);
    await waitFor(messages, (list) => list.length > 0);
    assert.deepEqual(await parsedMessages(), [
      { type: "apple-passwords-pick", nonce: "p5", username: "ana", site: "other.example", confirmed: true },
    ]);
  });

  it("fills a login for this site without asking", async () => {
    await showPicker("p6", [{ username: "ana", site: "127.0.0.1" }]);
    await pressKey("Enter", "Enter", 13);
    await waitFor(messages, (list) => list.length > 0);
    assert.deepEqual(await parsedMessages(), [
      { type: "apple-passwords-pick", nonce: "p6", username: "ana", site: "127.0.0.1", confirmed: false },
    ]);
  });

  it("sends typed searches and shows the results it gets back", async () => {
    await showPicker("p7", []);
    await send("Input.insertText", { text: "git" });
    await waitFor(messages, (list) => list.length > 0);
    assert.deepEqual(await parsedMessages(), [{ type: "apple-passwords-search", nonce: "p7", query: "git" }]);
    assert.equal(
      await isolated(buildResultsExpression("p7", [{ username: "octo", site: "github.com" }], null)),
      true,
    );
    assert.equal(await isolated(buildResultsExpression("other", [], null)), false);
    await isolated("(globalThis.__messages = [], null)");
    await pressKey("Tab", "Tab", 9);
    await pressKey("Enter", "Enter", 13);
    await settle();
    assert.deepEqual(await messages(), []);
    await pressKey("Enter", "Enter", 13);
    await waitFor(messages, (list) => list.length > 0);
    assert.deepEqual(await parsedMessages(), [
      { type: "apple-passwords-pick", nonce: "p7", username: "octo", site: "github.com", confirmed: true },
    ]);
  });

  it("matches a site to its subdomains only", () => {
    assert.equal(isSameSite("example.com", "accounts.example.com"), true);
    assert.equal(isSameSite("accounts.example.com", "example.com"), true);
    assert.equal(isSameSite("example.com", "badexample.com"), false);
  });
});
