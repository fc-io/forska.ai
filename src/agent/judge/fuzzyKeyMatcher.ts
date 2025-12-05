// Levenshtein distance implementation using flat array to avoid non-null assertions
const levenshtein = (a: string, b: string): number => {
  const aLen = a.length
  const bLen = b.length

  // Use a flat 1D array to represent the 2D matrix
  const width = bLen + 1
  const matrix = new Array<number>((aLen + 1) * width).fill(0)

  const idx = (i: number, j: number): number => {
    return i * width + j
  }

  for (let i = 0; i <= aLen; i++) matrix[idx(i, 0)] = i
  for (let j = 0; j <= bLen; j++) matrix[idx(0, j)] = j

  for (let i = 1; i <= aLen; i++) {
    for (let j = 1; j <= bLen; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const del = matrix[idx(i - 1, j)] ?? 0
      const ins = matrix[idx(i, j - 1)] ?? 0
      const sub = matrix[idx(i - 1, j - 1)] ?? 0
      matrix[idx(i, j)] = Math.min(del + 1, ins + 1, sub + cost)
    }
  }
  return matrix[idx(aLen, bLen)] ?? 0
}

// Maximum allowed edit distance for fuzzy matching
// Set to 1 since we use short 4-char IDs - catches single typos without false matches
const MAX_EDIT_DISTANCE = 1

/**
 * Remaps keys in a parsed JSON object to their closest expected keys
 * if within the edit distance threshold. This helps recover from LLM
 * transcription errors (e.g., typos in UUIDs or short IDs).
 */
export const remapFuzzyKeys = (parsed: Record<string, unknown>, expectedKeys: string[]): Record<string, unknown> => {
  const result: Record<string, unknown> = {}
  const usedExpectedKeys = new Set<string>()

  for (const [actualKey, value] of Object.entries(parsed)) {
    // Check if the key already matches exactly
    if (expectedKeys.includes(actualKey)) {
      result[actualKey] = value
      usedExpectedKeys.add(actualKey)
      continue
    }

    // Find best matching expected key
    let bestMatch = actualKey
    let bestDistance = Infinity

    for (const expectedKey of expectedKeys) {
      // Skip already-used expected keys to avoid collisions
      if (usedExpectedKeys.has(expectedKey)) continue

      const distance = levenshtein(actualKey, expectedKey)
      if (distance < bestDistance && distance <= MAX_EDIT_DISTANCE) {
        bestDistance = distance
        bestMatch = expectedKey
      }
    }

    if (bestDistance <= MAX_EDIT_DISTANCE && bestMatch !== actualKey) {
      console.log(`Fuzzy remapped key: "${actualKey}" -> "${bestMatch}" (distance: ${bestDistance})`)
      usedExpectedKeys.add(bestMatch)
    }

    result[bestMatch] = value
  }

  return result
}
