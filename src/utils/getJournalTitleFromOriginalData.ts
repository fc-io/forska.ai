const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const asNonEmptyString = (value: unknown) => {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed ? trimmed : null
}

const getValueAtPath = (value: unknown, path: string[]): unknown => {
  return path.length === 0 ? value : getValueAtPath(isRecord(value) ? value[path[0]] : null, path.slice(1))
}

const getStringAtPath = (value: unknown, path: string[]) => {
  return asNonEmptyString(getValueAtPath(value, path))
}

const getFirstStringAtPath = (value: unknown, path: string[]) => {
  const resolved = getValueAtPath(value, path)
  const entries = Array.isArray(resolved) ? resolved : resolved ? [resolved] : []

  const first = entries.map(asNonEmptyString).find((v): v is string => {
    return Boolean(v)
  })
  return first ?? null
}

export const getJournalTitleFromOriginalData = (originalData: unknown) => {
  const candidates = [
    getStringAtPath(originalData, ['journalInfo', 'journal', 'title']),
    getStringAtPath(originalData, ['journalInfo', 'title']),
    getStringAtPath(originalData, ['journal', 'title']),
    getFirstStringAtPath(originalData, ['container-title']),
    getFirstStringAtPath(originalData, ['containerTitle']),
    getStringAtPath(originalData, ['host_venue', 'display_name']),
    getStringAtPath(originalData, ['primary_location', 'source', 'display_name']),
    getStringAtPath(originalData, ['primary_location', 'source', 'host_organization_name']),
    getStringAtPath(originalData, ['journalTitle']),
  ]

  const match = candidates.find((v): v is string => {
    return Boolean(v)
  })
  return match ?? null
}
