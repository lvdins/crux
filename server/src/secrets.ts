import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CRUX_HOME } from "./paths.js";

/**
 * Credentials for lab fixtures and API tokens, in the macOS login Keychain
 * (service "crux.<name>", account "crux"). Values never touch Crux's own
 * files or logs: CRUX_HOME/secret-names.json lists only the names you set,
 * so Settings can show "set" / "not set" without reading anything back.
 */

const SECURITY = "/usr/bin/security";
const ACCOUNT = "crux";
const NAMES_FILE = path.join(CRUX_HOME, "secret-names.json");

export const SECRET_NAME = /^[\w.-]{1,64}$/;
export const secretsSupported = () => process.platform === "darwin";

function check(name: string) {
  if (!secretsSupported()) throw new Error("Secrets use the macOS Keychain: not supported on this platform");
  if (!SECRET_NAME.test(name)) throw new Error("Secret names are letters, digits, '.', '_' or '-' (up to 64)");
}

/** `security …` without a shell. Errors never carry the arguments (a value may be one). */
function security(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(SECURITY, args, { timeout: 30_000 }, (err, out) => {
      if (err) reject(Object.assign(new Error(`security ${args[0]} failed`), { code: (err as { code?: unknown }).code }));
      else resolve(String(out));
    });
  });
}

function readNames(): string[] {
  try {
    const list = JSON.parse(fs.readFileSync(NAMES_FILE, "utf8"));
    return Array.isArray(list) ? list.filter((n) => typeof n === "string" && SECRET_NAME.test(n)) : [];
  } catch {
    return [];
  }
}

function writeNames(names: string[]) {
  fs.mkdirSync(CRUX_HOME, { recursive: true });
  fs.writeFileSync(NAMES_FILE, JSON.stringify([...new Set(names)].sort(), null, 2) + "\n", { mode: 0o600 });
}

export async function getSecret(name: string): Promise<string | null> {
  check(name);
  try {
    // -w prints the password only; trailing newline is security's own.
    return (await security(["find-generic-password", "-s", `crux.${name}`, "-a", ACCOUNT, "-w"])).replace(/\n$/, "");
  } catch {
    return null;
  }
}

/** Whether the Keychain holds it (attributes only: the value isn't read). */
export async function hasSecret(name: string): Promise<boolean> {
  check(name);
  try {
    await security(["find-generic-password", "-s", `crux.${name}`, "-a", ACCOUNT]);
    return true;
  } catch {
    return false;
  }
}

export async function setSecret(name: string, value: string): Promise<void> {
  check(name);
  if (typeof value !== "string" || !value || value.length > 8192 || /[\r\n\0]/.test(value)) throw new Error("Give a one-line value (up to 8192 characters)");
  // -U updates an existing item instead of failing.
  await security(["add-generic-password", "-U", "-s", `crux.${name}`, "-a", ACCOUNT, "-w", value]);
  writeNames([...readNames(), name]);
}

export async function deleteSecret(name: string): Promise<void> {
  check(name);
  try {
    await security(["delete-generic-password", "-s", `crux.${name}`, "-a", ACCOUNT]);
  } catch {
    /* already gone */
  }
  writeNames(readNames().filter((n) => n !== name));
}

/** Names Crux knows of (set here, or used by a fixture), and whether each is set. */
export async function listSecrets(extra: string[] = []): Promise<{ name: string; set: boolean }[]> {
  if (!secretsSupported()) throw new Error("Secrets use the macOS Keychain: not supported on this platform");
  const names = [...new Set([...readNames(), ...extra.filter((n) => SECRET_NAME.test(n))])].sort();
  return Promise.all(names.map(async (name) => ({ name, set: await hasSecret(name) })));
}
