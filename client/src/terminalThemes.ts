// STUB: replaced by worker C
import type { TermScheme } from "./appearance";

export const SCHEMES: Record<string, TermScheme> = {};

export function importScheme(_file: File): Promise<TermScheme> {
  throw new Error("importScheme: not implemented (stub)");
}
