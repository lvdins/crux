export interface RepoInfo {
  label: string;
  kind: string;
  path: string;
  pinned?: boolean;
}

export interface AppConfig {
  repos: Record<string, RepoInfo>;
  user?: string;
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
