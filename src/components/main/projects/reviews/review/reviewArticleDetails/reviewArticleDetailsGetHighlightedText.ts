type Piece = [text: string, isHit: boolean]

const escapeRx = (s: string) => {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export const reviewArticleDetailsGetHighlightedText = (
  input: string,
  tokens: readonly string[],
): Piece[] => {
  // Longest-first so longer tokens win at the same start index
  const sorted = [...tokens].sort((a, b) => {
    return b.length - a.length
  })

  // Map startIndex -> chosen token (first write wins due to longest-first)
  const starts = sorted.reduce<Map<number, string>>((map, t) => {
    const re = new RegExp(`${escapeRx(t)}(?=\\b|$)`, 'g')
    return Array.from(input.matchAll(re)).reduce((m, mth) => {
      const i = mth.index
      return m.has(i) ? m : m.set(i, t)
    }, map)
  }, new Map())

  const orderedStarts = [...starts.keys()].sort((a, b) => {
    return a - b
  })

  // No hits -> whole input is a single non-hit (or [] if empty)
  if (orderedStarts.length === 0) {
    return input ? ([[input, false]] as Piece[]) : []
  }

  // Build pieces from spans
  const pieces = orderedStarts.reduce<Piece[]>((acc, start, idx) => {
    const prevEnd =
      idx === 0
        ? 0
        : (() => {
            const pStart = orderedStarts[idx - 1]
            const pTok = starts.get(pStart)!
            return pStart + pTok.length
          })()

    if (start > prevEnd) acc.push([input.slice(prevEnd, start), false])

    const tok = starts.get(start)!
    acc.push([tok, true])

    // After the last hit, push the trailing tail
    if (idx === orderedStarts.length - 1) {
      const end = start + tok.length
      if (end < input.length) acc.push([input.slice(end), false])
    }
    return acc
  }, [])

  // Conditional trim: only if the very first hit is word-only (A-Za-z0-9_)
  if (pieces.length >= 2 && !pieces[0][1]) {
    const firstHit = pieces.find((p) => {
      return p[1]
    })!
    if (/^[A-Za-z0-9_]+$/.test(firstHit[0])) {
      pieces[0][0] = pieces[0][0].replace(/\s+$/, '')
    }
  }

  return pieces
}
