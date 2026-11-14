import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

export type UserCheckResult = "approved" | "denied" | "unavailable";

export type UserCheck = (reason: string) => Promise<UserCheckResult>;

export async function compileTouchIdTool(source: string, output: string): Promise<void> {
  await promisify(execFile)(
    "xcrun",
    ["swiftc", "-swift-version", "5", "-O", "-framework", "LocalAuthentication", source, "-o", output],
    { timeout: 300_000 },
  );
}

function runTouchId(binary: string, args: string[]): Promise<UserCheckResult> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { stdio: "ignore" });
    const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
    child.on("error", () => resolve("unavailable"));
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? "approved" : code === 2 ? "unavailable" : "denied");
    });
  });
}

export function createTouchIdCheck(binary: string, biometricsOnly: boolean): UserCheck {
  let queue: Promise<unknown> = Promise.resolve();
  return (reason) => {
    if (!existsSync(binary)) return Promise.resolve("unavailable");
    const args = biometricsOnly ? ["--biometrics-only", reason] : [reason];
    const next = queue.then(() => runTouchId(binary, args));
    queue = next;
    return next;
  };
}
