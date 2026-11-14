import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AppleError, createApplePasswords, normalizeHostname, searchCandidates } from "./apple.ts";

function fakeExtension(reply: (method: string, args: unknown[]) => unknown) {
  const calls: { method: string; args: unknown[] }[] = [];
  const evaluate = async (expression: string) => {
    const match = /self\.__bbApplePasswordsBridge\.(\w+)\((.*)\)$/s.exec(expression);
    assert.ok(match, "every call goes through the bridge");
    const method = match[1] as string;
    const args = JSON.parse(`[${match[2]}]`) as unknown[];
    calls.push({ method, args });
    return reply(method, args);
  };
  return { calls, apple: createApplePasswords(evaluate) };
}

describe("Apple Passwords client", () => {
  it("maps Apple's context states", async () => {
    for (const [raw, expected] of [
      ["SessionKeySet", "paired"],
      ["MSG1Set", "awaiting-code"],
      ["NotInSession", "unpaired"],
      ["NativeSupportNotInstalled", "unavailable"],
      ["SomethingNew", "unavailable"],
    ] as const) {
      const { apple } = fakeExtension(() => raw);
      assert.equal(await apple.state(), expected);
    }
  });

  it("sends Apple's ghost search for user names and drops passwords", async () => {
    const { apple, calls } = fakeExtension(() => ({
      STATUS: 0,
      Entry_1: { USR: "ana@example.com", PWD: "fake-1", sites: ["example.com"] },
      Entry_0: { USR: "bo", PWD: "fake-2", sites: ["example.com"] },
      Entry_2: { USR: "ana@example.com", PWD: "fake-3", sites: ["www.example.com"] },
    }));
    const logins = await apple.logins("https://Example.com/login");
    assert.deepEqual(calls[0]?.args, [4, "CmdGetLoginNames4URL", "example.com", { ACT: 5, URL: "example.com" }]);
    assert.deepEqual(logins, [
      { username: "bo", sites: ["example.com"] },
      { username: "ana@example.com", sites: ["example.com"] },
    ]);
    assert.ok(!JSON.stringify(logins).includes("fake-"));
  });

  it("reads the Entries array form too", async () => {
    const { apple } = fakeExtension(() => ({ STATUS: 0, Entries: [{ USR: "ana", sites: [] }] }));
    assert.deepEqual(await apple.logins("example.com"), [{ username: "ana", sites: [] }]);
  });

  it("returns no logins when Apple reports no results", async () => {
    const { apple } = fakeExtension(() => ({ STATUS: 3 }));
    assert.deepEqual(await apple.logins("example.com"), []);
  });

  it("treats an invalid session as unpaired", async () => {
    const { apple } = fakeExtension(() => ({ STATUS: 9 }));
    await assert.rejects(apple.logins("example.com"), (error: unknown) => error instanceof AppleError && error.code === "unpaired");
  });

  it("maps a bridge rejection for a missing session to unpaired", async () => {
    const apple = createApplePasswords(async () => {
      throw new Error("unpaired");
    });
    await assert.rejects(apple.logins("example.com"), (error: unknown) => error instanceof AppleError && error.code === "unpaired");
  });

  it("asks for one password with Apple's search command and prefers the exact site", async () => {
    const { apple, calls } = fakeExtension(() => ({
      STATUS: 0,
      Entries: [
        { USR: "ana", PWD: "fake-other", sites: ["other.example.com"] },
        { USR: "ana", PWD: "fake-right", sites: ["example.com"] },
      ],
    }));
    const credential = await apple.password("example.com", "ana");
    assert.deepEqual(calls[0]?.args, [5, "CmdGetPassword4LoginName", "example.com", { ACT: 2, URL: "example.com", USR: "ana" }]);
    assert.deepEqual(credential, { username: "ana", password: "fake-right" });
  });

  it("returns null when the user name does not match", async () => {
    const { apple } = fakeExtension(() => ({ STATUS: 0, Entries: [{ USR: "bo", PWD: "fake", sites: ["example.com"] }] }));
    assert.equal(await apple.password("example.com", "ana"), null);
  });

  it("runs one request at a time", async () => {
    let active = 0;
    let maxActive = 0;
    const apple = createApplePasswords(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return { STATUS: 3 };
    });
    await Promise.all([apple.logins("a.example"), apple.logins("b.example"), apple.logins("c.example")]);
    assert.equal(maxActive, 1);
  });

  it("rejects a pairing code that is not six digits before it reaches Apple", async () => {
    const { apple, calls } = fakeExtension(() => "SessionKeySet");
    await assert.rejects(apple.verify("12345"));
    assert.equal(calls.length, 0);
  });

  it("normalizes host names and refuses other schemes", () => {
    assert.equal(normalizeHostname("https://Accounts.Example.com:8443/x"), "accounts.example.com");
    assert.equal(normalizeHostname("example.com"), "example.com");
    assert.throws(() => normalizeHostname("chrome-extension://abc/page.html"));
    assert.throws(() => normalizeHostname("file:///etc/hosts"));
  });

  it("sends only real host names to Apple's helper, which crashes on an empty search", () => {
    assert.deepEqual(searchCandidates("GitHub"), ["github.com"]);
    assert.deepEqual(searchCandidates("mail.example.org"), ["mail.example.org"]);
    assert.deepEqual(searchCandidates("https://Accounts.Example.com/x"), ["accounts.example.com"]);
    assert.deepEqual(searchCandidates(""), []);
    assert.deepEqual(searchCandidates("   "), []);
    assert.deepEqual(searchCandidates("two words"), []);
    assert.deepEqual(searchCandidates("*"), []);
  });

  it("searches by site and drops passwords", async () => {
    const { apple, calls } = fakeExtension((_method, args) =>
      args[2] === "github.com"
        ? { STATUS: 0, Entries: [{ USR: "ana", PWD: "fake-1", sites: ["github.com"] }, { USR: "bo", PWD: "fake-2", sites: ["gist.github.com"] }] }
        : { STATUS: 3 },
    );
    const results = await apple.search("github");
    assert.deepEqual(calls.map((call) => call.args[3]), [{ ACT: 5, URL: "github.com" }]);
    assert.deepEqual(results, [
      { username: "ana", sites: ["github.com"] },
      { username: "bo", sites: ["gist.github.com"] },
    ]);
    assert.ok(!JSON.stringify(results).includes("fake-"));
  });

  it("sends nothing to Apple for an empty search", async () => {
    const { apple, calls } = fakeExtension(() => ({ STATUS: 0, Entries: [] }));
    assert.deepEqual(await apple.search(""), []);
    assert.equal(calls.length, 0);
  });

  it("returns no results when Apple rejects a search, but reports an ended session", async () => {
    const rejected = fakeExtension(() => ({ STATUS: 1 }));
    assert.deepEqual(await rejected.apple.search("github"), []);
    const ended = fakeExtension(() => ({ STATUS: 9 }));
    await assert.rejects(ended.apple.search("github"), (error: unknown) => error instanceof AppleError && error.code === "unpaired");
  });
});
