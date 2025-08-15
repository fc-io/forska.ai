// reviewArticleDetailsGetHighlightedText.ts

export type Piece = [string, boolean]

export interface HighlightOptions {
  /** Max Damerau–Levenshtein distance allowed for a match. Defaults to 0 (exact only). */
  maxDistance?: number
  /** Case-insensitive matching when true. Defaults to false. */
  caseInsensitive?: boolean
}

/**
 * Split `s` into [text, isHit] pieces using (fuzzy) literal substring matching with
 * per-token constraints:
 * - At most one match per *word-like token* (contiguous non-whitespace).
 * - At most one match per *key* across the entire string.
 * - When multiple keys could match inside the same token, pick:
 *   1) smaller Damerau–Levenshtein distance,
 *   2) then longer key length,
 *   3) then earliest start index.
 *
 * Default is exact matching (maxDistance=0) – so it passes the given tests.
 */
export const reviewArticleDetailsGetHighlightedText = (
  s: string,
  keys: string[],
  opts: HighlightOptions = {},
): Piece[] => {
  if (!s) return []

  const maxDistance = opts.maxDistance ?? 0
  const ci = !!opts.caseInsensitive

  const norm = (t: string) => {
    return ci ? t.toLowerCase() : t
  }

  const used = new Set<string>() // keys used (normalized)
  const normalizedKeys = keys.map(norm)

  // Split by whitespace, keep separators.
  const parts = s.split(/(\s+)/)

  const pieces: Piece[] = []
  const pushPiece = (text: string, isHit: boolean) => {
    if (!text) return
    const last = pieces[pieces.length - 1]
    if (last && last[1] === isHit) {
      last[0] += text
    } else {
      pieces.push([text, isHit])
    }
  }

  // Damerau–Levenshtein with early exit.
  // Optimal String Alignment variant (adjacent transpositions).
  const damerauLevenshtein = (a: string, b: string, limit: number): number => {
    const n = a.length
    const m = b.length
    if (Math.abs(n - m) > limit) return limit + 1 // quick fail
    if (n === 0) return Math.min(m, limit + 1)
    if (m === 0) return Math.min(n, limit + 1)

    const dp: number[][] = Array.from({length: n + 1}, () => {
      return new Array(m + 1).fill(0) as number[]
    })
    for (let i = 0; i <= n; i++) dp[i][0] = i
    for (let j = 0; j <= m; j++) dp[0][j] = j

    for (let i = 1; i <= n; i++) {
      let rowMin = Number.POSITIVE_INFINITY
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
      if (rowMin > limit) return limit + 1 // early exit band
    }
    return dp[n][m]
  }

  // Find the best fuzzy match of `key` inside `token` within maxDistance.
  // Returns {start, end, dist, matched} or null.
  const bestMatchInToken = (
    token: string,
    key: string,
  ): null | {start: number; end: number; dist: number; matched: string} => {
    if (!token || !key) return null

    const tokenN = norm(token)
    const keyN = key

    // Always prefer exact first
    const idxExact = tokenN.indexOf(keyN)
    if (idxExact >= 0) {
      return {
        start: idxExact,
        end: idxExact + keyN.length,
        dist: 0,
        matched: token.slice(idxExact, idxExact + key.length),
      }
    }

    // 🔧 Fix: block fuzzy matching for single-character keys – too noisy.
    if (maxDistance > 0 && keyN.length <= 1) {
      return null
    }

    // Fuzzy search windows...
    const L = keyN.length
    let best: ReturnType<typeof bestMatchInToken> = null

    const minLen = Math.max(1, L - maxDistance)
    const maxLen = Math.min(token.length, L + maxDistance)

    for (let start = 0; start < token.length; start++) {
      for (let len = minLen; len <= maxLen; len++) {
        const end = start + len
        if (end > token.length) break
        const sub = tokenN.slice(start, end)
        const d = damerauLevenshtein(keyN, sub, maxDistance)
        if (d <= maxDistance) {
          const candidate = {
            start,
            end,
            dist: d,
            matched: token.slice(start, end),
          }
          if (
            !best
            || candidate.dist < best.dist
            || (candidate.dist === best.dist
              && end - start > best.end - best.start)
            || (candidate.dist === best.dist
              && end - start === best.end - best.start
              && start < best.start)
          ) {
            best = candidate
          }
        }
      }
    }
    return best
  }

  // Process each part; only match inside non-whitespace tokens.
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i]
    const isSpace = i % 2 === 1

    if (isSpace) {
      pushPiece(seg, false)
      continue
    }

    if (!seg) continue

    // Choose a single best key for this token among *unused* keys.
    let best: null | {
      keyIdx: number
      keyRaw: string
      start: number
      end: number
      dist: number
      matched: string
    } = null

    for (let k = 0; k < normalizedKeys.length; k++) {
      const keyN = normalizedKeys[k]
      if (!keyN) continue
      if (used.has(keyN)) continue

      const m = bestMatchInToken(seg, keyN)
      if (!m) continue

      const candidate = {
        keyIdx: k,
        keyRaw: keys[k],
        start: m.start,
        end: m.end,
        dist: m.dist,
        matched: m.matched,
      }

      if (!best) {
        best = candidate
      } else {
        // Global tiebreakers across different keys
        if (
          candidate.dist < best.dist
          || (candidate.dist === best.dist
            && normalizedKeys[candidate.keyIdx].length
              > normalizedKeys[best.keyIdx].length)
          || (candidate.dist === best.dist
            && normalizedKeys[candidate.keyIdx].length
              === normalizedKeys[best.keyIdx].length
            && candidate.start < best.start)
        ) {
          best = candidate
        }
      }
    }

    if (!best) {
      pushPiece(seg, false)
    } else {
      // Mark key as used (normalized)
      used.add(normalizedKeys[best.keyIdx])

      // Emit token split into before / hit / after
      const before = seg.slice(0, best.start)
      const hit = seg.slice(best.start, best.end)
      const after = seg.slice(best.end)
      pushPiece(before, false)
      pushPiece(hit, true)
      pushPiece(after, false)
    }
  }

  return pieces
}
