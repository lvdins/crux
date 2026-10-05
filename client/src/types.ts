export interface RepoInfo {
  label: string;
  kind: string;
  path: string;
}

export interface AppConfig {
  repos: Record<string, RepoInfo>;
  preview: { port: number };
}

export type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "agent"; text: string; streaming: boolean }
  | { kind: "tool"; name: string }
  | { kind: "error"; text: string }
  | { kind: "meta"; text: string };

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
}
