type JsonParseResult = {ok: true; value: unknown} | {ok: false; error: string}

export type FhirDecodedNote = {path: string; text: string; truncated: boolean}

export type FhirPatientMarkdownEntry = {
  resourceType: string
  resourceId: string | null
  sortDate: string | null
  rawLine: string
  decodedNotes: FhirDecodedNote[]
}

type FhirPatientMarkdownProfile = 'summary' | 'fulltext'

export type FhirPatientMarkdownBuilt = {
  summaryMarkdown: string
  fulltextMarkdown: string
  summaryValidationErrors: string[]
  fulltextValidationErrors: string[]
  validationErrors: string[]
}

export const buildFhirPatientMarkdown = ({
  patientId,
  importRoute: _importRoute,
  assetsFolder: _assetsFolder,
  articleTitle,
  entries,
}: {
  patientId: string
  importRoute: string
  assetsFolder: string
  articleTitle: string
  entries: FhirPatientMarkdownEntry[]
}): FhirPatientMarkdownBuilt => {
  const patientEntry =
    entries.find((e) => {
      return e.resourceType === 'Patient'
    }) ?? null

  const {resourceByKey, contextByKey, identifierToKey} = buildResourceIndex(entries)
  const renderRef = ({reference, display}: {reference: string; display: string | null}): string => {
    return renderInlineReference({reference, display, contextByKey, identifierToKey})
  }

  const summaryMarkdown = buildFhirPatientMarkdownProfile({
    profile: 'summary',
    patientId,
    patientEntry,
    articleTitle,
    entries,
    renderRef,
    resourceByKey,
    identifierToKey,
  })

  const fulltextMarkdown = buildFhirPatientMarkdownProfile({
    profile: 'fulltext',
    patientId,
    patientEntry,
    articleTitle,
    entries,
    renderRef,
    resourceByKey,
    identifierToKey,
  })

  const summaryValidationErrors = validateFhirPatientSummaryMarkdown(summaryMarkdown)
  const fulltextValidationErrors = validateFhirPatientMarkdown(fulltextMarkdown)
  const validationErrors = [
    ...summaryValidationErrors.map((e) => {
      return `summary:${e}`
    }),
    ...fulltextValidationErrors.map((e) => {
      return `fulltext:${e}`
    }),
  ]

  return {summaryMarkdown, fulltextMarkdown, summaryValidationErrors, fulltextValidationErrors, validationErrors}
}

const buildFhirPatientMarkdownProfile = ({
  profile,
  patientId,
  patientEntry,
  articleTitle,
  entries,
  renderRef,
  resourceByKey,
  identifierToKey,
}: {
  profile: FhirPatientMarkdownProfile
  patientId: string
  patientEntry: FhirPatientMarkdownEntry | null
  articleTitle: string
  entries: FhirPatientMarkdownEntry[]
  renderRef: (ref: {reference: string; display: string | null}) => string
  resourceByKey: Map<string, unknown>
  identifierToKey: Map<string, string>
}): string => {
  const patientSectionLines = buildPatientSectionLines({profile, patientId, patientEntry})
  const timelineLines = buildTimelineLines({profile, patientId, entries, renderRef, resourceByKey, identifierToKey})

  const markdownLines = [
    `# ${articleTitle}`,
    '',
    '## Patient',
    ...patientSectionLines,
    '',
    '## Timeline',
    ...(timelineLines.length > 0 ? timelineLines : ['(no linked events found)']),
    '',
  ]

  return `${markdownLines.join('\n').trimEnd()}\n`
}

const tryJsonParse = (raw: string): JsonParseResult => {
  try {
    return {ok: true, value: JSON.parse(raw) as unknown}
  } catch (err) {
    return {ok: false, error: err instanceof Error ? err.message : String(err)}
  }
}

const hasResourceType = (value: unknown): value is Record<string, unknown> & {resourceType: string} => {
  return Boolean(isRecordValue(value) && typeof value.resourceType === 'string')
}

const isRecordValue = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

const getStringOrNull = (value: unknown): string | null => {
  const str = typeof value === 'string' ? value.trim() : ''
  return str.length > 0 ? str : null
}

const normalizeInlineText = (value: string): string => {
  return value.replace(/\s+/g, ' ').trim()
}

const truncateInlineText = (value: string, _maxLen: number): string => {
  return normalizeInlineText(value)
}

const safeDecodeURIComponent = (value: string): string => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

const getArrayOrEmpty = (value: unknown): unknown[] => {
  return Array.isArray(value) ? value : []
}

const getFirstRecordOrNull = (value: unknown): Record<string, unknown> | null => {
  const first = getArrayOrEmpty(value)[0]
  return isRecordValue(first) ? first : null
}

const getStringAtPath = (value: unknown, path: string[], index = 0): string | null => {
  if (index >= path.length) {
    return getStringOrNull(value)
  }

  const key = path[index] ?? ''
  const next = Array.isArray(value) ? (value as unknown[])[Number(key)] : isRecordValue(value) ? value[key] : null
  return getStringAtPath(next, path, index + 1)
}

const getNumberOrStringOrNull = (value: unknown): string | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null
  }
  return getStringOrNull(value)
}

const getCodeableConceptDisplay = (value: unknown): string | null => {
  if (!isRecordValue(value)) {
    return null
  }

  const text = getStringOrNull(value.text)
  if (text) {
    return text
  }

  const coding = getFirstRecordOrNull(value.coding)
  const display = getStringOrNull(coding?.display)
  const code = getStringOrNull(coding?.code)
  return display ?? code
}

const getFirstCodeableConceptDisplay = (resource: unknown, key: string): string | null => {
  if (!isRecordValue(resource)) {
    return null
  }
  const first = getFirstRecordOrNull(resource[key])
  return getCodeableConceptDisplay(first)
}

const buildObservationValueText = (resource: unknown): string | null => {
  const quantity = isRecordValue(resource) && isRecordValue(resource.valueQuantity) ? resource.valueQuantity : null
  const value = quantity ? getNumberOrStringOrNull(quantity.value) : null
  const unit = quantity ? getStringOrNull(quantity.unit) : null
  const both = value && unit ? `${value} ${unit}` : null
  const asQuantity = both ?? value
  const asString = isRecordValue(resource) ? getStringOrNull(resource.valueString) : null
  const asConcept = isRecordValue(resource) ? getCodeableConceptDisplay(resource.valueCodeableConcept) : null
  return asQuantity ?? asString ?? asConcept
}

const buildBullet = (label: string, value: string | null): string[] => {
  return value ? [`- ${label}: ${truncateInlineText(value, 250)}`] : []
}

type TimeCandidate = {label: string; value: string}

const getTimeCandidatesFromResource = (resource: unknown): TimeCandidate[] => {
  if (!isRecordValue(resource)) {
    return []
  }

  const candidates = [
    {label: 'effectiveDateTime', value: getStringAtPath(resource, ['effectiveDateTime'])},
    {label: 'issued', value: getStringAtPath(resource, ['issued'])},
    {label: 'date', value: getStringAtPath(resource, ['date'])},
    {label: 'authoredOn', value: getStringAtPath(resource, ['authoredOn'])},
    {label: 'recordedDate', value: getStringAtPath(resource, ['recordedDate'])},
    {label: 'onsetDateTime', value: getStringAtPath(resource, ['onsetDateTime'])},
    {label: 'occurrenceDateTime', value: getStringAtPath(resource, ['occurrenceDateTime'])},
    {label: 'performedDateTime', value: getStringAtPath(resource, ['performedDateTime'])},
    {label: 'period.start', value: getStringAtPath(resource, ['period', 'start'])},
    {label: 'period.end', value: getStringAtPath(resource, ['period', 'end'])},
    {label: 'effectivePeriod.start', value: getStringAtPath(resource, ['effectivePeriod', 'start'])},
    {label: 'effectivePeriod.end', value: getStringAtPath(resource, ['effectivePeriod', 'end'])},
    {label: 'occurrencePeriod.start', value: getStringAtPath(resource, ['occurrencePeriod', 'start'])},
    {label: 'occurrencePeriod.end', value: getStringAtPath(resource, ['occurrencePeriod', 'end'])},
    {label: 'performedPeriod.start', value: getStringAtPath(resource, ['performedPeriod', 'start'])},
    {label: 'performedPeriod.end', value: getStringAtPath(resource, ['performedPeriod', 'end'])},
    {label: 'abatementDateTime', value: getStringAtPath(resource, ['abatementDateTime'])},
  ]

  return candidates
    .filter((c): c is {label: string; value: string} => {
      return typeof c.value === 'string' && c.value.trim().length > 0
    })
    .map((c) => {
      return {label: c.label, value: c.value}
    })
}

const getUniqueTimeSourcesForValue = (candidates: TimeCandidate[], timeValue: string): string[] => {
  return candidates
    .filter((c) => {
      return c.value === timeValue
    })
    .map((c) => {
      return c.label
    })
    .reduce<string[]>((acc, label) => {
      return acc.includes(label) ? acc : [...acc, label]
    }, [])
}

const buildTimeAndIdBullet = ({
  profile,
  resource,
  resourceId,
  sortDate,
  includeId,
}: {
  profile: FhirPatientMarkdownProfile
  resource: unknown
  resourceId: string | null
  sortDate: string | null
  includeId: boolean
}): string[] => {
  const sortValue = getStringOrNull(sortDate)
  const candidates = getTimeCandidatesFromResource(resource)
  const timeValue = sortValue ?? candidates[0]?.value ?? null
  if (!timeValue) {
    return []
  }

  const sources = getUniqueTimeSourcesForValue(candidates, timeValue)
  const labelSources = sources.length > 0 ? sources : sortValue ? ['sortDate'] : []
  const label = profile === 'summary' ? 'time' : labelSources.length > 0 ? `time(${labelSources.join(', ')})` : 'time'
  const timeLine = `- ${label}: ${truncateInlineText(timeValue, 120)}`
  const idLine = includeId && resourceId ? `- id: \`${resourceId}\`` : null
  return [timeLine, ...(idLine ? [idLine] : [])]
}

const buildEventBullets = ({
  profile,
  resourceType,
  resourceId,
  resource,
  sortDate,
}: {
  profile: FhirPatientMarkdownProfile
  resourceType: string
  resourceId: string | null
  resource: unknown
  sortDate: string | null
}): string[] => {
  const base = buildTimeAndIdBullet({profile, resource, resourceId, sortDate, includeId: false})

  if (!isRecordValue(resource)) {
    return base
  }

  if (resourceType === 'Encounter') {
    const status = getStringAtPath(resource, ['status'])
    const periodStart = getStringAtPath(resource, ['period', 'start'])
    const periodEnd = getStringAtPath(resource, ['period', 'end'])
    const period = periodStart && periodEnd ? `${periodStart} to ${periodEnd}` : null
    const location = getStringAtPath(resource, ['location', '0', 'location', 'display'])
    const provider = getStringAtPath(resource, ['serviceProvider', 'display'])
    return [
      ...base,
      ...buildBullet('status', status),
      ...buildBullet('period', period),
      ...buildBullet('location', location),
      ...buildBullet('provider', provider),
    ]
  }

  if (resourceType === 'Condition') {
    const clinicalStatus = getStringAtPath(resource, ['clinicalStatus', 'coding', '0', 'code'])
    const verificationStatus = getStringAtPath(resource, ['verificationStatus', 'coding', '0', 'code'])
    return [
      ...base,
      ...buildBullet('clinicalStatus', clinicalStatus),
      ...buildBullet('verificationStatus', verificationStatus),
    ]
  }

  if (resourceType === 'Observation') {
    const status = getStringAtPath(resource, ['status'])
    const value = buildObservationValueText(resource)
    return [...base, ...buildBullet('status', status), ...buildBullet('value', value)]
  }

  if (resourceType === 'Procedure') {
    const status = getStringAtPath(resource, ['status'])
    return [...base, ...buildBullet('status', status)]
  }

  if (resourceType === 'Immunization') {
    const status = getStringAtPath(resource, ['status'])
    const location = getStringAtPath(resource, ['location', 'display'])
    return [...base, ...buildBullet('status', status), ...buildBullet('location', location)]
  }

  if (resourceType === 'MedicationRequest') {
    const status = getStringAtPath(resource, ['status'])
    const intent = getStringAtPath(resource, ['intent'])
    const reason =
      getStringAtPath(resource, ['reasonCode', '0', 'text'])
      ?? getStringAtPath(resource, ['reasonCode', '0', 'coding', '0', 'display'])
    return [
      ...base,
      ...buildBullet('status', status),
      ...buildBullet('intent', intent),
      ...buildBullet('reason', reason),
    ]
  }

  if (resourceType === 'AllergyIntolerance') {
    const type = getStringAtPath(resource, ['type'])
    const criticality = getStringAtPath(resource, ['criticality'])
    const clinicalStatus = getStringAtPath(resource, ['clinicalStatus', 'coding', '0', 'code'])
    return [
      ...base,
      ...buildBullet('type', type),
      ...buildBullet('criticality', criticality),
      ...buildBullet('clinicalStatus', clinicalStatus),
    ]
  }

  if (resourceType === 'DocumentReference') {
    const status = getStringAtPath(resource, ['status'])
    return [...base, ...buildBullet('status', status)]
  }

  if (resourceType === 'DiagnosticReport') {
    const status = getStringAtPath(resource, ['status'])
    return [...base, ...buildBullet('status', status)]
  }

  return base
}

const getEventDisplay = ({
  resourceType,
  resourceId: _resourceId,
  resource,
}: {
  resourceType: string
  resourceId: string | null
  resource: unknown
}): string | null => {
  if (!isRecordValue(resource)) {
    return null
  }

  if (resourceType === 'Practitioner') {
    const firstName = getFirstRecordOrNull(resource.name)
    const asHumanName = firstName ? buildHumanName(firstName) : null
    return asHumanName ? truncateInlineText(asHumanName, 140) : null
  }

  if (resourceType === 'Organization') {
    const name = getStringAtPath(resource, ['name'])
    return name ? truncateInlineText(name, 140) : null
  }

  if (resourceType === 'Location') {
    const name = getStringAtPath(resource, ['name'])
    const city = getStringAtPath(resource, ['address', 'city'])
    const state = getStringAtPath(resource, ['address', 'state'])
    const locality = joinNonEmptyParts([city, state], ', ')
    const combined = joinNonEmptyParts([name, locality], ' - ')
    return combined ? truncateInlineText(combined, 140) : null
  }

  if (resourceType === 'Device') {
    const type = getCodeableConceptDisplay(resource.type)
    const name = getStringAtPath(resource, ['deviceName', '0', 'name'])
    const manufacturer = getStringAtPath(resource, ['manufacturer'])
    const model = getStringAtPath(resource, ['modelNumber'])
    const base = type ?? name ?? manufacturer ?? model
    const modelSuffix = base && model && base !== model ? `model ${model}` : null
    const suffix = joinNonEmptyParts([modelSuffix], '; ')
    const combined = base ? (suffix ? `${base} (${suffix})` : base) : null
    return combined ? truncateInlineText(combined, 140) : null
  }

  const display =
    resourceType === 'Encounter'
      ? getFirstCodeableConceptDisplay(resource, 'type')
      : resourceType === 'Condition'
        ? getCodeableConceptDisplay(resource.code)
        : resourceType === 'Observation'
          ? getCodeableConceptDisplay(resource.code)
          : resourceType === 'Procedure'
            ? getCodeableConceptDisplay(resource.code)
            : resourceType === 'Immunization'
              ? getCodeableConceptDisplay(resource.vaccineCode)
              : resourceType === 'MedicationRequest'
                ? (getCodeableConceptDisplay(resource.medicationCodeableConcept)
                  ?? getStringOrNull(
                    isRecordValue(resource.medicationReference) ? resource.medicationReference.display : null,
                  ))
                : resourceType === 'AllergyIntolerance'
                  ? getCodeableConceptDisplay(resource.code)
                  : resourceType === 'DocumentReference'
                    ? getCodeableConceptDisplay(resource.type)
                    : resourceType === 'DiagnosticReport'
                      ? getCodeableConceptDisplay(resource.code)
                      : null

  return display ? truncateInlineText(display, 140) : null
}

type ExtractedReference = {path: string; reference: string; display: string | null}

const extractReferencesFromResource = (resource: unknown): ExtractedReference[] => {
  const acc: ExtractedReference[] = []

  const walk = (value: unknown, path: string): void => {
    if (!value) {
      return
    }

    if (Array.isArray(value)) {
      value.forEach((v, idx) => {
        const nextPath = path ? `${path}[${idx}]` : `[${idx}]`
        walk(v, nextPath)
      })
      return
    }

    if (!isRecordValue(value)) {
      return
    }

    const reference = getStringOrNull(value.reference)
    if (reference) {
      const display = getStringOrNull(value.display)
      acc.push({path, reference, display})
      return
    }

    Object.entries(value).forEach(([k, v]) => {
      const nextPath = path ? `${path}.${k}` : k
      walk(v, nextPath)
    })
  }

  walk(resource, '')
  return acc
}

type NormalizedReferenceKey = {key: string; resourceType: string; id: string}

const normalizeFhirReferenceKey = (reference: string): NormalizedReferenceKey | null => {
  const trimmed = reference.trim()
  if (trimmed.length === 0) {
    return null
  }

  const matches = Array.from(trimmed.matchAll(/([A-Za-z]+)\/([^/\s?]+)(?:\/[^\s]*)?/g))
    .map((m) => {
      return {resourceType: m[1] ?? '', id: m[2] ?? ''}
    })
    .filter((m) => {
      return m.resourceType.length > 0 && m.id.length > 0 && /^[A-Z]/.test(m.resourceType)
    })

  const last = matches[matches.length - 1]
  return last ? {key: `${last.resourceType}/${last.id}`, resourceType: last.resourceType, id: last.id} : null
}

const parseIdentifierQueryReference = (
  reference: string,
): {resourceType: string; system: string; value: string} | null => {
  const trimmed = reference.trim()
  const qIdx = trimmed.indexOf('?')
  if (qIdx <= 0) {
    return null
  }

  const resourceType = trimmed.slice(0, qIdx)
  const matchesType = resourceType.match(/^[A-Z][A-Za-z]+$/)
  if (!matchesType) {
    return null
  }

  const query = trimmed.slice(qIdx + 1)
  const parts = query.split('&')
  const idParam = parts
    .map((p) => {
      const [k, ...rest] = p.split('=')
      const v = rest.join('=')
      return {k: safeDecodeURIComponent(String(k ?? '')), v: safeDecodeURIComponent(String(v ?? ''))}
    })
    .find((p) => {
      return p.k === 'identifier'
    })

  if (!idParam || !idParam.v) {
    return null
  }

  const [systemRaw, valueRaw] = idParam.v.split('|')
  const system = String(systemRaw ?? '').trim()
  const value = String(valueRaw ?? '').trim()
  return system && value ? {resourceType, system, value} : null
}

const buildResourceIndex = (entries: FhirPatientMarkdownEntry[]) => {
  const resourceByKey = new Map<string, unknown>()
  const identifierToKey = new Map<string, string>()

  entries.forEach((entry) => {
    const parsed = tryJsonParse(entry.rawLine)
    if (!parsed.ok || !hasResourceType(parsed.value)) {
      return
    }

    const res = parsed.value
    const resourceType = res.resourceType
    const id = getStringOrNull(res.id)
    if (!id) {
      return
    }

    const key = `${resourceType}/${id}`
    if (!resourceByKey.has(key)) {
      resourceByKey.set(key, res)
    }

    const identifiers = getArrayOrEmpty(res.identifier)
    identifiers.forEach((ident) => {
      if (!isRecordValue(ident)) {
        return
      }
      const system = getStringOrNull(ident.system)
      const value = getStringOrNull(ident.value)
      if (!system || !value) {
        return
      }
      identifierToKey.set(`${resourceType}|${system}|${value}`, key)
    })
  })

  const contextByKey = new Map<string, string>()
  Array.from(resourceByKey.entries()).forEach(([key, resource]) => {
    const type = key.split('/')[0] ?? ''
    const context = buildInlineContextForResource(type, resource)
    if (context) {
      contextByKey.set(key, context)
    }
  })

  return {resourceByKey, contextByKey, identifierToKey}
}

const buildInlineContextForResource = (resourceType: string, resource: unknown): string => {
  if (!isRecordValue(resource)) {
    return ''
  }

  const push = (label: string, value: string | null, parts: string[]) => {
    if (value) {
      parts.push(`${label}: ${truncateInlineText(value, 120)}`)
    }
  }

  const parts: string[] = []

  if (resourceType === 'Patient') {
    push('name', getStringAtPath(resource, ['name', '0', 'text']), parts)
    push('gender', getStringAtPath(resource, ['gender']), parts)
    push('birthDate', getStringAtPath(resource, ['birthDate']), parts)
    return parts.join('; ')
  }

  if (resourceType === 'Encounter') {
    push('status', getStringAtPath(resource, ['status']), parts)
    push('period', getStringAtPath(resource, ['period', 'start']), parts)
    push('type', getFirstCodeableConceptDisplay(resource, 'type'), parts)
    push('location', getStringAtPath(resource, ['location', '0', 'location', 'display']), parts)
    push('provider', getStringAtPath(resource, ['serviceProvider', 'display']), parts)
    return parts.join('; ')
  }

  if (resourceType === 'Organization') {
    push('name', getStringAtPath(resource, ['name']), parts)
    push('phone', getStringAtPath(resource, ['telecom', '0', 'value']), parts)
    return parts.join('; ')
  }

  if (resourceType === 'Practitioner') {
    const nameText = getStringAtPath(resource, ['name', '0', 'text'])
    const family = getStringAtPath(resource, ['name', '0', 'family'])
    const given = getStringAtPath(resource, ['name', '0', 'given', '0'])
    const name = nameText ?? (family || given ? `${given ?? ''} ${family ?? ''}`.trim() : null)
    push('name', name, parts)
    return parts.join('; ')
  }

  if (resourceType === 'Device') {
    push('type', getCodeableConceptDisplay(resource.type), parts)
    push('model', getStringAtPath(resource, ['modelNumber']), parts)
    push('udi', getStringAtPath(resource, ['udiCarrier', '0', 'deviceIdentifier']), parts)
    return parts.join('; ')
  }

  if (resourceType === 'Location') {
    push('name', getStringAtPath(resource, ['name']), parts)
    push('city', getStringAtPath(resource, ['address', 'city']), parts)
    push('state', getStringAtPath(resource, ['address', 'state']), parts)
    return parts.join('; ')
  }

  push('status', getStringAtPath(resource, ['status']), parts)
  push('code', getCodeableConceptDisplay(resource.code), parts)
  push('date', getStringAtPath(resource, ['date']), parts)
  push('issued', getStringAtPath(resource, ['issued']), parts)
  return parts.join('; ')
}

const renderInlineReference = ({
  reference,
  display,
  contextByKey,
  identifierToKey,
}: {
  reference: string
  display: string | null
  contextByKey: Map<string, string>
  identifierToKey: Map<string, string>
}): string => {
  const trimmedRef = reference.trim()
  const directKey = normalizeFhirReferenceKey(trimmedRef)
  const byIdentifier = directKey ? null : parseIdentifierQueryReference(trimmedRef)
  const resolvedKey =
    directKey?.key
    ?? (byIdentifier
      ? identifierToKey.get(`${byIdentifier.resourceType}|${byIdentifier.system}|${byIdentifier.value}`)
      : null)

  const resourceType =
    (resolvedKey ? getStringOrNull(resolvedKey.split('/')[0]) : null)
    ?? byIdentifier?.resourceType
    ?? directKey?.resourceType
    ?? null
  const context = resolvedKey ? (contextByKey.get(resolvedKey) ?? null) : null
  const inlineContext = getStringOrNull(context)
  const inlineDisplay = display ? truncateInlineText(display, 160) : null

  if (inlineContext && resourceType) {
    return `${resourceType} (${inlineContext})`
  }
  if (inlineContext) {
    return inlineContext
  }
  if (inlineDisplay && resourceType) {
    return `${resourceType}: ${inlineDisplay}`
  }
  if (inlineDisplay) {
    return inlineDisplay
  }
  return resourceType ?? 'Reference'
}

const buildPatientSectionLines = ({
  profile,
  patientId: _patientId,
  patientEntry,
}: {
  profile: FhirPatientMarkdownProfile
  patientId: string
  patientEntry: FhirPatientMarkdownEntry | null
}): string[] => {
  const parsed = patientEntry ? tryJsonParse(patientEntry.rawLine) : {ok: false as const, error: 'missing'}
  const resource = parsed.ok ? parsed.value : null
  if (!isRecordValue(resource)) {
    return []
  }

  const names = getArrayOrEmpty(resource.name)
    .map((n) => {
      return isRecordValue(n) ? buildHumanName(n) : null
    })
    .filter((v): v is string => {
      return Boolean(v)
    })

  const nameLines = names.flatMap((name) => {
    return buildBullet('name', name)
  })

  const gender = getStringAtPath(resource, ['gender'])
  const birthDate = getStringAtPath(resource, ['birthDate'])
  const deceasedBoolean = getStringAtPath(resource, ['deceasedBoolean'])
  const deceasedDateTime = getStringAtPath(resource, ['deceasedDateTime'])
  const deceased = deceasedDateTime ?? deceasedBoolean

  const identifiers = getArrayOrEmpty(resource.identifier).flatMap((ident) => {
    return isRecordValue(ident) ? buildIdentifierLines(ident, profile) : []
  })

  const telecom = getArrayOrEmpty(resource.telecom).flatMap((t) => {
    return isRecordValue(t) ? buildTelecomLines(t, profile) : []
  })

  const addresses = getArrayOrEmpty(resource.address).flatMap((a) => {
    return isRecordValue(a) ? buildAddressLines(a, profile) : []
  })

  return [
    ...nameLines,
    ...buildBullet('gender', gender),
    ...buildBullet('birthDate', birthDate),
    ...buildBullet('deceased', deceased),
    ...identifiers,
    ...telecom,
    ...addresses,
  ].filter((l) => {
    return l.trim().length > 0
  })
}

const buildHumanName = (name: Record<string, unknown>): string | null => {
  const text = getStringOrNull(name.text)
  if (text) {
    return text
  }

  const prefix = getArrayOrEmpty(name.prefix)
    .map((p) => {
      return getStringOrNull(p)
    })
    .filter((v): v is string => {
      return Boolean(v)
    })
    .join(' ')
  const given = getArrayOrEmpty(name.given)
    .map((g) => {
      return getStringOrNull(g)
    })
    .filter((v): v is string => {
      return Boolean(v)
    })
    .join(' ')
  const family = getStringOrNull(name.family)
  const suffix = getArrayOrEmpty(name.suffix)
    .map((s) => {
      return getStringOrNull(s)
    })
    .filter((v): v is string => {
      return Boolean(v)
    })
    .join(' ')

  const joined = [prefix, given, family, suffix].filter((v): v is string => {
    return Boolean(v && v.length > 0)
  })
  return joined.length > 0 ? joined.join(' ') : null
}

const joinNonEmptyParts = (parts: (string | null)[], sep: string): string => {
  return parts
    .filter((p): p is string => {
      return Boolean(p && p.trim().length > 0)
    })
    .join(sep)
}

const buildIdentifierLines = (ident: Record<string, unknown>, profile: FhirPatientMarkdownProfile): string[] => {
  const value = getStringOrNull(ident.value)
  const type = getCodeableConceptDisplay(ident.type)
  const use = getStringOrNull(ident.use)

  const labelBase = type ?? 'identifier'
  const label = profile === 'fulltext' && use ? `${labelBase} (${use})` : labelBase
  return value ? [`- ${label}: ${truncateInlineText(value, 250)}`] : []
}

const getTelecomSystemLabel = (system: string | null): string => {
  const normalized = (system ?? '').trim().toLowerCase()
  return normalized === 'phone'
    ? 'Phone'
    : normalized === 'email'
      ? 'Email'
      : normalized === 'fax'
        ? 'Fax'
        : normalized === 'sms'
          ? 'SMS'
          : normalized === 'pager'
            ? 'Pager'
            : normalized === 'url'
              ? 'URL'
              : 'Contact'
}

const buildTelecomLines = (telecom: Record<string, unknown>, _profile: FhirPatientMarkdownProfile): string[] => {
  const system = getStringOrNull(telecom.system)
  const value = getStringOrNull(telecom.value)
  const use = getStringOrNull(telecom.use)

  const labelBase = getTelecomSystemLabel(system)
  const label = use ? `${labelBase} (${use})` : labelBase
  return value ? [`- ${label}: ${truncateInlineText(value, 250)}`] : []
}

const buildAddressLines = (address: Record<string, unknown>, _profile: FhirPatientMarkdownProfile): string[] => {
  const use = getStringOrNull(address.use)
  const text = getStringOrNull(address.text)
  const lines = getArrayOrEmpty(address.line)
    .map((l) => {
      return getStringOrNull(l)
    })
    .filter((v): v is string => {
      return Boolean(v)
    })
    .join(', ')
  const city = getStringOrNull(address.city)
  const state = getStringOrNull(address.state)
  const postalCode = getStringOrNull(address.postalCode)
  const country = getStringOrNull(address.country)
  const locality = joinNonEmptyParts([city, state, postalCode, country], ', ')

  const value = text ?? joinNonEmptyParts([lines || null, locality || null], ', ')
  const label = use ? `address (${use})` : 'address'
  return value ? [`- ${label}: ${truncateInlineText(value, 400)}`] : []
}

type TimelineEvent = {
  sortMs: number | null
  bucketDate: string
  resourceType: string
  resourceId: string | null
  display: string | null
  bullets: string[]
  resultBullets: string[]
  refBullets: string[]
  noteKeysInOrder: string[]
}

type TimelineRenderBlock =
  | {kind: 'event'; bucketDate: string; lines: string[]; noteKeysInOrder: string[]}
  | {kind: 'eventGroup'; bucketDate: string; lines: string[]; noteKeysInOrder: string[]; events: TimelineEvent[]}

const getSortMsFromSortDate = (sortDate: string | null): number | null => {
  const value = (sortDate ?? '').trim()
  if (!value) {
    return null
  }
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

const getBucketDateFromSort = (sortMs: number | null, sortDate: string | null): string => {
  if (sortMs !== null) {
    return new Date(sortMs).toISOString().slice(0, 10)
  }
  const value = (sortDate ?? '').trim()
  if (value.match(/^\d{4}-\d{2}-\d{2}/)) {
    return value.slice(0, 10)
  }
  if (value.match(/^\d{4}-\d{2}/)) {
    return `${value.slice(0, 7)}-01`
  }
  if (value.match(/^\d{4}/)) {
    return `${value.slice(0, 4)}-01-01`
  }
  return 'Undated'
}

const compareTimelineEvents = (a: TimelineEvent, b: TimelineEvent): number => {
  const aMs = a.sortMs
  const bMs = b.sortMs
  const t = aMs !== null && bMs !== null ? bMs - aMs : aMs !== null ? -1 : bMs !== null ? 1 : 0
  const rt = a.resourceType.localeCompare(b.resourceType)
  const id = (a.resourceId ?? '').localeCompare(b.resourceId ?? '')
  return t !== 0 ? t : rt !== 0 ? rt : id
}

const resolveReferenceToKey = ({
  reference,
  identifierToKey,
}: {
  reference: string
  identifierToKey: Map<string, string>
}): string | null => {
  const trimmed = reference.trim()
  const direct = normalizeFhirReferenceKey(trimmed)
  const byIdentifier = direct ? null : parseIdentifierQueryReference(trimmed)
  const resolved =
    direct?.key
    ?? (byIdentifier
      ? identifierToKey.get(`${byIdentifier.resourceType}|${byIdentifier.system}|${byIdentifier.value}`)
      : null)
  return resolved ?? null
}

type ObservationPanelItem = {text: string; status: string | null; issued: string | null}

const buildObservationPanelItem = ({
  resource,
  fallbackDisplay,
}: {
  resource: unknown
  fallbackDisplay: string | null
}) => {
  const status = getStringAtPath(resource, ['status'])
  const issued = getStringAtPath(resource, ['issued']) ?? getStringAtPath(resource, ['effectiveDateTime'])
  const code = isRecordValue(resource) ? getCodeableConceptDisplay(resource.code) : null
  const value = buildObservationValueText(resource)

  const base =
    code && value
      ? `${truncateInlineText(code, 220)}: ${truncateInlineText(value, 120)}`
      : code
        ? truncateInlineText(code, 260)
        : fallbackDisplay
          ? truncateInlineText(fallbackDisplay, 260)
          : 'Observation'

  return {text: base, status, issued} satisfies ObservationPanelItem
}

const getSharedNonNullValue = (values: (string | null)[]): string | null => {
  if (values.length === 0) {
    return null
  }
  const nonNull = values.filter((v): v is string => {
    return Boolean(v && v.trim().length > 0)
  })
  if (nonNull.length !== values.length) {
    return null
  }
  const first = nonNull[0] ?? null
  if (!first) {
    return null
  }
  const allSame = nonNull.every((v) => {
    return v === first
  })
  return allSame ? first : null
}

const buildDiagnosticReportResultsBlockLines = ({
  resource,
  renderRef,
  resourceByKey,
  identifierToKey,
}: {
  resource: unknown
  renderRef: (ref: {reference: string; display: string | null}) => string
  resourceByKey: Map<string, unknown>
  identifierToKey: Map<string, string>
}): string[] => {
  if (!isRecordValue(resource)) {
    return []
  }

  const results = getArrayOrEmpty(resource.result)
    .map((r) => {
      return isRecordValue(r) ? r : null
    })
    .filter((r): r is Record<string, unknown> => {
      return Boolean(r)
    })
    .map((r) => {
      const reference = getStringOrNull(r.reference)
      const display = getStringOrNull(r.display)
      return reference ? {reference, display} : null
    })
    .filter((r): r is {reference: string; display: string | null} => {
      return Boolean(r)
    })

  if (results.length === 0) {
    return []
  }

  const items = results.map((r) => {
    const key = resolveReferenceToKey({reference: r.reference, identifierToKey})
    const resolved = key ? (resourceByKey.get(key) ?? null) : null
    const isObs = Boolean(isRecordValue(resolved) && getStringOrNull(resolved.resourceType) === 'Observation')
    if (isObs) {
      return buildObservationPanelItem({resource: resolved, fallbackDisplay: r.display})
    }
    const fallback = renderRef({reference: r.reference, display: r.display})
    return {text: truncateInlineText(fallback, 320), status: null, issued: null} satisfies ObservationPanelItem
  })

  const sharedStatus = getSharedNonNullValue(
    items.map((i) => {
      return i.status
    }),
  )
  const sharedIssued = getSharedNonNullValue(
    items.map((i) => {
      return i.issued
    }),
  )

  const reportStatus = getStringAtPath(resource, ['status'])
  const reportIssued = getStringAtPath(resource, ['issued'])
  const headerStatus = sharedStatus ?? reportStatus
  const headerIssued = sharedIssued ?? reportIssued

  const headerParts = [`Results (${items.length})`]
  if (headerStatus) {
    headerParts.push(`status: ${truncateInlineText(headerStatus, 40)}`)
  }
  if (headerIssued) {
    headerParts.push(`issued: ${truncateInlineText(headerIssued, 120)}`)
  }

  const headerLine = `##### ${headerParts.join(' | ')}`
  const itemLines = items.map((i) => {
    const extras = [
      headerStatus && i.status && i.status !== headerStatus ? `status: ${truncateInlineText(i.status, 40)}` : null,
      headerStatus ? null : i.status ? `status: ${truncateInlineText(i.status, 40)}` : null,
      headerIssued && i.issued && i.issued !== headerIssued ? `issued: ${truncateInlineText(i.issued, 120)}` : null,
      headerIssued ? null : i.issued ? `issued: ${truncateInlineText(i.issued, 120)}` : null,
    ].filter((v): v is string => {
      return Boolean(v)
    })
    const suffix = extras.length > 0 ? ` (${extras.join('; ')})` : ''
    return `  - ${i.text}${suffix}`
  })

  return [headerLine, ...itemLines]
}

const buildHumanReferenceLabel = (path: string): string => {
  const noIndexes = path.replace(/\[\d+\]/g, '')
  const noDots = noIndexes.replace(/\./g, ' ')
  const compact = noDots.replace(/\s+/g, ' ').trim()

  const mapped =
    compact === 'serviceProvider'
      ? 'provider'
      : compact === 'managingOrganization'
        ? 'organization'
        : compact === 'location location'
          ? 'location'
          : compact === 'participant individual'
            ? 'participant'
            : compact

  return mapped
}

const SUMMARY_REF_LABEL_ALLOWLIST = new Set([
  'author',
  'asserter',
  'custodian',
  'device',
  'encounter',
  'facility',
  'location',
  'organization',
  'participant',
  'performer',
  'provider',
  'recorder',
  'requester',
])

const isAllowedSummaryReferenceLabel = (label: string): boolean => {
  return SUMMARY_REF_LABEL_ALLOWLIST.has(label)
}

const isLowInfoRenderedReference = (rendered: string): boolean => {
  const trimmed = rendered.trim()
  if (trimmed.length === 0) {
    return true
  }
  if (trimmed === 'Reference') {
    return true
  }
  return /^[A-Z][A-Za-z]+$/.test(trimmed)
}

const getBulletLabelFromLine = (line: string): string | null => {
  const match = line.match(/^\s*-\s*([^:]+):/)
  const label = getStringOrNull(match?.[1])
  return label ? label.trim().toLowerCase() : null
}

const getExistingBulletLabels = (bullets: string[]): Set<string> => {
  return bullets
    .map((l) => {
      return getBulletLabelFromLine(l)
    })
    .filter((v): v is string => {
      return Boolean(v)
    })
    .reduce<Set<string>>((acc, label) => {
      acc.add(label)
      return acc
    }, new Set<string>())
}

const COLLAPSIBLE_ROLE_LABELS = new Set(['location', 'provider', 'participant', 'performer'])

const parseSimpleBulletLabelValue = (line: string): {label: string; value: string} | null => {
  const match = line.match(/^\s*-\s*([^:]+):\s*(.*)$/)
  const label = getStringOrNull(match?.[1])
  const value = getStringOrNull(match?.[2])
  return label && value ? {label: label.trim().toLowerCase(), value: value.trim()} : null
}

const collapseDuplicateRoleBullets = (bullets: string[]): string[] => {
  const parsed = bullets
    .map((line, idx) => {
      const parts = parseSimpleBulletLabelValue(line)
      if (!parts) {
        return null
      }
      if (!COLLAPSIBLE_ROLE_LABELS.has(parts.label)) {
        return null
      }
      const valueKey = normalizeInlineText(parts.value)
      return {idx, label: parts.label, value: parts.value, valueKey}
    })
    .filter((v): v is {idx: number; label: string; value: string; valueKey: string} => {
      return Boolean(v)
    })

  const grouped = parsed.reduce<Map<string, {value: string; labels: string[]; indexes: number[]}>>((acc, p) => {
    const existing = acc.get(p.valueKey) ?? null
    const next = existing
      ? {value: existing.value, labels: [...existing.labels, p.label], indexes: [...existing.indexes, p.idx]}
      : {value: p.value, labels: [p.label], indexes: [p.idx]}
    acc.set(p.valueKey, next)
    return acc
  }, new Map())

  const combinedByFirstIndex = new Map<number, string>()
  const skipIndexes = new Set<number>()

  Array.from(grouped.values()).forEach((g) => {
    const labels = uniqueInOrder(g.labels)
    if (labels.length < 2) {
      return
    }
    const firstIdx = Math.min(...g.indexes)
    const combinedLine = `- ${labels.join(', ')}: ${g.value}`
    combinedByFirstIndex.set(firstIdx, combinedLine)
    g.indexes
      .filter((idx) => {
        return idx !== firstIdx
      })
      .forEach((idx) => {
        skipIndexes.add(idx)
      })
  })

  return bullets.flatMap((line, idx) => {
    if (skipIndexes.has(idx)) {
      return []
    }
    const combined = combinedByFirstIndex.get(idx) ?? null
    return combined ? [combined] : [line]
  })
}

const buildCompactItemSuffixFromLines = (lines: string[]): string | null => {
  if (lines.length === 0) {
    return null
  }

  const formatted = lines
    .map((line) => {
      const parsed = parseSimpleBulletLabelValue(line)
      return parsed ? `${parsed.label}: ${truncateInlineText(parsed.value, 140)}` : line.replace(/^\s*-\s*/, '').trim()
    })
    .filter((value) => {
      return value.length > 0
    })

  if (formatted.length === 0) {
    return null
  }

  return formatted.length === 1 && formatted[0]?.startsWith('value: ')
    ? formatted[0].slice('value: '.length)
    : `(${formatted.join('; ')})`
}

const buildCompactItemLine = ({
  event,
  sharedBullets,
  sharedRefs,
}: {
  event: TimelineEvent
  sharedBullets: string[]
  sharedRefs: string[]
}): string => {
  const label = event.display ? truncateInlineText(event.display, 260) : event.resourceType
  const uniqueBullets = event.bullets.filter((line) => {
    return !sharedBullets.includes(line)
  })
  const uniqueRefs = event.refBullets.filter((line) => {
    return !sharedRefs.includes(line)
  })
  const suffix = buildCompactItemSuffixFromLines([...uniqueBullets, ...uniqueRefs])
  return suffix ? (suffix.startsWith('(') ? `- ${label} ${suffix}` : `- ${label}: ${suffix}`) : `- ${label}`
}

const canGroupTimelineEvent = (event: TimelineEvent): boolean => {
  return event.resultBullets.length === 0 && event.noteKeysInOrder.length === 0
}

const buildCompactGroupSignature = (event: TimelineEvent): string | null => {
  if (!canGroupTimelineEvent(event)) {
    return null
  }

  return JSON.stringify({bucketDate: event.bucketDate, resourceType: event.resourceType})
}

const getSharedLines = (groups: string[][]): string[] => {
  const first = groups[0] ?? []
  return first.filter((line) => {
    return groups.every((group) => {
      return group.includes(line)
    })
  })
}

const pluralizeResourceType = (resourceType: string): string => {
  return resourceType.endsWith('y') ? `${resourceType.slice(0, -1)}ies` : `${resourceType}s`
}

const buildSingleEventLines = (event: TimelineEvent): string[] => {
  const resultBlockLines = event.resultBullets.length > 0 ? ['', ...event.resultBullets] : []
  return [
    event.display ? `#### ${event.resourceType}: ${event.display}` : `#### ${event.resourceType}`,
    ...event.bullets,
    ...(event.refBullets.length > 0 ? event.refBullets : []),
    ...resultBlockLines,
  ]
}

const buildEventGroupBlock = (events: TimelineEvent[]): TimelineRenderBlock => {
  const first = events[0] as TimelineEvent
  const sharedBullets = getSharedLines(
    events.map((event) => {
      return event.bullets
    }),
  )
  const sharedRefs = getSharedLines(
    events.map((event) => {
      return event.refBullets
    }),
  )
  const itemLines = events.map((event) => {
    return buildCompactItemLine({event, sharedBullets, sharedRefs})
  })

  return {
    kind: 'eventGroup',
    bucketDate: first.bucketDate,
    noteKeysInOrder: [],
    events,
    lines: [
      `#### ${pluralizeResourceType(first.resourceType)} (${events.length})`,
      ...sharedBullets,
      ...sharedRefs,
      ...itemLines,
    ],
  }
}

const collectMatchingCompactEvents = ({
  events,
  index,
  signature,
}: {
  events: TimelineEvent[]
  index: number
  signature: string
}): TimelineEvent[] => {
  const event = events[index] ?? null
  const eventSignature = event ? buildCompactGroupSignature(event) : null
  if (!event || !canGroupTimelineEvent(event) || eventSignature !== signature) {
    return []
  }

  return [event, ...collectMatchingCompactEvents({events, index: index + 1, signature})]
}

const hasUsefulSharedCompactMetadata = (events: TimelineEvent[]): boolean => {
  const sharedBullets = getSharedLines(
    events.map((event) => {
      return event.bullets
    }),
  )
  const sharedRefs = getSharedLines(
    events.map((event) => {
      return event.refBullets
    }),
  )

  return sharedBullets.length + sharedRefs.length > 0
}

const buildTimelineRenderBlocksFromIndex = (events: TimelineEvent[], index: number): TimelineRenderBlock[] => {
  const event = events[index] ?? null
  if (!event) {
    return []
  }

  if (!canGroupTimelineEvent(event)) {
    return [
      {
        kind: 'event',
        bucketDate: event.bucketDate,
        lines: buildSingleEventLines(event),
        noteKeysInOrder: event.noteKeysInOrder,
      },
      ...buildTimelineRenderBlocksFromIndex(events, index + 1),
    ]
  }

  const signature = buildCompactGroupSignature(event)
  const matchingEvents = signature ? collectMatchingCompactEvents({events, index, signature}) : [event]
  const block =
    matchingEvents.length > 1 && hasUsefulSharedCompactMetadata(matchingEvents)
      ? buildEventGroupBlock(matchingEvents)
      : {
          kind: 'event' as const,
          bucketDate: event.bucketDate,
          lines: buildSingleEventLines(event),
          noteKeysInOrder: event.noteKeysInOrder,
        }

  return [block, ...buildTimelineRenderBlocksFromIndex(events, index + matchingEvents.length)]
}

const buildTimelineRenderBlocks = (events: TimelineEvent[]): TimelineRenderBlock[] => {
  return buildTimelineRenderBlocksFromIndex(events, 0)
}

const buildConciseReferenceDisplayFromResource = ({
  resourceType,
  resource,
}: {
  resourceType: string
  resource: unknown
}): string | null => {
  if (!isRecordValue(resource)) {
    return null
  }

  if (resourceType === 'Practitioner') {
    const firstName = getFirstRecordOrNull(resource.name)
    const asHumanName = firstName ? buildHumanName(firstName) : null
    return asHumanName ? truncateInlineText(asHumanName, 160) : null
  }

  if (resourceType === 'Organization') {
    const name = getStringAtPath(resource, ['name'])
    return name ? truncateInlineText(name, 160) : null
  }

  if (resourceType === 'Location') {
    const name = getStringAtPath(resource, ['name'])
    return name ? truncateInlineText(name, 160) : null
  }

  if (resourceType === 'Encounter') {
    const type = getFirstCodeableConceptDisplay(resource, 'type')
    return type ? truncateInlineText(type, 160) : null
  }

  if (resourceType === 'Device') {
    const type = getCodeableConceptDisplay(resource.type)
    const name = getStringAtPath(resource, ['deviceName', '0', 'name'])
    const manufacturer = getStringAtPath(resource, ['manufacturer'])
    const model = getStringAtPath(resource, ['modelNumber'])
    const base = type ?? name ?? manufacturer ?? model
    return base ? truncateInlineText(base, 160) : null
  }

  return getEventDisplay({resourceType, resourceId: null, resource})
}

const extractConciseValueFromRenderedReference = (rendered: string): string | null => {
  const trimmed = rendered.trim()
  if (trimmed.length === 0) {
    return null
  }

  const asTypeColon = trimmed.match(/^[A-Z][A-Za-z]+:\s*(.+)$/)
  const colonValue = getStringOrNull(asTypeColon?.[1])
  if (colonValue) {
    return truncateInlineText(colonValue, 200)
  }

  const asTypeParen = trimmed.match(/^([A-Z][A-Za-z]+)\s*\((.*)\)$/)
  const inner = getStringOrNull(asTypeParen?.[2])
  if (!inner) {
    return null
  }

  const kv = inner
    .split(';')
    .map((p) => {
      const part = String(p ?? '').trim()
      const idx = part.indexOf(':')
      const key = idx > 0 ? part.slice(0, idx).trim() : ''
      const value = idx > 0 ? part.slice(idx + 1).trim() : ''
      return key && value ? {key, value} : null
    })
    .filter((v): v is {key: string; value: string} => {
      return Boolean(v)
    })

  const byKey = new Map<string, string>(
    kv.map((p) => {
      return [p.key, p.value]
    }),
  )

  const preferred = byKey.get('type') ?? byKey.get('name') ?? byKey.get('text') ?? null
  const fallback = preferred ?? inner
  return fallback ? truncateInlineText(fallback, 220) : null
}

const buildConciseReferenceValue = ({
  reference,
  display,
  renderRef,
  resourceByKey,
  identifierToKey,
}: {
  reference: string
  display: string | null
  renderRef: (ref: {reference: string; display: string | null}) => string
  resourceByKey: Map<string, unknown>
  identifierToKey: Map<string, string>
}): string | null => {
  const resolvedKey = resolveReferenceToKey({reference, identifierToKey})
  const resolvedType = resolvedKey ? getStringOrNull(resolvedKey.split('/')[0]) : null
  const resolvedResource = resolvedKey ? (resourceByKey.get(resolvedKey) ?? null) : null
  const fromResolved =
    resolvedType && resolvedResource
      ? buildConciseReferenceDisplayFromResource({resourceType: resolvedType, resource: resolvedResource})
      : null
  const displayTrimmed = getStringOrNull(display)
  const fromDisplay = displayTrimmed
    ? (extractConciseValueFromRenderedReference(displayTrimmed) ?? truncateInlineText(displayTrimmed, 200))
    : null
  if (fromResolved || fromDisplay) {
    return fromResolved ?? fromDisplay
  }

  const fallbackRendered = renderRef({reference, display})
  const extracted = extractConciseValueFromRenderedReference(fallbackRendered)
  const best = extracted ?? fallbackRendered
  return best && !isLowInfoRenderedReference(best) ? best : null
}

type ReferenceBulletCandidate = {label: string; value: string; path: string}

const buildReferenceBulletsForEvent = ({
  profile,
  patientId,
  eventResourceType,
  refs,
  bullets,
  renderRef,
  resourceByKey,
  identifierToKey,
}: {
  profile: FhirPatientMarkdownProfile
  patientId: string
  eventResourceType: string
  refs: ExtractedReference[]
  bullets: string[]
  renderRef: (ref: {reference: string; display: string | null}) => string
  resourceByKey: Map<string, unknown>
  identifierToKey: Map<string, string>
}): string[] => {
  const existingLabels = getExistingBulletLabels(bullets)

  const candidates = refs
    .filter((r) => {
      return r.path.length > 0
    })
    .filter((r) => {
      const normalized = normalizeFhirReferenceKey(r.reference)
      return !(normalized?.resourceType === 'Patient' && normalized.id === patientId)
    })
    .filter((r) => {
      return !(eventResourceType === 'DiagnosticReport' && /^result\[\d+\]$/.test(r.path))
    })
    .map((r) => {
      const label = buildHumanReferenceLabel(r.path).trim().toLowerCase()
      const value = buildConciseReferenceValue({
        reference: r.reference,
        display: r.display,
        renderRef,
        resourceByKey,
        identifierToKey,
      })
      return label && value ? ({label, value, path: r.path} satisfies ReferenceBulletCandidate) : null
    })
    .filter((v): v is ReferenceBulletCandidate => {
      return Boolean(v)
    })
    .filter((r) => {
      return r.label.length > 0
    })
    .filter((r) => {
      return existingLabels.has(r.label) ? false : true
    })
    .filter((r) => {
      return profile === 'summary' ? isAllowedSummaryReferenceLabel(r.label) : true
    })
    .sort((a, b) => {
      const byLabel = a.label.localeCompare(b.label)
      return byLabel !== 0 ? byLabel : a.path.localeCompare(b.path)
    })

  const uniqueByLabelValue = candidates.reduce<ReferenceBulletCandidate[]>((acc, r) => {
    const key = `${r.label}::${r.value}`
    const exists = acc.some((x) => {
      return `${x.label}::${x.value}` === key
    })
    return exists ? acc : [...acc, r]
  }, [])

  const grouped = uniqueByLabelValue.reduce<{value: string; labels: string[]}[]>((acc, r) => {
    const existing = acc.find((g) => {
      return g.value === r.value
    })
    if (!existing) {
      return [...acc, {value: r.value, labels: [r.label]}]
    }
    const nextLabels = existing.labels.includes(r.label) ? existing.labels : [...existing.labels, r.label]
    return acc.map((g) => {
      return g.value === r.value ? {value: g.value, labels: nextLabels} : g
    })
  }, [])

  return grouped.map((g) => {
    const labelText = g.labels.join(', ')
    return `- ${labelText}: ${g.value}`
  })
}

type DedupedNoteGroup = {key: string; canonicalText: string; truncated: boolean; sources: string[]}

const addUniqueString = (list: string[], value: string): string[] => {
  return list.includes(value) ? list : [...list, value]
}

const fnv1a32 = (value: string): number => {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

const buildNoteDedupKey = (canonicalText: string): string => {
  const normalized = canonicalText.replace(/\s+/g, ' ').trim()
  const hash = fnv1a32(normalized).toString(16).padStart(8, '0')
  return `${normalized.length}:${hash}`
}

const isPreferredNoteCandidate = ({
  current,
  candidate,
}: {
  current: {canonicalText: string; truncated: boolean}
  candidate: {canonicalText: string; truncated: boolean}
}): boolean => {
  if (current.truncated && !candidate.truncated) {
    return true
  }
  if (!current.truncated && candidate.truncated) {
    return false
  }
  return candidate.canonicalText.length > current.canonicalText.length
}

const upsertDedupedNoteGroup = ({
  groups,
  note,
  bucketDate,
  renderRef,
}: {
  groups: Map<string, DedupedNoteGroup>
  note: FhirDecodedNote
  bucketDate: string
  renderRef: (ref: {reference: string; display: string | null}) => string
}): string | null => {
  const canonicalText = buildCanonicalNoteText({note, bucketDate, renderRef})
  if (!canonicalText) {
    return null
  }

  const key = buildNoteDedupKey(canonicalText)
  const source = getNoteSourceLabel(note.path)
  const existing = groups.get(key) ?? null
  const nextSources = source ? addUniqueString(existing?.sources ?? [], source) : (existing?.sources ?? [])

  if (!existing) {
    groups.set(key, {key, canonicalText, truncated: note.truncated, sources: nextSources})
    return key
  }

  const shouldReplace = isPreferredNoteCandidate({
    current: {canonicalText: existing.canonicalText, truncated: existing.truncated},
    candidate: {canonicalText, truncated: note.truncated},
  })
  const updated = shouldReplace
    ? {key, canonicalText, truncated: note.truncated, sources: nextSources}
    : {key, canonicalText: existing.canonicalText, truncated: existing.truncated, sources: nextSources}
  groups.set(key, updated)
  return key
}

const uniqueInOrder = (values: string[]): string[] => {
  return values.reduce<{seen: Set<string>; out: string[]}>(
    (acc, v) => {
      if (acc.seen.has(v)) {
        return acc
      }
      acc.seen.add(v)
      acc.out.push(v)
      return acc
    },
    {seen: new Set<string>(), out: []},
  ).out
}

const renderDedupedNoteGroupLines = ({
  profile: _profile,
  group,
}: {
  profile: FhirPatientMarkdownProfile
  group: DedupedNoteGroup
}): string[] => {
  const textLines = group.canonicalText.split('\n')

  if (textLines.length === 0) {
    return []
  }

  const sources = [...group.sources].sort((a, b) => {
    return a.localeCompare(b)
  })
  const truncatedSuffix = group.truncated ? ' | truncated=true' : ''
  const header =
    sources.length === 1 ? `##### Note (${sources[0] ?? ''})${truncatedSuffix}` : `##### Note${truncatedSuffix}`
  const sourceLines = sources.length > 1 ? [`- sources: ${sources.join(', ')}`] : []
  const bodyLines = textLines.map((l) => {
    return l.trimEnd()
  })
  return [header, ...(sourceLines.length > 0 ? sourceLines : []), '', ...bodyLines]
}

const buildDedupedNoteLinesForEvent = ({
  profile,
  noteKeysInOrder,
  groups,
  renderedKeys,
}: {
  profile: FhirPatientMarkdownProfile
  noteKeysInOrder: string[]
  groups: Map<string, DedupedNoteGroup>
  renderedKeys: Set<string>
}): string[] => {
  const uniqueKeys = uniqueInOrder(noteKeysInOrder)

  return uniqueKeys.reduce<{count: number; out: string[]}>(
    (acc, key) => {
      if (renderedKeys.has(key)) {
        return acc
      }
      const group = groups.get(key) ?? null
      if (!group) {
        return acc
      }
      const rendered = renderDedupedNoteGroupLines({profile, group})
      if (rendered.length === 0) {
        return acc
      }
      renderedKeys.add(key)
      const next = acc.count === 0 ? rendered : ['', ...rendered]
      return {count: acc.count + 1, out: [...acc.out, ...next]}
    },
    {count: 0, out: []},
  ).out
}

const buildTimelineLines = ({
  profile,
  patientId,
  entries,
  renderRef,
  resourceByKey,
  identifierToKey,
}: {
  profile: FhirPatientMarkdownProfile
  patientId: string
  entries: FhirPatientMarkdownEntry[]
  renderRef: (ref: {reference: string; display: string | null}) => string
  resourceByKey: Map<string, unknown>
  identifierToKey: Map<string, string>
}): string[] => {
  const noteGroups = new Map<string, DedupedNoteGroup>()

  const events = entries
    .filter((e) => {
      return e.resourceType !== 'Patient'
    })
    .map((entry) => {
      const parsed = tryJsonParse(entry.rawLine)
      const resource = parsed.ok ? parsed.value : null
      const sortMs = getSortMsFromSortDate(entry.sortDate)
      const bucketDate = getBucketDateFromSort(sortMs, entry.sortDate)
      const display = getEventDisplay({resourceType: entry.resourceType, resourceId: entry.resourceId, resource})
      const bulletsRaw = buildEventBullets({
        profile,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        resource,
        sortDate: entry.sortDate,
      })

      const refs = parsed.ok && parsed.value ? extractReferencesFromResource(parsed.value) : []

      const resultBullets =
        entry.resourceType === 'DiagnosticReport'
          ? buildDiagnosticReportResultsBlockLines({resource, renderRef, resourceByKey, identifierToKey})
          : []

      const refBullets = buildReferenceBulletsForEvent({
        profile,
        patientId,
        eventResourceType: entry.resourceType,
        refs,
        bullets: bulletsRaw,
        renderRef,
        resourceByKey,
        identifierToKey,
      })

      const bullets = collapseDuplicateRoleBullets(bulletsRaw)

      const noteKeysInOrder = entry.decodedNotes
        .map((note) => {
          return upsertDedupedNoteGroup({groups: noteGroups, note, bucketDate, renderRef})
        })
        .filter((v): v is string => {
          return Boolean(v)
        })

      return {
        sortMs,
        bucketDate,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        display,
        bullets,
        resultBullets,
        refBullets,
        noteKeysInOrder,
      } satisfies TimelineEvent
    })
    .filter((e) => {
      const hasAny =
        Boolean(e.display)
        || e.bullets.length > 0
        || e.refBullets.length > 0
        || e.resultBullets.length > 0
        || e.noteKeysInOrder.length > 0
      return hasAny
    })
    .sort(compareTimelineEvents)

  const lines: string[] = []
  let currentBucket: string | null = null
  const renderedNoteKeys = new Set<string>()
  const renderBlocks = buildTimelineRenderBlocks(events)

  renderBlocks.forEach((block) => {
    if (block.bucketDate !== currentBucket) {
      if (lines.length > 0) {
        lines.push('')
      }
      lines.push(`### ${block.bucketDate}`)
      currentBucket = block.bucketDate
    }

    if (lines.length > 0) {
      lines.push('')
    }

    lines.push(...block.lines)

    const noteLines = buildDedupedNoteLinesForEvent({
      profile,
      noteKeysInOrder: block.noteKeysInOrder,
      groups: noteGroups,
      renderedKeys: renderedNoteKeys,
    })

    if (noteLines.length > 0) {
      lines.push('')
      lines.push(...noteLines)
    }
  })

  return lines.filter((l) => {
    return typeof l === 'string'
  })
}

const demoteMarkdownHeadingsToH6 = (text: string): string => {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  return lines
    .map((line) => {
      const match = line.match(/^(\s{0,3})(#{1,6})(\s*)(.*)$/)
      if (!match) {
        return line
      }
      const after = String(match[4] ?? '').trim()
      return after.length > 0 ? `###### ${after}` : '######'
    })
    .join('\n')
}

const getFenceRunLength = (line: string): number | null => {
  const match = line.match(/^\s*(`{3,})([^`]*)$/)
  return match ? (match[1]?.length ?? null) : null
}

const ensureFencesClosed = (text: string): string => {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let openRun: number | null = null

  lines.forEach((line) => {
    const run = getFenceRunLength(line)
    if (run === null) {
      return
    }
    openRun = openRun === null ? run : run >= openRun ? null : openRun
  })

  if (openRun === null) {
    return lines.join('\n')
  }

  const closing = '`'.repeat(openRun)
  return `${lines.join('\n')}\n${closing}`
}

const FHIR_RESOURCE_TYPES = new Set([
  'Account',
  'ActivityDefinition',
  'AdverseEvent',
  'AllergyIntolerance',
  'Appointment',
  'AppointmentResponse',
  'AuditEvent',
  'Basic',
  'Binary',
  'BiologicallyDerivedProduct',
  'BodyStructure',
  'Bundle',
  'CapabilityStatement',
  'CarePlan',
  'CareTeam',
  'CatalogEntry',
  'ChargeItem',
  'ChargeItemDefinition',
  'Claim',
  'ClaimResponse',
  'ClinicalImpression',
  'CodeSystem',
  'Communication',
  'CommunicationRequest',
  'CompartmentDefinition',
  'Composition',
  'ConceptMap',
  'Condition',
  'Consent',
  'Contract',
  'Coverage',
  'CoverageEligibilityRequest',
  'CoverageEligibilityResponse',
  'DetectedIssue',
  'Device',
  'DeviceDefinition',
  'DeviceMetric',
  'DeviceRequest',
  'DeviceUseStatement',
  'DiagnosticReport',
  'DocumentManifest',
  'DocumentReference',
  'EffectEvidenceSynthesis',
  'Encounter',
  'Endpoint',
  'EnrollmentRequest',
  'EnrollmentResponse',
  'EpisodeOfCare',
  'EventDefinition',
  'Evidence',
  'EvidenceVariable',
  'ExampleScenario',
  'ExplanationOfBenefit',
  'FamilyMemberHistory',
  'Flag',
  'Goal',
  'GraphDefinition',
  'Group',
  'GuidanceResponse',
  'HealthcareService',
  'ImagingStudy',
  'Immunization',
  'ImmunizationEvaluation',
  'ImmunizationRecommendation',
  'ImplementationGuide',
  'InsurancePlan',
  'Invoice',
  'Library',
  'Linkage',
  'List',
  'Location',
  'Measure',
  'MeasureReport',
  'Media',
  'Medication',
  'MedicationAdministration',
  'MedicationDispense',
  'MedicationKnowledge',
  'MedicationRequest',
  'MedicationStatement',
  'MedicinalProduct',
  'MedicinalProductAuthorization',
  'MedicinalProductContraindication',
  'MedicinalProductIndication',
  'MedicinalProductIngredient',
  'MedicinalProductInteraction',
  'MedicinalProductManufactured',
  'MedicinalProductPackaged',
  'MedicinalProductPharmaceutical',
  'MedicinalProductUndesirableEffect',
  'MessageDefinition',
  'MessageHeader',
  'MolecularSequence',
  'NamingSystem',
  'NutritionOrder',
  'Observation',
  'ObservationDefinition',
  'OperationDefinition',
  'OperationOutcome',
  'Organization',
  'OrganizationAffiliation',
  'Parameters',
  'Patient',
  'PaymentNotice',
  'PaymentReconciliation',
  'Person',
  'PlanDefinition',
  'Practitioner',
  'PractitionerRole',
  'Procedure',
  'Provenance',
  'Questionnaire',
  'QuestionnaireResponse',
  'RelatedPerson',
  'RequestGroup',
  'ResearchDefinition',
  'ResearchElementDefinition',
  'ResearchStudy',
  'ResearchSubject',
  'RiskAssessment',
  'RiskEvidenceSynthesis',
  'Schedule',
  'SearchParameter',
  'ServiceRequest',
  'Slot',
  'Specimen',
  'SpecimenDefinition',
  'StructureDefinition',
  'StructureMap',
  'Subscription',
  'Substance',
  'SubstanceNucleicAcid',
  'SubstancePolymer',
  'SubstanceProtein',
  'SubstanceReferenceInformation',
  'SubstanceSourceMaterial',
  'SubstanceSpecification',
  'SupplyDelivery',
  'SupplyRequest',
  'Task',
  'TerminologyCapabilities',
  'TestReport',
  'TestScript',
  'ValueSet',
  'VerificationResult',
  'VisionPrescription',
])

const isFhirResourceType = (value: string): boolean => {
  return FHIR_RESOURCE_TYPES.has(value)
}

const splitTrailingPunctuation = (value: string): {core: string; suffix: string} => {
  const match = value.match(/^(.*?)([)\].,;:}]*)$/)
  const core = String(match?.[1] ?? value)
  const suffix = String(match?.[2] ?? '')
  return {core, suffix}
}

const inlineIdentifierQueryReferencesInLine = (
  line: string,
  renderRef: (ref: {reference: string; display: string | null}) => string,
): string => {
  return line.replace(/(?<!`)\b([A-Z][a-z][A-Za-z]+\?identifier=[^\s`"']+)(?!`)/g, (m) => {
    const split = splitTrailingPunctuation(m)
    const resourceType = String(split.core.split('?')[0] ?? '').trim()
    if (!isFhirResourceType(resourceType)) {
      return m
    }
    const replaced = renderRef({reference: split.core, display: null})
    return `${replaced}${split.suffix}`
  })
}

const inlineTypeIdReferencesInLine = (
  line: string,
  renderRef: (ref: {reference: string; display: string | null}) => string,
): string => {
  return line.replace(
    /(?<!`)\b([A-Z][a-z][A-Za-z]+\/[A-Za-z0-9.-]{1,64}(?:\/_history\/[A-Za-z0-9.-]{1,64})?)\b(?!`)/g,
    (m) => {
      const resourceType = String(m.split('/')[0] ?? '').trim()
      if (!isFhirResourceType(resourceType)) {
        return m
      }
      return renderRef({reference: m, display: null})
    },
  )
}

const inlineReferencesInMarkdown = (
  text: string,
  renderRef: (ref: {reference: string; display: string | null}) => string,
): string => {
  const lines = text.replace(/\r\n/g, '\n').split('\n')

  const replaced = lines.map((line) => {
    const run = getFenceRunLength(line)
    if (run !== null) {
      return line
    }

    const withQuery = inlineIdentifierQueryReferencesInLine(line, renderRef)
    return inlineTypeIdReferencesInLine(withQuery, renderRef)
  })

  return replaced.join('\n')
}

const stripLeadingBucketDateLine = ({text, bucketDate}: {text: string; bucketDate: string}): string => {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const first = String(lines[0] ?? '').trim()
  const rest = lines.slice(1).join('\n').trim()
  if (rest.length === 0) {
    return text
  }

  const isDateBucket = /^\d{4}-\d{2}-\d{2}$/.test(bucketDate)
  const bucketPattern = isDateBucket ? new RegExp(`^${bucketDate}(?:\\s*[:\\-]\\s*)?$`) : null
  const isBucketLine = bucketPattern ? bucketPattern.test(first) : false
  const isIsoDateLine = /^\d{4}-\d{2}-\d{2}(?:\s*[:-]\s*)?$/.test(first)
  const shouldStrip = isBucketLine || isIsoDateLine

  return shouldStrip ? rest : text
}

const getNoteSourceLabel = (path: string): string | null => {
  const match = path.match(/^([A-Z][A-Za-z]+)/)
  return match ? getStringOrNull(match[1]) : null
}

const NOTE_SECTION_HEADINGS = [
  'Chief Complaint',
  'History of Present Illness',
  'Social History',
  'Allergies',
  'Medications',
  'Assessment and Plan',
] as const

type NoteSectionHeading = (typeof NOTE_SECTION_HEADINGS)[number]

const escapeRegex = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const NOTE_SECTION_CANONICAL_BY_LOWER = new Map<string, NoteSectionHeading>(
  NOTE_SECTION_HEADINGS.map((h) => {
    return [h.toLowerCase(), h]
  }),
)

const NOTE_SECTION_REGEX = new RegExp(
  `(?:^|[.!?]\\s+)(${NOTE_SECTION_HEADINGS.map((h) => {
    return escapeRegex(h)
  }).join('|')})\\b`,
  'gi',
)

const splitNoteIntoSentenceLikeParts = (text: string): string[] => {
  const normalized = normalizeInlineText(text)
  const withSemicolons = normalized.replace(/;\s*/g, '\n')
  const withBreaks = withSemicolons.replace(/([.!?])\s+(?=[A-Z])/g, '$1\n')
  return withBreaks
    .split('\n')
    .map((m) => {
      return String(m ?? '').trim()
    })
    .filter((m) => {
      return m.length > 0
    })
}

const stripRedundantAssessmentPlanPrefix = (text: string): string => {
  return text.replace(/^Plan\s+(?=(?:The patient|Patient)\b)/i, '').trim()
}

type SectionedNotePart = {heading: NoteSectionHeading; body: string}

type NoteSectionOccurrence = {heading: NoteSectionHeading; start: number; end: number}

const parseSectionedNarrativeNoteParts = (text: string): SectionedNotePart[] => {
  const matches = Array.from(text.matchAll(NOTE_SECTION_REGEX))

  const occurrences = matches
    .map((m) => {
      const rawHeading = getStringOrNull(m[1])
      const heading = rawHeading ? (NOTE_SECTION_CANONICAL_BY_LOWER.get(rawHeading.toLowerCase()) ?? null) : null
      const matchStart = typeof m.index === 'number' ? m.index : null
      const fullMatch = String(m[0] ?? '')
      const headingStart =
        matchStart !== null && rawHeading ? matchStart + Math.max(0, fullMatch.length - rawHeading.length) : null
      const headingEnd = headingStart !== null && rawHeading ? headingStart + rawHeading.length : null
      return heading && headingStart !== null && headingEnd !== null
        ? {heading, start: headingStart, end: headingEnd}
        : null
    })
    .filter((v): v is NoteSectionOccurrence => {
      return Boolean(v)
    })

  if (occurrences.length < 2) {
    return []
  }

  const firstStart = occurrences[0]?.start ?? 0
  if (firstStart > 30) {
    return []
  }

  return occurrences
    .map((occ, idx) => {
      const nextStart = occurrences[idx + 1]?.start ?? text.length
      const rawBody = text.slice(occ.end, nextStart).trim()
      const body = occ.heading === 'Assessment and Plan' ? stripRedundantAssessmentPlanPrefix(rawBody) : rawBody
      return body.length > 0 ? ({heading: occ.heading, body} satisfies SectionedNotePart) : null
    })
    .filter((v): v is SectionedNotePart => {
      return Boolean(v)
    })
}

const formatSectionedNarrativeNoteBlobAsMarkdown = (text: string): string | null => {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (normalized.length === 0) {
    return null
  }
  if (normalized.includes('\n')) {
    return null
  }

  const parts = parseSectionedNarrativeNoteParts(normalized)
  if (parts.length === 0) {
    return null
  }

  const lines = parts.flatMap((part, idx) => {
    const bodyNormalized = normalizeInlineText(part.body)
    const statements = splitNoteIntoSentenceLikeParts(bodyNormalized)
    const bodyLines = statements.map((s) => {
      return `- ${s}`
    })
    const block = [`###### ${part.heading}`, ...(bodyLines.length > 0 ? bodyLines : [`- ${bodyNormalized}`])]
    return idx === 0 ? block : ['', ...block]
  })

  const joined = lines.join('\n').trim()
  return joined.length > 0 ? joined : null
}

const buildCanonicalNoteText = ({
  note,
  bucketDate,
  renderRef,
}: {
  note: FhirDecodedNote
  bucketDate: string
  renderRef: (ref: {reference: string; display: string | null}) => string
}): string | null => {
  const raw = String(note.text ?? '')
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return null
  }

  const stripped = stripLeadingBucketDateLine({text: trimmed, bucketDate}).trim()
  if (stripped.length === 0) {
    return null
  }

  const formatted = formatSectionedNarrativeNoteBlobAsMarkdown(stripped) ?? stripped

  const demoted = demoteMarkdownHeadingsToH6(formatted)
  const inlined = inlineReferencesInMarkdown(demoted, renderRef)
  const fenced = ensureFencesClosed(inlined)
  const finalLines = fenced.split('\n').map((l) => {
    return l.trimEnd()
  })
  const finalText = finalLines.join('\n').trim()
  return finalText.length > 0 ? finalText : null
}

const validateFhirPatientMarkdown = (markdown: string): string[] => {
  const errors: string[] = []
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')

  let openRun: number | null = null
  const headings: {level: number; text: string; line: number}[] = []

  lines.forEach((line, idx) => {
    const run = getFenceRunLength(line)
    if (run !== null) {
      openRun = openRun === null ? run : run >= openRun ? null : openRun
      return
    }
    if (openRun !== null) {
      return
    }

    const match = line.match(/^(#{1,6})\s+(.*)$/)
    if (!match) {
      return
    }
    const level = match[1]?.length ?? 0
    const text = String(match[2] ?? '').trim()
    headings.push({level, text, line: idx + 1})
  })

  if (openRun !== null) {
    errors.push('unmatched_fence')
  }

  const h1 = headings.filter((h) => {
    return h.level === 1
  })
  if (h1.length !== 1) {
    errors.push(`h1_count:${h1.length}`)
  }

  const h2 = headings.filter((h) => {
    return h.level === 2
  })
  const h2Texts = h2.map((h) => {
    return h.text
  })
  const hasPatient = h2Texts.includes('Patient')
  const hasTimeline = h2Texts.includes('Timeline')
  if (!hasPatient || !hasTimeline) {
    errors.push('missing_patient_or_timeline_h2')
  }
  const extraH2 = h2Texts.filter((t) => {
    return t !== 'Patient' && t !== 'Timeline'
  })
  if (extraH2.length > 0) {
    errors.push(`unexpected_h2:${extraH2.join(',')}`)
  }

  const patientIdx = h2.findIndex((h) => {
    return h.text === 'Patient'
  })
  const timelineIdx = h2.findIndex((h) => {
    return h.text === 'Timeline'
  })
  if (patientIdx !== -1 && timelineIdx !== -1 && patientIdx > timelineIdx) {
    errors.push('h2_order')
  }

  const hasBadJump = headings.some((h, i) => {
    const prev = headings[i - 1]
    if (!prev) {
      return false
    }
    return h.level - prev.level > 1
  })
  if (hasBadJump) {
    errors.push('heading_jump')
  }

  const typeIdPattern = /\b([A-Z][a-z][A-Za-z]+\/[A-Za-z0-9.-]{1,64}(?:\/_history\/[A-Za-z0-9.-]{1,64})?)\b/g
  const identifierQueryPattern = /\b([A-Z][a-z][A-Za-z]+\?identifier=[^\s`"']+)/g
  const refTokens = lines.flatMap((line) => {
    const isFenceMarker = getFenceRunLength(line) !== null
    if (isFenceMarker) {
      return []
    }

    const typeIds = Array.from(line.matchAll(typeIdPattern))
      .map((m) => {
        return m[1] ?? null
      })
      .filter((v): v is string => {
        return Boolean(v)
      })
      .filter((token) => {
        const resourceType = String(token.split('/')[0] ?? '').trim()
        return isFhirResourceType(resourceType)
      })

    const queryRefs = Array.from(line.matchAll(identifierQueryPattern))
      .map((m) => {
        const raw = String(m[1] ?? '').trim()
        const split = splitTrailingPunctuation(raw)
        return split.core.trim().length > 0 ? split.core : null
      })
      .filter((v): v is string => {
        return Boolean(v)
      })
      .filter((token) => {
        const resourceType = String(token.split('?')[0] ?? '').trim()
        return isFhirResourceType(resourceType)
      })

    return [...typeIds, ...queryRefs]
  })

  if (refTokens.length > 0) {
    errors.push(`ref_tokens:${refTokens.slice(0, 5).join(',')}`)
  }

  return errors
}

const validateFhirPatientSummaryMarkdown = (markdown: string): string[] => {
  const base = validateFhirPatientMarkdown(markdown)
  const errors = [...base]

  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  let openRun: number | null = null

  lines.forEach((line) => {
    const run = getFenceRunLength(line)
    if (run !== null) {
      openRun = openRun === null ? run : run >= openRun ? null : openRun
      return
    }
    if (openRun !== null) {
      return
    }

    if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(line)) {
      errors.push('uuid_token')
    }
    if (/\bsystem=https?:\/\//i.test(line)) {
      errors.push('system_url')
    }
    if (/\[\d+\]/.test(line)) {
      errors.push('array_index_token')
    }
    if (/^\s*-\s*id:\s*/i.test(line)) {
      errors.push('id_bullet')
    }
  })

  const unique = errors.reduce<string[]>((acc, e) => {
    return acc.includes(e) ? acc : [...acc, e]
  }, [])
  return unique
}
