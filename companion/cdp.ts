import type { Readable, Writable } from "node:stream";

type JsonObject = Record<string, unknown>;

interface PendingCall {
  resolve: (value: JsonObject) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface CdpEvent {
  method: string;
  params: JsonObject;
  sessionId: string | undefined;
}

export class CdpError extends Error {}

export class CdpPipe {
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, PendingCall>();
  private readonly listeners = new Set<(event: CdpEvent) => void>();
  private closedError: Error | null = null;
  private readonly output: Writable;

  constructor(input: Readable, output: Writable) {
    this.output = output;
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => this.receive(chunk));
    input.on("close", () => this.close(new CdpError("Chrome closed the debugging pipe")));
    output.on("error", (error: Error) => this.close(error));
  }

  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(
    method: string,
    params: JsonObject = {},
    options: { sessionId?: string; timeoutMs?: number } = {},
  ): Promise<JsonObject> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const message: JsonObject = { id, method, params };
      if (options.sessionId !== undefined) message.sessionId = options.sessionId;
      this.output.write(`${JSON.stringify(message)}\0`);
    });
  }

  close(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let end = this.buffer.indexOf("\0");
    while (end >= 0) {
      const raw = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      this.dispatch(raw);
      end = this.buffer.indexOf("\0");
    }
  }

  private dispatch(raw: string): void {
    let message: JsonObject;
    try {
      message = JSON.parse(raw) as JsonObject;
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const call = this.pending.get(message.id);
      if (!call) return;
      this.pending.delete(message.id);
      clearTimeout(call.timer);
      const error = message.error as { message?: string } | undefined;
      if (error) call.reject(new CdpError(error.message ?? "Chrome DevTools error"));
      else call.resolve((message.result as JsonObject | undefined) ?? {});
      return;
    }
    if (typeof message.method === "string") {
      const event: CdpEvent = {
        method: message.method,
        params: (message.params as JsonObject | undefined) ?? {},
        sessionId: typeof message.sessionId === "string" ? message.sessionId : undefined,
      };
      for (const listener of this.listeners) listener(event);
    }
  }
}

export interface EvaluateResult {
  value: unknown;
}

export async function evaluate(
  cdp: CdpPipe,
  sessionId: string,
  expression: string,
  timeoutMs = 30_000,
): Promise<unknown> {
  const result = await cdp.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    { sessionId, timeoutMs },
  );
  const exception = result.exceptionDetails as
    | { exception?: { description?: string; value?: unknown }; text?: string }
    | undefined;
  if (exception) {
    const detail =
      exception.exception?.description ??
      (typeof exception.exception?.value === "string" ? exception.exception.value : undefined) ??
      exception.text ??
      "Evaluation failed";
    throw new CdpError(detail.split("\n")[0] ?? detail);
  }
  const remote = result.result as { value?: unknown } | undefined;
  return remote?.value;
}
