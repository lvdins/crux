import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface RepoConfig {
  label: string;
  path: string;
  kind: "mkdocs" | "playwright" | "pytest";
}

export interface SuperQAConfig {
  repos: Record<string, RepoConfig>;
  agent: { permissionMode: "acceptEdits" | "default" | "bypassPermissions" };
  preview: { port: number };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(here, "../../superqa.config.json");

export function loadConfig(): SuperQAConfig {
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

export const config = loadConfig();
