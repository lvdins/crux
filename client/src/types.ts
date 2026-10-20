import type { Appearance } from "./appearance";

export interface RepoInfo {
  label: string;
  kind: string;
  path: string;
  pinned?: boolean;
  color?: string;
}

export interface AppConfig {
  repos: Record<string, RepoInfo>;
  user?: string;
  onboarded?: boolean;
  userName?: string;
  settings?: Settings;
  /** The in-app browser needs macOS's WebKit; off (and hidden) on Linux and Windows. */
  browserSupported?: boolean;
}

export interface TestCase {
  title: string;
  line: number;
}

export interface TestFile {
  path: string;
  describe?: string;
  tests: TestCase[];
  endpoints: string[];
}

export interface RepoTree {
  key: string;
  label: string;
  kind: string;
  files: TestFile[];
  error?: string;
}

export interface TreeResponse {
  trees: RepoTree[];
  shared: { endpoint: string; repos: Record<string, string[]> }[];
  descriptions?: Record<string, Record<string, string>>;
}

/** Which parts of Crux are on (Settings). A mode is a preset of toggles. */
export interface Settings {
  mode: "qa" | "regular";
  // workspace panel tabs
  docPreview: boolean;
  tests: boolean;
  coverage: boolean;
  pipelines: boolean;
  browser: boolean;
  network: boolean;
  picker: boolean;
  // sidebar views (and the Connections view's own tabs)
  connections: boolean;
  connCoverage: boolean;
  connGraph: boolean;
  jira: boolean;
  /** Lab account switcher: the account pill on the browser + Settings → Lab accounts. */
  labAccounts: boolean;
  // chats and notifications (not part of a mode)
  defaultChat: "pick" | "claude" | "codex" | "shell";
  askChatName: boolean;
  confirmClose: boolean;
  notifyAgent: boolean;
  notifyPipeline: boolean;
  keepRunning: boolean;
  quickAsk: boolean;
  openHome: boolean;
  /** The session tab bar lists every workspace's chats (off: this workspace's). */
  tabsAll: boolean;
  /** Sidebar → Sessions (past sessions of every workspace). */
  sessionsView: boolean;
  /** Jira project key bugs are filed in (blank: the agent asks). */
  jiraProject: string;
  /** Settings → Appearance. Absent: Crux's own look (DEFAULT_APPEARANCE). */
  appearance?: Appearance;
}

export const QA_SETTINGS: Settings = {
  mode: "qa",
  docPreview: true, tests: true, coverage: true, pipelines: true, browser: true, network: true, picker: true,
  connections: true, connCoverage: true, connGraph: true, jira: true, labAccounts: true,
  defaultChat: "pick", askChatName: true, confirmClose: true, notifyAgent: true, notifyPipeline: true, keepRunning: true, quickAsk: true, openHome: true, tabsAll: true, sessionsView: true, jiraProject: "",
};
