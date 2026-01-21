/**
 * Numeric bin generation for article reviews filters.
 *
 * Used for prompts with numeric types (string.integer, number, integer).
 * Generates up to 10 evenly-distributed bins based on min/max values.
 */

export type NumericBin = {label: string; min: number; max: number}

export type NumericFilterResult = {
  promptId: string
  promptName: string
  filterType: 'numeric'
  bins: NumericBin[]
  specialValues: string[]
}

const MAX_BINS = 10

/**
 * Generate evenly-distributed bins from min to max.
 *
 * Edge cases:
 * - min === max: single bin with that value
 * - range < MAX_BINS: one bin per integer value
 * - range >= MAX_BINS: evenly distribute into MAX_BINS bins
 */
export const generateBins = (min: number, max: number): NumericBin[] => {
  const range = max - min

  if (range === 0) {
    return [{label: String(min), min, max}]
  }

  if (range < MAX_BINS) {
    return Array.from({length: range + 1}, (_, i) => {
      const val = min + i
      return {label: String(val), min: val, max: val}
    })
  }

  const binSize = Math.ceil((range + 1) / MAX_BINS)
  const bins: NumericBin[] = []

  let currentMin = min
  while (currentMin <= max) {
    const currentMax = Math.min(currentMin + binSize - 1, max)
    bins.push({
      label: currentMin === currentMax ? String(currentMin) : `${currentMin}-${currentMax}`,
      min: currentMin,
      max: currentMax,
    })
    currentMin = currentMax + 1
  }

  return bins
}

/**
 * Build numeric filter result from min/max query results.
 */
export const buildNumericFilterResult = (
  promptId: string,
  promptName: string,
  min: number | null,
  max: number | null,
  specialValues: string[],
): NumericFilterResult => {
  const bins = min !== null && max !== null ? generateBins(min, max) : []

  return {promptId, promptName, filterType: 'numeric', bins, specialValues}
}

/**
 * Remove outliers using IQR (Interquartile Range) method.
 * Values outside Q1 - 1.5*IQR and Q3 + 1.5*IQR are considered outliers.
 */
const removeOutliers = (values: number[]): number[] => {
  if (values.length < 4) {
    return values
  }

  const sorted = [...values].sort((a, b) => {
    return a - b
  })

  const q1Index = Math.floor(sorted.length * 0.25)
  const q3Index = Math.floor(sorted.length * 0.75)
  const q1 = sorted[q1Index] ?? 0
  const q3 = sorted[q3Index] ?? 0
  const iqr = q3 - q1

  const lowerBound = q1 - 1.5 * iqr
  const upperBound = q3 + 1.5 * iqr

  return sorted.filter((v) => {
    return v >= lowerBound && v <= upperBound
  })
}

/**
 * Generate bins from an array of distinct values.
 * This approach is more robust than min/max as it handles the actual distribution.
 *
 * Strategy:
 * - Remove outliers using IQR method
 * - If <= MAX_BINS unique values: one bin per value
 * - If > MAX_BINS unique values: group into MAX_BINS bins by count (roughly equal items per bin)
 */
export const generateBinsFromValues = (values: number[]): NumericBin[] => {
  if (values.length === 0) {
    return []
  }

  // Remove outliers to avoid skewed bins
  const filtered = removeOutliers(values)

  if (filtered.length === 0) {
    // If all values were outliers, fall back to using all values
    const sorted = [...values].sort((a, b) => {
      return a - b
    })
    return sorted.slice(0, MAX_BINS).map((val) => {
      return {label: String(val), min: val, max: val}
    })
  }

  // Sort filtered values
  const sorted = [...filtered].sort((a, b) => {
    return a - b
  })

  // If few enough unique values, one bin per value
  if (sorted.length <= MAX_BINS) {
    return sorted.map((val) => {
      return {label: String(val), min: val, max: val}
    })
  }

  // Otherwise, create bins that each contain roughly equal number of values
  // This is quantile-based binning
  const bins: NumericBin[] = []
  const itemsPerBin = Math.ceil(sorted.length / MAX_BINS)

  for (let i = 0; i < MAX_BINS && i * itemsPerBin < sorted.length; i++) {
    const startIdx = i * itemsPerBin
    const endIdx = Math.min((i + 1) * itemsPerBin - 1, sorted.length - 1)
    const binMin = sorted[startIdx]
    const binMax = sorted[endIdx]

    if (binMin !== undefined && binMax !== undefined) {
      bins.push({label: binMin === binMax ? String(binMin) : `${binMin}-${binMax}`, min: binMin, max: binMax})
    }
  }

  return bins
}

/**
 * Build numeric filter result from distinct values.
 */
export const buildNumericFilterResultFromValues = (
  promptId: string,
  promptName: string,
  values: number[],
  specialValues: string[],
): NumericFilterResult => {
  const bins = generateBinsFromValues(values)

  return {promptId, promptName, filterType: 'numeric', bins, specialValues}
}
