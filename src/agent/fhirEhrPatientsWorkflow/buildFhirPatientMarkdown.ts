type JsonParseResult = {ok: true; value: unknown} | {ok: false; error: string}

export type FhirDecodedNote = {path: string; text: string; truncated: boolean}

export type FhirPatientMarkdownEntry = {
  resourceType: string
  resourceId: string | null
  sortDate: string | null
  rawLine: string
  decodedNotes: FhirDecodedNote[]
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
}): {markdown: string; validationErrors: string[]} => {
  const patientEntry =
    entries.find((e) => {
      return e.resourceType === 'Patient'
    }) ?? null

  const {resourceByKey, contextByKey, identifierToKey} = buildResourceIndex(entries)
  const renderRef = ({reference, display}: {reference: string; display: string | null}): string => {
    return renderInlineReference({reference, display, contextByKey, identifierToKey})
  }

  const patientSectionLines = buildPatientSectionLines({patientId, patientEntry})

  const timelineLines = buildTimelineLines({patientId, entries, renderRef, resourceByKey, identifierToKey})

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

  const markdown = `${markdownLines.join('\n').trimEnd()}\n`
  const validationErrors = validateFhirPatientMarkdown(markdown)
  return {markdown, validationErrors}
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

const truncateInlineText = (value: string, maxLen: number): string => {
  const normalized = normalizeInlineText(value)
  if (normalized.length <= maxLen) {
    return normalized
  }
  const head = normalized.slice(0, Math.max(0, maxLen - 3)).trimEnd()
  return `${head}...`
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
  resource,
  resourceId,
  sortDate,
}: {
  resource: unknown
  resourceId: string | null
  sortDate: string | null
}): string[] => {
  const sortValue = getStringOrNull(sortDate)
  const candidates = getTimeCandidatesFromResource(resource)
  const timeValue = sortValue ?? candidates[0]?.value ?? null
  if (!timeValue) {
    return []
  }

  const sources = getUniqueTimeSourcesForValue(candidates, timeValue)
  const labelSources = sources.length > 0 ? sources : sortValue ? ['sortDate'] : []
  const label = labelSources.length > 0 ? `time(${labelSources.join(', ')})` : 'time'
  const timeLine = `- ${label}: ${truncateInlineText(timeValue, 120)}`
  const idLine = resourceId ? `- id: \`${resourceId}\`` : null
  return [timeLine, ...(idLine ? [idLine] : [])]
}

const buildEventBullets = ({
  resourceType,
  resourceId,
  resource,
  sortDate,
}: {
  resourceType: string
  resourceId: string | null
  resource: unknown
  sortDate: string | null
}): string[] => {
  const base = buildTimeAndIdBullet({resource, resourceId, sortDate})

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
  resourceId,
  resource,
}: {
  resourceType: string
  resourceId: string | null
  resource: unknown
}): string => {
  if (!isRecordValue(resource)) {
    return resourceId ?? 'Event'
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

  return display ? truncateInlineText(display, 140) : (resourceId ?? 'Event')
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
  patientId,
  patientEntry,
}: {
  patientId: string
  patientEntry: FhirPatientMarkdownEntry | null
}): string[] => {
  const base = patientEntry ? [] : [`- patient_id: \`${patientId}\``]

  const parsed = patientEntry ? tryJsonParse(patientEntry.rawLine) : {ok: false as const, error: 'missing'}
  const resource = parsed.ok ? parsed.value : null
  if (!isRecordValue(resource)) {
    return base
  }

  const names = getArrayOrEmpty(resource.name)
    .map((n) => {
      return isRecordValue(n) ? buildHumanName(n) : null
    })
    .filter((v): v is string => {
      return Boolean(v)
    })

  const nameLines = names.flatMap((name, idx) => {
    return idx === 0 ? buildBullet('name', name) : [`- name[${idx}]: ${truncateInlineText(name, 250)}`]
  })

  const gender = getStringAtPath(resource, ['gender'])
  const birthDate = getStringAtPath(resource, ['birthDate'])
  const deceasedBoolean = getStringAtPath(resource, ['deceasedBoolean'])
  const deceasedDateTime = getStringAtPath(resource, ['deceasedDateTime'])
  const deceased = deceasedDateTime ?? deceasedBoolean

  const identifiers = getArrayOrEmpty(resource.identifier)
    .map((ident) => {
      return isRecordValue(ident) ? buildIdentifierText(ident) : null
    })
    .filter((v): v is string => {
      return Boolean(v)
    })
    .flatMap((text, idx) => {
      const normalized = normalizeInlineText(text)
      return idx === 0 ? [`- identifier: ${normalized}`] : [`- identifier[${idx}]: ${normalized}`]
    })

  const telecom = getArrayOrEmpty(resource.telecom)
    .map((t) => {
      return isRecordValue(t) ? buildTelecomText(t) : null
    })
    .filter((v): v is string => {
      return Boolean(v)
    })
    .flatMap((text, idx) => {
      const normalized = normalizeInlineText(text)
      return idx === 0 ? [`- telecom: ${normalized}`] : [`- telecom[${idx}]: ${normalized}`]
    })

  const addresses = getArrayOrEmpty(resource.address)
    .map((a) => {
      return isRecordValue(a) ? buildAddressText(a) : null
    })
    .filter((v): v is string => {
      return Boolean(v)
    })
    .flatMap((text, idx) => {
      const normalized = normalizeInlineText(text)
      return idx === 0 ? [`- address: ${normalized}`] : [`- address[${idx}]: ${normalized}`]
    })

  return [
    ...base,
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

const buildIdentifierText = (ident: Record<string, unknown>): string | null => {
  const system = getStringOrNull(ident.system)
  const value = getStringOrNull(ident.value)
  const use = getStringOrNull(ident.use)
  const type = getCodeableConceptDisplay(ident.type)
  const joined = joinNonEmptyParts(
    [
      system ? `system=${system}` : null,
      value ? `value=${value}` : null,
      type ? `type=${type}` : null,
      use ? `use=${use}` : null,
    ],
    ' | ',
  )
  return joined.length > 0 ? joined : null
}

const buildTelecomText = (telecom: Record<string, unknown>): string | null => {
  const system = getStringOrNull(telecom.system)
  const value = getStringOrNull(telecom.value)
  const use = getStringOrNull(telecom.use)
  const joined = joinNonEmptyParts(
    [system ? `system=${system}` : null, value ? `value=${value}` : null, use ? `use=${use}` : null],
    ' | ',
  )
  return joined.length > 0 ? joined : null
}

const buildAddressText = (address: Record<string, unknown>): string | null => {
  const use = getStringOrNull(address.use)
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
  const joined = joinNonEmptyParts(
    [use ? `use=${use}` : null, lines ? `line=${lines}` : null, locality ? `locality=${locality}` : null],
    ' | ',
  )
  return joined.length > 0 ? joined : null
}

type TimelineEvent = {
  sortMs: number | null
  bucketDate: string
  resourceType: string
  resourceId: string | null
  display: string
  bullets: string[]
  resultBullets: string[]
  refBullets: string[]
  noteLines: string[]
}

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
  const t = aMs !== null && bMs !== null ? aMs - bMs : aMs !== null ? -1 : bMs !== null ? 1 : 0
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

  const headerParts = [`results (${items.length})`]
  if (sharedStatus) {
    headerParts.push(`status: ${truncateInlineText(sharedStatus, 40)}`)
  }
  if (sharedIssued) {
    headerParts.push(`issued: ${truncateInlineText(sharedIssued, 120)}`)
  }

  const headerLine = `- ${headerParts.join(' | ')}`
  const itemLines = items.map((i) => {
    const extras = [
      sharedStatus ? null : i.status ? `status: ${truncateInlineText(i.status, 40)}` : null,
      sharedIssued ? null : i.issued ? `issued: ${truncateInlineText(i.issued, 120)}` : null,
    ].filter((v): v is string => {
      return Boolean(v)
    })
    const suffix = extras.length > 0 ? ` (${extras.join('; ')})` : ''
    return `  - ${i.text}${suffix}`
  })

  return [headerLine, ...itemLines]
}

const buildTimelineLines = ({
  patientId,
  entries,
  renderRef,
  resourceByKey,
  identifierToKey,
}: {
  patientId: string
  entries: FhirPatientMarkdownEntry[]
  renderRef: (ref: {reference: string; display: string | null}) => string
  resourceByKey: Map<string, unknown>
  identifierToKey: Map<string, string>
}): string[] => {
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
      const bullets = buildEventBullets({
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
      const refBullets = refs
        .filter((r) => {
          return r.path.length > 0
        })
        .filter((r) => {
          const normalized = normalizeFhirReferenceKey(r.reference)
          return !(normalized?.resourceType === 'Patient' && normalized.id === patientId)
        })
        .filter((r) => {
          return !(entry.resourceType === 'DiagnosticReport' && /^result\[\d+\]$/.test(r.path))
        })
        .map((r) => {
          const rendered = renderRef({reference: r.reference, display: r.display})
          return {path: r.path, rendered}
        })
        .sort((a, b) => {
          return a.path.localeCompare(b.path)
        })
        .map((r) => {
          return `- ${r.path}: ${r.rendered}`
        })

      const noteLines = entry.decodedNotes.flatMap((note, idx) => {
        const rendered = renderDecodedNoteLines({note, bucketDate, renderRef})
        return idx === 0 ? rendered : rendered.length > 0 ? ['', ...rendered] : []
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
        noteLines,
      } satisfies TimelineEvent
    })
    .sort(compareTimelineEvents)

  const lines: string[] = []
  let currentBucket: string | null = null

  events.forEach((event) => {
    if (event.bucketDate !== currentBucket) {
      if (lines.length > 0) {
        lines.push('')
      }
      lines.push(`### ${event.bucketDate}`)
      currentBucket = event.bucketDate
    }

    if (lines.length > 0) {
      lines.push('')
    }

    lines.push(`#### ${event.resourceType}: ${event.display}`)
    lines.push(...event.bullets)
    lines.push(...(event.resultBullets.length > 0 ? event.resultBullets : []))
    lines.push(...(event.refBullets.length > 0 ? event.refBullets : []))

    if (event.noteLines.length > 0) {
      lines.push('')
      lines.push(...event.noteLines)
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
  const match = value.match(/^(.*?)([)\].,;:\}]*)$/)
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
  const isDateBucket = /^\d{4}-\d{2}-\d{2}$/.test(bucketDate)
  if (!isDateBucket) {
    return text
  }

  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const first = String(lines[0] ?? '').trim()
  const pattern = new RegExp(`^${bucketDate}(?:\\s*[:\\-]\\s*)?$`)
  const rest = pattern.test(first) ? lines.slice(1).join('\n').trim() : text
  return rest
}

const renderDecodedNoteLines = ({
  note,
  bucketDate,
  renderRef,
}: {
  note: FhirDecodedNote
  bucketDate: string
  renderRef: (ref: {reference: string; display: string | null}) => string
}): string[] => {
  const raw = String(note.text ?? '')
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return []
  }

  const stripped = stripLeadingBucketDateLine({text: trimmed, bucketDate}).trim()
  if (stripped.length === 0) {
    return []
  }

  const demoted = demoteMarkdownHeadingsToH6(stripped)
  const inlined = inlineReferencesInMarkdown(demoted, renderRef)
  const fenced = ensureFencesClosed(inlined)
  const finalLines = fenced.split('\n').map((l) => {
    return l.trimEnd()
  })

  const truncatedSuffix = note.truncated ? ' | truncated=true' : ''
  return [`##### Note (${note.path})${truncatedSuffix}`, '', ...finalLines]
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
