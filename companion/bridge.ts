export const BRIDGE_GLOBAL = "__bbApplePasswordsBridge";

export const BRIDGE_SOURCE = String.raw`(() => {
  if (self.${BRIDGE_GLOBAL}) return "present";
  let attachedPort = null;
  let pending = null;
  const ensurePort = () => {
    if (!g_nativeAppPort) connectToBackgroundNativeAppAndSetUpListeners();
    if (g_nativeAppPort && attachedPort !== g_nativeAppPort) {
      attachedPort = g_nativeAppPort;
      attachedPort.onMessage.addListener(onNativeMessage);
    }
    return g_nativeAppPort;
  };
  const onNativeMessage = (message) => {
    if (!pending || !message || message.cmd !== pending.cmd) return;
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    try {
      let payload = message.payload;
      if (typeof payload === "string") payload = JSON.parse(payload);
      if (!payload || payload.SMSG === undefined) {
        current.resolve({ STATUS: typeof message.STATUS === "number" ? message.STATUS : 1 });
        return;
      }
      current.resolve(JSON.parse(g_secretSession.parseSMSG(payload.SMSG)));
    } catch (error) {
      current.reject(error);
    }
  };
  const waitForState = (accept, timeoutMs) =>
    new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        if (accept(g_theState) || Date.now() - started > timeoutMs) resolve(g_theState);
        else setTimeout(tick, 100);
      };
      tick();
    });
  self.${BRIDGE_GLOBAL} = {
    async state() {
      ensurePort();
      return waitForState((state) => state !== ContextState.CheckEngine, 5000);
    },
    async challenge() {
      ensurePort();
      await waitForState((state) => state !== ContextState.CheckEngine, 5000);
      if (g_theState === ContextState.SessionKeySet) return g_theState;
      if (g_theState !== ContextState.NotInSession) resetTheSession(ContextState.NotInSession);
      ChallengePIN();
      return waitForState(
        (state) => state === ContextState.MSG1Set || state === ContextState.NotInSession,
        10000,
      );
    },
    async verify(pin) {
      if (g_theState !== ContextState.MSG1Set) throw new Error("No Apple Passwords pairing is waiting for a code");
      PINSet(pin);
      return waitForState(
        (state) => state === ContextState.SessionKeySet || state === ContextState.NotInSession,
        10000,
      );
    },
    query(cmd, qid, url, body) {
      if (g_theState !== ContextState.SessionKeySet) return Promise.reject(new Error("unpaired"));
      if (pending) return Promise.reject(new Error("busy"));
      const port = ensurePort();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending = null;
          reject(new Error("Apple Passwords did not answer in time"));
        }, 30000);
        pending = { cmd, resolve, reject, timer };
        try {
          port.postMessage({
            cmd,
            tabId: 0,
            frameId: 0,
            url,
            payload: JSON.stringify({ QID: qid, SMSG: g_secretSession.createSMSG(JSON.stringify(body)) }),
          });
        } catch (error) {
          pending = null;
          clearTimeout(timer);
          reject(error);
        }
      });
    },
  };
  return "installed";
})()`;

export function bridgeCall(method: "state" | "challenge" | "verify" | "query", args: unknown[]): string {
  const encoded = args.map((value) => JSON.stringify(value)).join(", ");
  return `${BRIDGE_SOURCE};\nself.${BRIDGE_GLOBAL}.${method}(${encoded})`;
}
