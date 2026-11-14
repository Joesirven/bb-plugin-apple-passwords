import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CONFIG_PATH, DEFAULT_PORT, parseConfig, runCompanion, SUPPORT_DIR } from "./main.ts";
import { compileTouchIdTool } from "./touchid.ts";

const LABEL = "app.getbb.apple-passwords-companion";
const PLIST_PATH = join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
const APP_DIR = join(SUPPORT_DIR, "app");
const LOG_PATH = join(homedir(), "Library/Logs/bb-apple-passwords.log");
const run = promisify(execFile);

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function bbServerOrigins(): Promise<string[]> {
  const path = join(homedir(), "Library/Application Support/bb/server-target.json");
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(await readFile(path, "utf8")) as { customServerUrl?: unknown; customServerUrls?: unknown };
  const urls = [parsed.customServerUrl, ...(Array.isArray(parsed.customServerUrls) ? parsed.customServerUrls : [])];
  return urls.filter((url): url is string => typeof url === "string").map((url) => new URL(url).origin);
}

function optionValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === name && args[index + 1]) values.push(args[index + 1] as string);
  }
  return values;
}

async function install(args: string[]): Promise<void> {
  if (Number(process.versions.node.split(".")[0]) < 23) {
    throw new Error(`The companion needs Node 23.6 or later. This is Node ${process.versions.node}.`);
  }
  const sourceDir = dirname(fileURLToPath(import.meta.url));
  await mkdir(join(SUPPORT_DIR, "bin"), { recursive: true, mode: 0o700 });
  await rm(APP_DIR, { recursive: true, force: true });
  await mkdir(APP_DIR, { recursive: true, mode: 0o700 });
  for (const name of await readdir(sourceDir)) {
    if (name.endsWith(".ts") && !name.endsWith(".test.ts")) await copyFile(join(sourceDir, name), join(APP_DIR, name));
  }
  await writeFile(join(APP_DIR, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
  process.stdout.write("Compiling the Touch ID tool...\n");
  await compileTouchIdTool(join(sourceDir, "touchid.swift"), join(SUPPORT_DIR, "bin/touchid"));

  const previous = parseConfig(existsSync(CONFIG_PATH) ? JSON.parse(await readFile(CONFIG_PATH, "utf8")) : {});
  const extraOrigins = optionValues(args, "--origin").map((origin) => new URL(origin).origin);
  const origins = [...new Set([...previous.allowedOrigins, ...(await bbServerOrigins()), ...extraOrigins])];
  const portOption = optionValues(args, "--port")[0];
  const config = {
    port: portOption ? Number(portOption) : previous.port || DEFAULT_PORT,
    allowedOrigins: origins,
    chromePath: optionValues(args, "--chrome")[0] ?? previous.chromePath,
    biometricsOnly: args.includes("--biometrics-only") || previous.biometricsOnly,
  };
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(join(APP_DIR, "cli.ts"))}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xmlEscape(LOG_PATH)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(LOG_PATH)}</string>
</dict>
</plist>
`;
  await mkdir(dirname(PLIST_PATH), { recursive: true });
  const domain = `gui/${process.getuid?.() ?? 501}`;
  await stopService(domain);
  await writeFile(PLIST_PATH, plist);
  await run("launchctl", ["bootstrap", domain, PLIST_PATH]);
  process.stdout.write(
    `Installed. The companion runs at login on http://127.0.0.1:${config.port}.\nAllowed bb origins: ${origins.join(", ") || "none (add one with --origin)"}\nLog: ${LOG_PATH}\n`,
  );
}

async function stopService(domain: string): Promise<void> {
  await run("launchctl", ["bootout", `${domain}/${LABEL}`]).catch(() => undefined);
  for (let attempt = 0; attempt < 50; attempt++) {
    const loaded = await run("launchctl", ["print", `${domain}/${LABEL}`]).then(
      () => true,
      () => false,
    );
    if (!loaded) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("The old companion service did not stop. Run the command again.");
}

async function uninstall(): Promise<void> {
  const domain = `gui/${process.getuid?.() ?? 501}`;
  await stopService(domain);
  await rm(PLIST_PATH, { force: true });
  await rm(APP_DIR, { recursive: true, force: true });
  await rm(join(SUPPORT_DIR, "bin"), { recursive: true, force: true });
  await rm(join(SUPPORT_DIR, "chrome-profile"), { recursive: true, force: true });
  await rm(join(SUPPORT_DIR, "extension"), { recursive: true, force: true });
  await rm(join(SUPPORT_DIR, "tokens.json"), { force: true });
  process.stdout.write(`Uninstalled. The config file stays at ${CONFIG_PATH}.\n`);
}

async function status(): Promise<void> {
  const config = parseConfig(existsSync(CONFIG_PATH) ? JSON.parse(await readFile(CONFIG_PATH, "utf8")) : {});
  process.stdout.write(`Allowed bb origins: ${config.allowedOrigins.join(", ") || "none"}\n`);
  const response = await fetch(`http://127.0.0.1:${config.port}/v1/status`).catch(() => null);
  if (!response) {
    process.stdout.write("The companion is not running.\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(await response.json(), null, 2)}\n`);
}

const [command = "help", ...rest] = process.argv.slice(2);
const commands: Record<string, () => Promise<void>> = {
  run: runCompanion,
  install: () => install(rest),
  uninstall,
  status,
};
const selected = commands[command];
if (!selected) {
  process.stdout.write(
    "Usage: node companion/cli.ts <install|uninstall|status|run> [--origin https://your-bb-server] [--port 47823] [--chrome /path/to/chrome] [--biometrics-only]\n",
  );
  process.exitCode = command === "help" ? 0 : 1;
} else {
  selected().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
