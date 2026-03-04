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
  importRoute,
  assetsFolder,
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

  const {contextByKey, identifierToKey} = buildResourceIndex(entries)
  const renderRef = ({reference, display}: {reference: string; display: string | null}): string => {
    return renderInlineReference({reference, display, contextByKey, identifierToKey})
  }

  const patientSectionLines = buildPatientSectionLines({patientId, importRoute, assetsFolder, patientEntry, renderRef})

  const timelineLines = buildTimelineLines({entries, renderRef})

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

const buildIdBullet = (resourceId: string | null): string[] => {
  return resourceId ? [`- id: \`${resourceId}\``] : []
}

const buildTimeBullet = (sortDate: string | null): string[] => {
  const value = (sortDate ?? '').trim()
  return value && value.includes('T') ? [`- time: ${truncateInlineText(value, 120)}`] : []
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
  const base = [...buildIdBullet(resourceId), ...buildTimeBullet(sortDate)]

  if (!isRecordValue(resource)) {
    return base
  }

  if (resourceType === 'Encounter') {
    const status = getStringAtPath(resource, ['status'])
    const typeDisplay = getFirstCodeableConceptDisplay(resource, 'type')
    const periodStart = getStringAtPath(resource, ['period', 'start'])
    const periodEnd = getStringAtPath(resource, ['period', 'end'])
    const period = periodStart && periodEnd ? `${periodStart} to ${periodEnd}` : (periodStart ?? periodEnd)
    const location = getStringAtPath(resource, ['location', '0', 'location', 'display'])
    const provider = getStringAtPath(resource, ['serviceProvider', 'display'])
    return [
      ...base,
      ...buildBullet('type', typeDisplay),
      ...buildBullet('status', status),
      ...buildBullet('period', period),
      ...buildBullet('location', location),
      ...buildBullet('provider', provider),
    ]
  }

  if (resourceType === 'Condition') {
    const code = getCodeableConceptDisplay(resource.code)
    const clinicalStatus = getStringAtPath(resource, ['clinicalStatus', 'coding', '0', 'code'])
    const verificationStatus = getStringAtPath(resource, ['verificationStatus', 'coding', '0', 'code'])
    const onset = getStringAtPath(resource, ['onsetDateTime'])
    const abatement = getStringAtPath(resource, ['abatementDateTime'])
    const recorded = getStringAtPath(resource, ['recordedDate'])
    return [
      ...base,
      ...buildBullet('code', code),
      ...buildBullet('clinicalStatus', clinicalStatus),
      ...buildBullet('verificationStatus', verificationStatus),
      ...buildBullet('onset', onset),
      ...buildBullet('abatement', abatement),
      ...buildBullet('recordedDate', recorded),
    ]
  }

  if (resourceType === 'Observation') {
    const code = getCodeableConceptDisplay(resource.code)
    const status = getStringAtPath(resource, ['status'])
    const value = buildObservationValueText(resource)
    return [...base, ...buildBullet('code', code), ...buildBullet('status', status), ...buildBullet('value', value)]
  }

  if (resourceType === 'Procedure') {
    const code = getCodeableConceptDisplay(resource.code)
    const status = getStringAtPath(resource, ['status'])
    const performedStart = getStringAtPath(resource, ['performedPeriod', 'start'])
    const performedEnd = getStringAtPath(resource, ['performedPeriod', 'end'])
    const performed =
      performedStart && performedEnd ? `${performedStart} to ${performedEnd}` : (performedStart ?? performedEnd)
    return [
      ...base,
      ...buildBullet('code', code),
      ...buildBullet('status', status),
      ...buildBullet('performed', performed),
    ]
  }

  if (resourceType === 'Immunization') {
    const vaccine = getCodeableConceptDisplay(resource.vaccineCode)
    const status = getStringAtPath(resource, ['status'])
    const occurrence = getStringAtPath(resource, ['occurrenceDateTime'])
    const location = getStringAtPath(resource, ['location', 'display'])
    return [
      ...base,
      ...buildBullet('vaccine', vaccine),
      ...buildBullet('status', status),
      ...buildBullet('occurrence', occurrence),
      ...buildBullet('location', location),
    ]
  }

  if (resourceType === 'MedicationRequest') {
    const med = resource.medicationCodeableConcept ?? resource.medicationReference
    const medication = getCodeableConceptDisplay(med) ?? getStringOrNull(isRecordValue(med) ? med.display : null)
    const status = getStringAtPath(resource, ['status'])
    const intent = getStringAtPath(resource, ['intent'])
    const authoredOn = getStringAtPath(resource, ['authoredOn'])
    const reason =
      getStringAtPath(resource, ['reasonCode', '0', 'text'])
      ?? getStringAtPath(resource, ['reasonCode', '0', 'coding', '0', 'display'])
    return [
      ...base,
      ...buildBullet('medication', medication),
      ...buildBullet('status', status),
      ...buildBullet('intent', intent),
      ...buildBullet('authoredOn', authoredOn),
      ...buildBullet('reason', reason),
    ]
  }

  if (resourceType === 'AllergyIntolerance') {
    const code = getCodeableConceptDisplay(resource.code)
    const type = getStringAtPath(resource, ['type'])
    const criticality = getStringAtPath(resource, ['criticality'])
    const clinicalStatus = getStringAtPath(resource, ['clinicalStatus', 'coding', '0', 'code'])
    const recordedDate = getStringAtPath(resource, ['recordedDate'])
    return [
      ...base,
      ...buildBullet('code', code),
      ...buildBullet('type', type),
      ...buildBullet('criticality', criticality),
      ...buildBullet('clinicalStatus', clinicalStatus),
      ...buildBullet('recordedDate', recordedDate),
    ]
  }

  if (resourceType === 'DocumentReference') {
    const docType = getCodeableConceptDisplay(resource.type)
    const status = getStringAtPath(resource, ['status'])
    const date = getStringAtPath(resource, ['date'])
    return [...base, ...buildBullet('type', docType), ...buildBullet('status', status), ...buildBullet('date', date)]
  }

  if (resourceType === 'DiagnosticReport') {
    const code = getCodeableConceptDisplay(resource.code)
    const status = getStringAtPath(resource, ['status'])
    const effective = getStringAtPath(resource, ['effectiveDateTime'])
    const issued = getStringAtPath(resource, ['issued'])
    return [
      ...base,
      ...buildBullet('code', code),
      ...buildBullet('status', status),
      ...buildBullet('effective', effective),
      ...buildBullet('issued', issued),
    ]
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

  const label = resolvedKey ?? trimmedRef
  const context = resolvedKey ? (contextByKey.get(resolvedKey) ?? null) : null

  const parts: string[] = []
  if (display) {
    parts.push(`display: ${truncateInlineText(display, 160)}`)
  }
  if (context) {
    parts.push(context)
  }

  const withMissing = resolvedKey ? parts : [...parts, 'missing=true']
  const finalParts = withMissing.length > 0 ? withMissing : ['resolved=true']

  return `\`${label}\` (${finalParts.join('; ')})`
}

const buildPatientSectionLines = ({
  patientId,
  importRoute,
  assetsFolder,
  patientEntry,
  renderRef,
}: {
  patientId: string
  importRoute: string
  assetsFolder: string
  patientEntry: FhirPatientMarkdownEntry | null
  renderRef: (ref: {reference: string; display: string | null}) => string
}): string[] => {
  const base = [
    `- patient_id: \`${patientId}\``,
    `- import_route: \`${importRoute}\``,
    `- assets_folder: \`${assetsFolder}\``,
  ]

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
      return [`- identifier[${idx}]: ${truncateInlineText(text, 320)}`]
    })

  const telecom = getArrayOrEmpty(resource.telecom)
    .map((t) => {
      return isRecordValue(t) ? buildTelecomText(t) : null
    })
    .filter((v): v is string => {
      return Boolean(v)
    })
    .flatMap((text, idx) => {
      return [`- telecom[${idx}]: ${truncateInlineText(text, 240)}`]
    })

  const addresses = getArrayOrEmpty(resource.address)
    .map((a) => {
      return isRecordValue(a) ? buildAddressText(a) : null
    })
    .filter((v): v is string => {
      return Boolean(v)
    })
    .flatMap((text, idx) => {
      return [`- address[${idx}]: ${truncateInlineText(text, 320)}`]
    })

  const refs = extractReferencesFromResource(resource)
    .map((r) => {
      return {path: r.path, rendered: renderRef({reference: r.reference, display: r.display})}
    })
    .filter((r) => {
      return r.path.length > 0
    })
    .sort((a, b) => {
      return a.path.localeCompare(b.path)
    })
    .map((r) => {
      return `- ref.${r.path}: ${r.rendered}`
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
    ...(refs.length > 0 ? refs : []),
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

const buildTimelineLines = ({
  entries,
  renderRef,
}: {
  entries: FhirPatientMarkdownEntry[]
  renderRef: (ref: {reference: string; display: string | null}) => string
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
      const refBullets = refs
        .filter((r) => {
          return r.path.length > 0
        })
        .map((r) => {
          const rendered = renderRef({reference: r.reference, display: r.display})
          return {path: r.path, rendered}
        })
        .sort((a, b) => {
          return a.path.localeCompare(b.path)
        })
        .map((r) => {
          return `- ref.${r.path}: ${r.rendered}`
        })

      const noteLines = entry.decodedNotes.flatMap((note, idx) => {
        const rendered = renderDecodedNoteLines({note, renderRef})
        return idx === 0 ? rendered : rendered.length > 0 ? ['', ...rendered] : []
      })

      return {
        sortMs,
        bucketDate,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        display,
        bullets,
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

const inlineReferencesInMarkdown = (
  text: string,
  renderRef: (ref: {reference: string; display: string | null}) => string,
): string => {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let openRun: number | null = null

  const replaced = lines.map((line) => {
    const run = getFenceRunLength(line)
    if (run !== null) {
      openRun = openRun === null ? run : run >= openRun ? null : openRun
      return line
    }

    if (openRun !== null) {
      return line
    }

    return line.replace(/(?<!`)\b([A-Z][A-Za-z]+\/[A-Za-z0-9.-]{1,64})\b(?!`)/g, (m) => {
      return renderRef({reference: m, display: null})
    })
  })

  return replaced.join('\n')
}

const renderDecodedNoteLines = ({
  note,
  renderRef,
}: {
  note: FhirDecodedNote
  renderRef: (ref: {reference: string; display: string | null}) => string
}): string[] => {
  const raw = String(note.text ?? '')
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return []
  }

  const demoted = demoteMarkdownHeadingsToH6(trimmed)
  const inlined = inlineReferencesInMarkdown(demoted, renderRef)
  const fenced = ensureFencesClosed(inlined)
  const finalLines = fenced.split('\n').map((l) => {
    return l.trimEnd()
  })

  return [`##### Note (${note.path}) | truncated: ${note.truncated ? 'true' : 'false'}`, '', ...finalLines]
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

  const refPattern = /\b([A-Z][A-Za-z]+\/[A-Za-z0-9.-]{1,64})\b/g
  let scanOpenRun: number | null = null
  const bareRefs = lines.flatMap((line) => {
    const run = getFenceRunLength(line)
    if (run !== null) {
      scanOpenRun = scanOpenRun === null ? run : run >= scanOpenRun ? null : scanOpenRun
      return []
    }
    if (scanOpenRun !== null) {
      return []
    }

    return Array.from(line.matchAll(refPattern))
      .map((m) => {
        const match = m[1] ?? ''
        const idx = m.index ?? -1
        const after = idx >= 0 ? line.slice(idx + match.length) : ''
        const ok = after.startsWith('` (')
        return ok ? null : match
      })
      .filter((v): v is string => {
        return Boolean(v)
      })
  })

  if (bareRefs.length > 0) {
    errors.push(`bare_refs:${bareRefs.slice(0, 5).join(',')}`)
  }

  return errors
}
