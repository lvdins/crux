// Playlist: which Wild scene a terminal shows right now.
// Timed playlists switch on wall-clock boundaries (every 1/5/15/60 min), so all
// terminals agree; "session" picks one per terminal, stable for its lifetime.

import type { Playlist, WildId } from "../appearance";
import { rng } from "./scenes";

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic shuffle of `ids` for one cycle (seeded, so every terminal gets the same order). */
function shuffled(ids: WildId[], seed: number): WildId[] {
  const r = rng(seed);
  const out = [...ids];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// In-order per-session picks: terminals take the next id in turn, remembered
// so a re-mount (tab switch) keeps the same one.
const sessionPick = new Map<string, number>();
let sessionSeq = 0;

export interface PlaylistPick {
  id: WildId;
  /** ms until the pick changes (Infinity for per-session). */
  nextChangeIn: number;
}

export function pickWild(p: Playlist, termId: string, now = Date.now()): PlaylistPick | null {
  const ids = p.ids.filter(Boolean);
  if (!ids.length) return null;
  if (p.every === "session") {
    if (p.order === "shuffle") return { id: ids[hash(termId) % ids.length], nextChangeIn: Infinity };
    let n = sessionPick.get(termId);
    if (n === undefined) sessionPick.set(termId, (n = sessionSeq++));
    return { id: ids[n % ids.length], nextChangeIn: Infinity };
  }
  const period = p.every * 60_000;
  const cycle = Math.floor(now / period);
  const nextChangeIn = period - (now % period);
  if (p.order === "in-order") return { id: ids[cycle % ids.length], nextChangeIn };
  // Shuffle: a fresh order per full round, indexed within the round.
  const round = Math.floor(cycle / ids.length);
  return { id: shuffled(ids, round + 1)[cycle % ids.length], nextChangeIn };
}
