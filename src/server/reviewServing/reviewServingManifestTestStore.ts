type ProjectionManifestTestRow = {
  baseGeneration: number
  definitionVersion: string
  inputDigest: string | null
  inputWatermark: number
  inputWatermarksJson: string
  invalidationReason: string | null
  manifestId: string
  patchRangeEnd: number | null
  patchRangeStart: number | null
  patchWatermark: number
  projectId: string | null
  projectionComponent: string
  projectionIdentity: string
  promptConfigHash: string | null
  reviewConfigHash: string | null
  status: string
}

const decodeSqlValue = (value: string | undefined) => {
  if (value === undefined || value === 'NULL') {
    return null
  }

  return value
    .replace(/^'/u, '')
    .replace(/'(?:\s*::JSON)?$/u, '')
    .replaceAll("''", "'")
}

const getGuardedInsertSelectValues = (statement: string) => {
  const valueList = statement.match(/\bSELECT\s+([\s\S]*?)\s+WHERE\s+NOT\s+EXISTS\s*\(/u)?.[1] ?? ''
  const values: string[] = []
  let current = ''
  let inString = false

  for (let index = 0; index < valueList.length; index += 1) {
    const char = valueList[index]

    if (char === "'") {
      const next = valueList[index + 1]

      if (inString && next === "'") {
        current += "''"
        index += 1
        continue
      }

      inString = !inString
      current += char
      continue
    }

    if (char === ',' && !inString) {
      values.push(current.trim())
      current = ''
      continue
    }

    current += char
  }

  if (current.trim() !== '') {
    values.push(current.trim())
  }

  return values
}

const getProjectionManifestRow = (statement: string): ProjectionManifestTestRow => {
  const values = getGuardedInsertSelectValues(statement)
  const getNullableNumber = (value: string | undefined) => {
    return value === undefined || value === 'NULL' ? null : Number(value)
  }

  return {
    baseGeneration: Number(values[4] ?? 0),
    definitionVersion: decodeSqlValue(values[11]) ?? '',
    inputDigest: decodeSqlValue(values[10]),
    inputWatermark: Number(values[8] ?? 0),
    inputWatermarksJson: decodeSqlValue(values[9]) ?? '{}',
    invalidationReason: decodeSqlValue(values[15]),
    manifestId: decodeSqlValue(values[0]) ?? '',
    patchRangeEnd: getNullableNumber(values[7]),
    patchRangeStart: getNullableNumber(values[6]),
    patchWatermark: Number(values[5] ?? 0),
    projectId: decodeSqlValue(values[1]),
    projectionComponent: decodeSqlValue(values[2]) ?? '',
    projectionIdentity: decodeSqlValue(values[3]) ?? '',
    promptConfigHash: decodeSqlValue(values[13]),
    reviewConfigHash: decodeSqlValue(values[12]),
    status: decodeSqlValue(values[14]) ?? 'candidate',
  }
}

export const createReviewServingManifestTestStore = () => {
  const projectionManifests = new Map<string, ProjectionManifestTestRow>()

  return {
    getQueryResult: <T>(statement: string): T[] | null => {
      if (!statement.includes('FROM app.review_projection_identity_manifest')) {
        return null
      }

      const manifestId = statement.match(/manifest_id = '([^']+)'/u)?.[1]
      const manifest = manifestId === undefined ? undefined : projectionManifests.get(manifestId)

      return manifest === undefined ? [] : ([manifest] as T[])
    },
    run: (statement: string) => {
      if (!statement.includes('INSERT INTO app.review_projection_identity_manifest')) {
        return
      }

      const manifest = getProjectionManifestRow(statement)

      projectionManifests.set(manifest.manifestId, manifest)
    },
  }
}
