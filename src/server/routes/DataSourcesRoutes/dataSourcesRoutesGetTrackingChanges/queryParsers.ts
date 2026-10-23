export const parseEnumList = <T extends string>(
  value: string | undefined,
  allowedValues: readonly T[],
): T[] | undefined => {
  if (!value) {
    return undefined
  }

  const allowed = new Set(allowedValues)
  const values = value
    .split(',')
    .map((entry) => {
      return entry.trim()
    })
    .filter((entry) => {
      return entry.length > 0
    })

  if (values.length === 0) {
    return undefined
  }

  for (const entry of values) {
    if (!allowed.has(entry as T)) {
      throw new Error(`Unsupported data source tracking filter: ${entry}`)
    }
  }

  return values as T[]
}

export const parseBoundedInteger = (value: string | undefined, fallback: number, min: number, max: number) => {
  const parsed = value === undefined ? fallback : Number.parseInt(value, 10)
  const normalized = Number.isFinite(parsed) ? parsed : fallback

  return Math.min(max, Math.max(min, normalized))
}
