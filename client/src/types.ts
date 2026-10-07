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
  browser: boolean;
  network: boolean;
  picker: boolean;
  qaPanels: boolean;
  connections: boolean;
  jira: boolean;
}

export const QA_SETTINGS: Settings = {
  mode: "qa", browser: true, network: true, picker: true, qaPanels: true, connections: true, jira: true,
};
