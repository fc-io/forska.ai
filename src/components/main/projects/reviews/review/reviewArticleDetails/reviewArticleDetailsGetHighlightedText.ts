// reviewArticleDetailsGetHighlightedText.ts

export type Piece = [string, boolean]

export interface HighlightOptions {
  /** Max Damerau–Levenshtein distance allowed for a match. Defaults to 0 (exact-only). */
  maxDistance?: number
  /** Case-insensitive matching when true. Defaults to false. */
  caseInsensitive?: boolean
  /** Minimum key length to allow fuzzy (distance>0) matching. Defaults to 2 to avoid noisy 1-char matches. */
  minFuzzyKeyLength?: number
}

export function reviewArticleDetailsGetHighlightedText(
  s: string,
  keys: string[],
  opts: HighlightOptions = {},
): Piece[] {
  if (!s) return []

  const maxDistance = opts.maxDistance ?? 0
  const caseInsensitive = !!opts.caseInsensitive
  const minFuzzyKeyLength = opts.minFuzzyKeyLength ?? 2

  const norm = (t: string) => {
    return caseInsensitive ? t.toLowerCase() : t
  }
  const sN = norm(s)
  const keysN = keys.map(norm)

  // Damerau–Levenshtein (OSA) with early-exit band
  function dlOSA(a: string, b: string, limit: number): number {
    const n = a.length,
      m = b.length
    if (Math.abs(n - m) > limit) return limit + 1
    if (n === 0) return Math.min(m, limit + 1)
    if (m === 0) return Math.min(n, limit + 1)

    const dp: number[][] = Array.from({length: n + 1}, () => {
      return new Array(m + 1).fill(0)
    })
    for (let i = 0; i <= n; i++) dp[i][0] = i
    for (let j = 0; j <= m; j++) dp[0][j] = j

    for (let i = 1; i <= n; i++) {
      let rowMin = Infinity
      const ai = a.charCodeAt(i - 1)
      for (let j = 1; j <= m; j++) {
        const cost = ai === b.charCodeAt(j - 1) ? 0 : 1
        let v = Math.min(
          dp[i - 1][j] + 1, // deletion
          dp[i][j - 1] + 1, // insertion
          dp[i - 1][j - 1] + cost, // substitution
        )
        if (
          i > 1
          && j > 1
          && a.charCodeAt(i - 1) === b.charCodeAt(j - 2)
          && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)
        ) {
          v = Math.min(v, dp[i - 2][j - 2] + 1) // transposition
        }
        dp[i][j] = v
        if (v < rowMin) rowMin = v
      }
      if (rowMin > limit) return limit + 1
    }
    return dp[n][m]
  }

  // Best fuzzy substring match for a key in s, starting search from `fromIdx`.
  function bestMatchFrom(
    keyRaw: string,
    keyN: string,
    fromIdx: number,
  ): null | {start: number; end: number; dist: number} {
    if (!keyN) return null

    // 1) exact search first (fast path)
    const exactIdx = sN.indexOf(keyN, fromIdx)
    let best: null | {start: number; end: number; dist: number} = null
    if (exactIdx >= 0) {
      best = {start: exactIdx, end: exactIdx + keyN.length, dist: 0}
      // Do not early-return; we still check if another exact starts earlier than other keys
    }

    // 2) fuzzy search if allowed
    const allowFuzzy = maxDistance > 0 && keyN.length >= minFuzzyKeyLength
    if (!allowFuzzy) return best

    const L = keyN.length
    const minLen = Math.max(1, L - maxDistance)
    const maxLen = Math.min(s.length, L + maxDistance)

    // Slide windows starting from fromIdx
    for (let start = fromIdx; start < s.length; start++) {
      // quick bound: if remaining chars < minLen - we can still match shorter because distance can delete?
      // We already bounded window lengths; just break when start+minLen exceeds s length
      if (start + minLen > s.length) break

      for (let len = minLen; len <= maxLen; len++) {
        const end = start + len
        if (end > s.length) break
        const sub = sN.slice(start, end)
        const d = dlOSA(keyN, sub, maxDistance)
        if (d <= maxDistance) {
          const cand = {start, end, dist: d}
          if (
            !best
            || cand.start < best.start // earlier start
            || (cand.start === best.start && cand.dist < best.dist) // smaller distance
            || (cand.start === best.start
              && cand.dist === best.dist
              && end - start > best.end - best.start) // longer span
            || (cand.start === best.start
              && cand.dist === best.dist
              && end - start === best.end - best.start
              && keyN.length > best.end - best.start) // longer key
          ) {
            best = cand
          }
        }
      }
    }
    return best
  }

  const used = new Array(keys.length).fill(false)
  const pieces: Piece[] = []
  let idx = 0

  const push = (text: string, hit: boolean) => {
    if (!text) return
    const last = pieces[pieces.length - 1]
    if (last && last[1] === hit) {
      last[0] += text
    } else {
      pieces.push([text, hit])
    }
  }

  while (idx < s.length) {
    // find the next match among remaining keys, starting from idx
    let bestGlobal: null | {
      keyIdx: number
      start: number
      end: number
      dist: number
    } = null

    for (let k = 0; k < keys.length; k++) {
      if (used[k]) continue
      const keyN = keysN[k]
      const match = bestMatchFrom(keys[k], keyN, idx)
      if (!match) continue
      const cand = {keyIdx: k, ...match}
      if (
        !bestGlobal
        || cand.start < bestGlobal.start
        || (cand.start === bestGlobal.start && cand.dist < bestGlobal.dist)
        || (cand.start === bestGlobal.start
          && cand.dist === bestGlobal.dist
          && cand.end - cand.start > bestGlobal.end - bestGlobal.start)
        || (cand.start === bestGlobal.start
          && cand.dist === bestGlobal.dist
          && cand.end - cand.start === bestGlobal.end - bestGlobal.start
          && keys[k].length > keys[bestGlobal.keyIdx].length)
      ) {
        bestGlobal = cand
      }
    }

    if (!bestGlobal) {
      push(s.slice(idx), false)
      break
    }

    // emit non-hit then the hit (preserve original text in the hit)
    if (bestGlobal.start > idx) push(s.slice(idx, bestGlobal.start), false)
    push(s.slice(bestGlobal.start, bestGlobal.end), true)
    used[bestGlobal.keyIdx] = true
    idx = bestGlobal.end
  }

  return pieces
}
