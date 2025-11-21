// reviewArticleDetailsGetHighlightedText.ts

export type Piece = [string, boolean]

export interface HighlightOptions {
  /** Max Damerau–Levenshtein distance allowed for a match. Defaults to 0 (exact-only). */
  maxDistance?: number
  /** Case-insensitive matching when true. Defaults to false. */
  caseInsensitive?: boolean
  /** Minimum key length to allow fuzzy (distance>0) matching. Defaults to 2 to avoid noisy 1-char matches. */
  minFuzzyKeyLength?: number
  /** Max start offset window for fuzzy scanning; 'auto' adapts to text/key length. Defaults to 100. */
  fuzzyScanLimit?: number | 'auto'
}

export const reviewArticleDetailsGetHighlightedText = (
  s: string,
  keys: string[],
  opts: HighlightOptions = {},
): Piece[] => {
  if (!s) return []

  const maxDistance = opts.maxDistance ?? 0
  const caseInsensitive = !!opts.caseInsensitive
  const minFuzzyKeyLength = opts.minFuzzyKeyLength ?? 2
  const fuzzyScanLimitOpt = opts.fuzzyScanLimit

  const norm = (t: string) => {
    return caseInsensitive ? t.toLowerCase() : t
  }

  const keysN = keys.map(norm)
  const used = new Array(keys.length).fill(false)
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

  // Damerau–Levenshtein (OSA) with early-exit band
  const dlOSA = (a: string, b: string, limit: number): number => {
    const n = a.length,
      m = b.length
    if (Math.abs(n - m) > limit) return limit + 1
    if (n === 0) return Math.min(m, limit + 1)
    if (m === 0) return Math.min(n, limit + 1)

    const dp: number[][] = Array.from({length: n + 1}, () => {
      return new Array(m + 1).fill(0)
    })
    for (let i = 0; i <= n; i++) dp[i]![0] = i
    for (let j = 0; j <= m; j++) dp[0]![j] = j

    for (let i = 1; i <= n; i++) {
      let rowMin = Infinity
      const ai = a.charCodeAt(i - 1)
      for (let j = 1; j <= m; j++) {
        const cost = ai === b.charCodeAt(j - 1) ? 0 : 1
        let v = Math.min(
          dp[i - 1]![j]! + 1, // deletion
          dp[i]![j - 1]! + 1, // insertion
          dp[i - 1]![j - 1]! + cost, // substitution
        )
        if (
          i > 1
          && j > 1
          && a.charCodeAt(i - 1) === b.charCodeAt(j - 2)
          && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)
        ) {
          v = Math.min(v, dp[i - 2]![j - 2]! + 1) // transposition
        }
        dp[i]![j] = v
        if (v < rowMin) rowMin = v
      }
      if (rowMin > limit) return limit + 1
    }
    return dp[n]![m]!
  }

  // Process the string globally
  let idx = 0

  while (idx < s.length) {
    // Find the best match among unused keys starting from idx
    let bestMatch: null | {keyIdx: number; start: number; end: number; dist: number} = null

    for (let k = 0; k < keys.length; k++) {
      if (used[k]) continue

      const keyN = keysN[k]!
      const keyRaw = keys[k]!

      // Try exact match first
      const sN = norm(s)
      const exactIdx = sN.indexOf(keyN, idx)

      if (exactIdx >= 0) {
        const candidate = {keyIdx: k, start: exactIdx, end: exactIdx + keyRaw.length, dist: 0}

        if (
          !bestMatch
          || candidate.start < bestMatch.start
          || (candidate.start === bestMatch.start && keyRaw.length > keys[bestMatch.keyIdx]!.length)
        ) {
          bestMatch = candidate
        }
      } else {
        // Tag-agnostic regex pre-pass: allow HTML tags/entities/whitespace between tokens
        const rx = buildTagAgnosticRegex(keyRaw, caseInsensitive)
        if (rx) {
          const slice = s.slice(idx)
          const m = rx.exec(slice)
          if (m && typeof m.index === 'number') {
            const start = idx + m.index
            const end = start + m[0].length
            const candidate = {keyIdx: k, start, end, dist: 0}
            if (
              !bestMatch
              || candidate.start < bestMatch.start
              || (candidate.start === bestMatch.start && end - start > bestMatch.end - bestMatch.start)
            ) {
              bestMatch = candidate
            }
          }
        }

        if (!bestMatch && maxDistance > 0 && keyN.length >= minFuzzyKeyLength) {
          // Try fuzzy match
          const L = keyN.length
          const minLen = Math.max(1, L - maxDistance)
          const maxLen = Math.min(s.length - idx, L + maxDistance)

          // Determine scan window size
          const scanLimit =
            fuzzyScanLimitOpt === 'auto' ? s.length : typeof fuzzyScanLimitOpt === 'number' ? fuzzyScanLimitOpt : 100
          const scanEnd = Math.min(s.length, idx + scanLimit)

          for (let start = idx; start < s.length && start < scanEnd; start++) {
            if (start + minLen > s.length) break

            for (let len = minLen; len <= maxLen; len++) {
              const end = start + len
              if (end > s.length) break

              const sub = sN.slice(start, end)
              const d = dlOSA(keyN, sub, maxDistance)

              if (d <= maxDistance) {
                const candidate = {keyIdx: k, start, end, dist: d}

                if (
                  !bestMatch
                  || candidate.dist < bestMatch.dist
                  || (candidate.dist === bestMatch.dist && candidate.start < bestMatch.start)
                  || (candidate.dist === bestMatch.dist
                    && candidate.start === bestMatch.start
                    && end - start > bestMatch.end - bestMatch.start)
                ) {
                  bestMatch = candidate
                }
              }
            }
          }
        }
      }
    }

    if (!bestMatch) {
      // No more matches, push the rest as non-match
      pushPiece(s.slice(idx), false)
      break
    } else {
      // Push non-match before the match
      if (bestMatch.start > idx) {
        pushPiece(s.slice(idx, bestMatch.start), false)
      }
      // Push the match
      pushPiece(s.slice(bestMatch.start, bestMatch.end), true)
      used[bestMatch.keyIdx] = true
      idx = bestMatch.end
    }
  }

  return pieces
}

const escapeRegExp = (s: string) => {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const buildTagAgnosticRegex = (key: string, caseInsensitive: boolean): RegExp | null => {
  if (!key) return null
  // Split into word and punctuation tokens, excluding whitespace, so we can
  // allow tags/entities/whitespace between words and punctuation like '.'
  const rawTokens = key.match(/([A-Za-z0-9]+|[^A-Za-z0-9\s]+)/g) || []
  const tokens = rawTokens.filter((t) => t && !/^\s+$/.test(t)).map(escapeRegExp)
  if (tokens.length === 0) return null
  if (tokens.length === 1) {
    // Single token adds no benefit over exact search
    try {
      return new RegExp(tokens[0]!, caseInsensitive ? 'i' : '')
    } catch {
      return null
    }
  }

  // Allow zero or more whitespace/tags/entities between tokens so punctuation
  // adjacent to words still matches while bridging across markup.
  const gap = '(?:\\s|<[^>]*>|&[#a-zA-Z0-9]+;)*'
  const pattern = tokens.join(gap)
  try {
    return new RegExp(pattern, caseInsensitive ? 'i' : '')
  } catch {
    return null
  }
}
