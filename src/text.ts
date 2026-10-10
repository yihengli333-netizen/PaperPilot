/**
 * Quote matching shared by verification (parser) and coordinate lookup (geo).
 * Both sides must use the same canonical form or verified quotes fail to locate.
 */

const QUOTES: Record<string, string> = {
  "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'",
  "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"',
};
// Hyphens and dashes are dropped: "meth-\nod" (line-break hyphenation) and "state-of-the-art"
// must compare equal regardless of which side carries the hyphen.
const DROP = /[\s­‐‑‒–—―−-]/u;

function canonChar(ch: string): string {
  let out = "";
  for (const c of ch.normalize("NFKC")) {
    if (DROP.test(c)) continue;
    out += (QUOTES[c] ?? c).toLowerCase();
  }
  return out;
}

/**
 * Canonical form: NFKC per code point (ligatures), unified quotes, no whitespace/hyphens, lower case.
 * Applied per code point so a whole string and its character-by-character mapping always agree.
 */
export function canon(s: string): string {
  let out = "";
  for (const ch of s || "") out += canonChar(ch);
  return out;
}

/** Canonical string plus, for each canonical char, the index of the source char it came from. */
export function canonWithMap(s: string): { text: string; map: number[] } {
  let text = "";
  const map: number[] = [];
  let i = 0;
  for (const ch of s) {
    const unit = canonChar(ch);
    text += unit;
    for (let k = 0; k < unit.length; k++) map.push(i);
    i += ch.length;
  }
  return { text, map };
}

/** Minimum similarity for a fuzzy match, and minimum canonical length before fuzzy matching is attempted. */
export const FUZZY_MIN_SIMILARITY = 0.9;
export const FUZZY_MIN_LENGTH = 20;

/**
 * Edit distance of `needle` against the best-matching substring of `hay` (Sellers algorithm).
 * Returns the distance and the end index (exclusive) of that substring in `hay`.
 */
function bestSubstring(hay: string, needle: string): { dist: number; end: number } {
  const m = needle.length;
  let prev = new Array<number>(m + 1);
  let cur = new Array<number>(m + 1);
  for (let i = 0; i <= m; i++) prev[i] = i;
  let best = { dist: m, end: 0 };
  for (let j = 1; j <= hay.length; j++) {
    cur[0] = 0;
    const hc = hay[j - 1];
    for (let i = 1; i <= m; i++) {
      const sub = prev[i - 1] + (needle[i - 1] === hc ? 0 : 1);
      cur[i] = Math.min(sub, prev[i] + 1, cur[i - 1] + 1);
    }
    if (cur[m] < best.dist) best = { dist: cur[m], end: j };
    [prev, cur] = [cur, prev];
  }
  return best;
}

/** Start index of the best substring ending at `end` (reverse pass over the reversed strings). */
function bestStart(hay: string, needle: string, end: number): number {
  const window = hay.slice(Math.max(0, end - needle.length * 2), end);
  const r = bestSubstring([...window].reverse().join(""), [...needle].reverse().join(""));
  return end - r.end;
}

export interface QuoteMatch {
  /** The quote as it appears in the source text (whitespace collapsed). */
  text: string;
  exact: boolean;
  similarity: number;
}

/**
 * Find `quote` in `source`. Exact canonical match first; otherwise a fuzzy match that tolerates small
 * wording differences, accepted only at >= FUZZY_MIN_SIMILARITY. The returned text is always the
 * original source span, never the model's wording, so later coordinate lookup matches real characters.
 */
export function matchQuote(source: string, quote: string): QuoteMatch | null {
  const needle = canon(quote);
  if (needle.length < 6) return null;
  const hay = canonWithMap(source);
  const span = (start: number, end: number) => {
    const last = hay.map[end - 1];
    const stop = last + ((source.codePointAt(last) ?? 0) > 0xffff ? 2 : 1);
    return source.slice(hay.map[start], stop).replace(/\s+/g, " ").trim();
  };

  const at = hay.text.indexOf(needle);
  if (at >= 0) return { text: span(at, at + needle.length), exact: true, similarity: 1 };
  if (needle.length < FUZZY_MIN_LENGTH) return null;

  // Anchor on 8-char grams to find candidate regions; full edit distance runs only inside them.
  const gram = 8;
  const votes = new Map<number, number>();
  for (let i = 0; i + gram <= needle.length; i += 4) {
    const g = needle.slice(i, i + gram);
    let from = 0;
    let hits = 0;
    while (hits < 50) {
      const p = hay.text.indexOf(g, from);
      if (p < 0) break;
      const bucket = Math.round((p - i) / 16);
      votes.set(bucket, (votes.get(bucket) || 0) + 1);
      from = p + 1;
      hits++;
    }
  }
  const candidates = [...votes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  let best: { dist: number; start: number; end: number } | null = null;
  const slack = Math.ceil(needle.length * 0.2) + 16;
  for (const [bucket] of candidates) {
    const lo = Math.max(0, bucket * 16 - slack);
    const hi = Math.min(hay.text.length, bucket * 16 + needle.length + slack);
    const region = hay.text.slice(lo, hi);
    const r = bestSubstring(region, needle);
    if (!best || r.dist < best.dist) {
      best = { dist: r.dist, start: lo + bestStart(region, needle, r.end), end: lo + r.end };
    }
  }
  if (!best || best.end <= best.start) return null;
  const similarity = 1 - best.dist / needle.length;
  if (similarity < FUZZY_MIN_SIMILARITY) return null;
  return { text: span(best.start, best.end), exact: false, similarity };
}
