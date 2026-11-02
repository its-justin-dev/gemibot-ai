/**
 * Mirrors `scrub()` in `tools/parity/dump-v1-fixtures.py` so a v2.0 run and the
 * captured v1.0 reference can be compared byte for byte despite wall-clock values
 * and the random temp directory each side writes into.
 */

const TS_RE = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g
const TIME_RE = /\d{2}:\d{2}:\d{2}/g
/**
 * The human-readable half of a memory timestamp (`%A, %B %d, %Y %I:%M:%S %p`).  `TS_RE` covers the
 * ISO part, but this segment still moves at midnight — the weekday, the day and the AM/PM marker
 * all change — so the whole run is frozen as one token.
 */
const DAY_RE =
  /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4} \d{2}:\d{2}:\d{2} (?:AM|PM)\b/g

export function scrub(text: string, base?: string): string {
  let clean = text.replace(TS_RE, '<TS>').replace(DAY_RE, '<DAYDATE>').replace(TIME_RE, '<TIME>')
  if (base !== undefined) {
    for (const variant of [base, base.replaceAll('\\', '/'), base.replaceAll('\\', '\\\\')]) {
      clean = clean.split(variant).join('<WS>')
    }
  }
  return clean
}
