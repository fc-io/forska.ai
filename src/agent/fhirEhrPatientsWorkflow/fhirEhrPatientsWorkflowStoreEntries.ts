import {createReadStream, createWriteStream} from 'node:fs'
import {access, mkdtemp, readdir, rm, stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {createInterface} from 'node:readline'
import {createGunzip} from 'node:zlib'

import {inArray, sql} from 'drizzle-orm'

import {articleRouteLink, articles, importRoute as importRouteTable} from '../../db/schema.ts'
import {getDatabase} from '../../server/utils/getDatabase.ts'
import {
  FhirDiagnosticReportLine,
  FhirDocumentReferenceLine,
  FhirEncounterLine,
  FhirNdjsonLine,
  type FhirNdjsonLineType,
  FhirPatientLine,
  normalizeFhirEhrPatientsImportBody,
} from './fhirEhrPatientsWorkflowTypes.ts'

type ImportStats = {patientsTotal: number; inserted: number; updated: number; skipped: number; errors: number}

type SpoolEntry = {
  patientId: string
  resourceType: string
  resourceId: string | null
  sortDate: string | null
  rawLine: string
  decodedNotes: {path: string; text: string; truncated: boolean}[]
}

type ByEncounterSpoolEntry = Omit<SpoolEntry, 'patientId'> & {encounterId: string}

type EncounterIndexEntry = {encounterId: string; patientId: string}

const SHARD_COUNT = 256
const MAX_ERROR_SAMPLES = 25
const MAX_NOTE_BYTES = 200_000
const MAX_OPEN_SPOOL_STREAMS = 32

const isGzFile = (filePath: string): boolean => {
  return filePath.toLowerCase().endsWith('.gz')
}

const isNdjsonShard = (filePath: string): boolean => {
  const lower = filePath.toLowerCase()
  return lower.endsWith('.ndjson') || lower.endsWith('.ndjson.gz')
}

const getShardFilesRecursively = async (rootPath: string): Promise<string[]> => {
  const rootStat = await stat(rootPath)
  if (!rootStat.isDirectory()) {
    return isNdjsonShard(rootPath) ? [rootPath] : []
  }

  const entries = await readdir(rootPath, {withFileTypes: true})
  const nested = await Promise.all(
    entries.map(async (ent) => {
      const fullPath = join(rootPath, ent.name)
      return ent.isDirectory() ? await getShardFilesRecursively(fullPath) : isNdjsonShard(fullPath) ? [fullPath] : []
    }),
  )

  return nested.flat()
}

const tryJsonParse = (raw: string): {ok: true; value: unknown} | {ok: false; error: string} => {
  try {
    return {ok: true, value: JSON.parse(raw) as unknown}
  } catch (err) {
    return {ok: false, error: err instanceof Error ? err.message : String(err)}
  }
}

const hasResourceType = (value: unknown): value is {resourceType: string} => {
  return Boolean(
    value
      && typeof value === 'object'
      && 'resourceType' in value
      && typeof (value as {resourceType?: unknown}).resourceType === 'string',
  )
}

const getFirstDateField = (line: FhirNdjsonLineType): string | null => {
  const candidates = [
    line.effectiveDateTime,
    line.issued,
    line.date,
    line.authoredOn,
    line.recordedDate,
    line.onsetDateTime,
  ]
  const first = candidates.find((v) => {
    return typeof v === 'string' && v.trim().length > 0
  })
  return first ?? null
}

const fnv1a32 = (value: string): number => {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

const getShardIndex = (key: string): number => {
  return fnv1a32(key) % SHARD_COUNT
}

const getFhirReferenceId = (reference: string, resourceType: 'Patient' | 'Encounter'): string | null => {
  const match = reference.match(new RegExp(`${resourceType}\\/([^\\/]+)`))
  const id = match?.[1] ?? null
  return id && id.trim().length > 0 ? id : null
}

const getPatientIdFromLine = (line: FhirNdjsonLineType): string | null => {
  const subjectRef = line.subject?.reference
  const patientRef = line.patient?.reference
  const fromSubject = typeof subjectRef === 'string' ? getFhirReferenceId(subjectRef, 'Patient') : null
  const fromPatient = typeof patientRef === 'string' ? getFhirReferenceId(patientRef, 'Patient') : null
  return fromSubject ?? fromPatient
}

const getEncounterIdFromLine = (line: FhirNdjsonLineType): string | null => {
  const encounterRef = line.encounter?.reference
  return typeof encounterRef === 'string' ? getFhirReferenceId(encounterRef, 'Encounter') : null
}

const bufferLooksBinary = (text: string): boolean => {
  let replacementCount = 0
  let controlChars = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code === 0xfffd) {
      replacementCount += 1
    }
    const isAllowedControl = code === 9 || code === 10 || code === 13
    if (code < 32 && !isAllowedControl) {
      controlChars += 1
    }
  }
  const len = Math.max(1, text.length)
  return replacementCount > 0 || controlChars / len > 0.02
}

const decodeBase64AsUtf8 = (data: string): {text: string; truncated: boolean} | null => {
  const buf = Buffer.from(data, 'base64')
  if (buf.length === 0) return null
  const truncated = buf.length > MAX_NOTE_BYTES
  const sliced = truncated ? buf.subarray(0, MAX_NOTE_BYTES) : buf
  const text = sliced.toString('utf8')
  return bufferLooksBinary(text) ? null : {text, truncated}
}

const getDecodedNotesForDocumentReference = (value: unknown): {path: string; text: string; truncated: boolean}[] => {
  const parsed = FhirDocumentReferenceLine(value)
  if (Array.isArray(parsed)) {
    return []
  }
  const content = (parsed as {content?: {attachment?: {data?: string}}[]}).content ?? []
  const decoded = content
    .flatMap((entry, idx) => {
      const data = entry.attachment?.data
      const decoded = typeof data === 'string' ? decodeBase64AsUtf8(data) : null
      return decoded ? [{path: `DocumentReference.content[${idx}].attachment.data`, ...decoded}] : []
    })
    .filter((v) => {
      return v.text.trim().length > 0
    })
  return decoded
}

const getDecodedNotesForDiagnosticReport = (value: unknown): {path: string; text: string; truncated: boolean}[] => {
  const parsed = FhirDiagnosticReportLine(value)
  if (Array.isArray(parsed)) {
    return []
  }
  const presentedForm = (parsed as {presentedForm?: {data?: string}[]}).presentedForm ?? []
  const decoded = presentedForm
    .flatMap((entry, idx) => {
      const data = entry.data
      const decoded = typeof data === 'string' ? decodeBase64AsUtf8(data) : null
      return decoded ? [{path: `DiagnosticReport.presentedForm[${idx}].data`, ...decoded}] : []
    })
    .filter((v) => {
      return v.text.trim().length > 0
    })
  return decoded
}

const getDecodedNotes = (resourceType: string, value: unknown): {path: string; text: string; truncated: boolean}[] => {
  return resourceType === 'DocumentReference'
    ? getDecodedNotesForDocumentReference(value)
    : resourceType === 'DiagnosticReport'
      ? getDecodedNotesForDiagnosticReport(value)
      : []
}

type SpoolStreamEntry = {stream: ReturnType<typeof createWriteStream>; pending: Promise<void>; lastUsedAt: number}

const writeToStream = (stream: ReturnType<typeof createWriteStream>, data: string): Promise<void> => {
  const ok = stream.write(data)
  return ok
    ? Promise.resolve()
    : new Promise((resolve, reject) => {
        stream.once('drain', resolve)
        stream.once('error', reject)
      })
}

const closeStream = (stream: ReturnType<typeof createWriteStream>): Promise<void> => {
  return new Promise((resolve, reject) => {
    stream.end(() => {
      resolve()
    })
    stream.once('error', reject)
  })
}

const getOldestOpenKey = (open: Map<string, SpoolStreamEntry>): string | null => {
  const keys = Array.from(open.keys())
  const oldest = keys.reduce<{key: string; lastUsedAt: number} | null>((acc, key) => {
    const entry = open.get(key)
    if (!entry) return acc
    if (!acc) return {key, lastUsedAt: entry.lastUsedAt}
    return entry.lastUsedAt < acc.lastUsedAt ? {key, lastUsedAt: entry.lastUsedAt} : acc
  }, null)
  return oldest?.key ?? null
}

const createSpoolWriter = (maxOpenStreams: number) => {
  const open = new Map<string, SpoolStreamEntry>()

  const ensureOpenCapacity = async (): Promise<void> => {
    if (open.size < maxOpenStreams) {
      return
    }

    const oldestKey = getOldestOpenKey(open)
    const oldestEntry = oldestKey ? open.get(oldestKey) : null
    if (!oldestKey || !oldestEntry) {
      return
    }

    await oldestEntry.pending
    await closeStream(oldestEntry.stream)
    open.delete(oldestKey)
  }

  const getStreamEntry = async (filePath: string): Promise<SpoolStreamEntry> => {
    const existing = open.get(filePath)
    if (existing) {
      existing.lastUsedAt = Date.now()
      return existing
    }

    await ensureOpenCapacity()

    const stream = createWriteStream(filePath, {flags: 'a'})
    const entry: SpoolStreamEntry = {stream, pending: Promise.resolve(), lastUsedAt: Date.now()}
    open.set(filePath, entry)
    return entry
  }

  const appendLine = async (filePath: string, line: string): Promise<void> => {
    const entry = await getStreamEntry(filePath)
    entry.pending = entry.pending.then(() => {
      return writeToStream(entry.stream, line)
    })
    await entry.pending
  }

  const closeAll = async (): Promise<void> => {
    const entries = Array.from(open.values())
    const closeOne = async (idx: number): Promise<void> => {
      const entry = entries[idx]
      if (!entry) return
      await entry.pending
      await closeStream(entry.stream)
      await closeOne(idx + 1)
    }
    await closeOne(0)
    open.clear()
  }

  return {appendLine, closeAll}
}

const getSpoolPath = (tmpPath: string, prefix: string, shardIndex: number): string => {
  const idx = String(shardIndex).padStart(4, '0')
  return join(tmpPath, `${prefix}-${idx}.jsonl`)
}

const forEachLineInShard = async (shardPath: string, onLine: (line: string) => Promise<void>): Promise<void> => {
  await access(shardPath)
  const stream = createReadStream(shardPath)
  const rl = createInterface({input: stream, crlfDelay: Infinity})
  for await (const line of rl) {
    if (line.trim().length === 0) continue
    await onLine(line)
  }
}

const forEachLineInNdjsonFile = async (filePath: string, onLine: (line: string) => Promise<void>): Promise<void> => {
  const fileStream = createReadStream(filePath)
  const input = isGzFile(filePath) ? fileStream.pipe(createGunzip()) : fileStream
  const rl = createInterface({input, crlfDelay: Infinity})
  for await (const line of rl) {
    if (line.length === 0) continue
    await onLine(line)
  }
}

const addErrorSample = (samples: string[], message: string): void => {
  if (samples.length < MAX_ERROR_SAMPLES) {
    samples.push(message)
  }
}

const getArkErrorMessage = (errors: unknown): string => {
  if (!Array.isArray(errors)) {
    return ''
  }
  const list = errors as unknown[]
  const first = list[0]
  if (!first) {
    return ''
  }
  if (typeof first === 'string') {
    return first
  }
  if (typeof first !== 'object') {
    return 'ArkType error'
  }
  const msg = 'message' in first ? (first as {message?: unknown}).message : undefined
  return typeof msg === 'string' ? msg : 'ArkType error'
}

const compareSpoolEntries = (a: SpoolEntry, b: SpoolEntry): number => {
  const rt = a.resourceType.localeCompare(b.resourceType)
  const dt = (a.sortDate ?? '').localeCompare(b.sortDate ?? '')
  const id = (a.resourceId ?? '').localeCompare(b.resourceId ?? '')
  return rt !== 0 ? rt : dt !== 0 ? dt : id
}

const formatDecodedNoteBlock = (entry: SpoolEntry, note: {path: string; text: string; truncated: boolean}): string => {
  const rid = entry.resourceId ? `${entry.resourceType}/${entry.resourceId}` : entry.resourceType
  const truncated = note.truncated ? 'true' : 'false'
  return `decoded_note_begin: ${rid} ${note.path} truncated=${truncated}\n${note.text}\ndecoded_note_end: ${rid} ${note.path}`
}

const buildRecordText = ({
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
  entries: SpoolEntry[]
}): string => {
  const sorted = [...entries].sort(compareSpoolEntries)
  const header = [
    'record_type: fhir_patient',
    `patient_id: ${patientId}`,
    `import_route: ${importRoute}`,
    `title: ${articleTitle}`,
    `assets_folder: ${assetsFolder}`,
    '',
  ].join('\n')

  const body = sorted
    .flatMap((entry) => {
      const notes = entry.decodedNotes.flatMap((note) => {
        return formatDecodedNoteBlock(entry, note).split('\n')
      })
      return [entry.rawLine, ...notes]
    })
    .join('\n')

  return `${header}${body}\n`
}

const upsertArticlesBatch = async ({
  importRoute,
  importRouteId,
  batch,
}: {
  importRoute: string
  importRouteId: string
  batch: {articleId: string; articleTitle: string; recordText: string; originalData: unknown}[]
}): Promise<{inserted: number; updated: number}> => {
  const db = getDatabase()
  const articleIds = batch.map((b) => {
    return b.articleId
  })

  const existing =
    articleIds.length === 0
      ? []
      : await db.select({articleId: articles.articleId}).from(articles).where(inArray(articles.articleId, articleIds))

  const existingSet = new Set(
    existing
      .map((r) => {
        return r.articleId
      })
      .filter((v): v is string => {
        return typeof v === 'string'
      }),
  )

  const rows = batch.map((b) => {
    return {
      articleId: b.articleId,
      articleTitle: b.articleTitle,
      articleSummary: b.recordText,
      fullText: b.recordText,
      importRoute,
      originalData: b.originalData,
      fullTextConversionStatus: 'success',
      fullTextCharCount: b.recordText.length,
    }
  })

  const upserted = await db
    .insert(articles)
    .values(rows)
    .onConflictDoUpdate({
      target: articles.articleId,
      set: {
        articleTitle: sql`EXCLUDED.article_title`,
        articleSummary: sql`EXCLUDED.article_summary`,
        fullText: sql`EXCLUDED.full_text`,
        importRoute: sql`EXCLUDED.import_route`,
        originalData: sql`EXCLUDED.original_data`,
        fullTextConversionStatus: sql`EXCLUDED.full_text_conversion_status`,
        fullTextCharCount: sql`EXCLUDED.full_text_char_count`,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      },
    })
    .returning({id: articles.id, articleId: articles.articleId})

  const links = upserted
    .map((a) => {
      return {articleId: a.id, importRouteId}
    })
    .filter((v): v is {articleId: string; importRouteId: string} => {
      return Boolean(v.articleId && v.importRouteId)
    })

  if (links.length > 0) {
    await db.insert(articleRouteLink).values(links).onConflictDoNothing()
  }

  const updated = batch.filter((b) => {
    return existingSet.has(b.articleId)
  }).length

  const inserted = batch.length - updated

  return {inserted, updated}
}

const ensureImportRouteRow = async (route: string): Promise<string> => {
  const db = getDatabase()
  await db.insert(importRouteTable).values({route, name: route, active: true}).onConflictDoNothing()

  const [row] = await db
    .select({id: importRouteTable.id})
    .from(importRouteTable)
    .where(sql`${importRouteTable.route} = ${route}`)
    .limit(1)

  if (!row) {
    throw new Error('Failed to ensure import route')
  }
  return row.id
}

const processPatientShard = async ({
  shardPath,
  importRoute,
  importRouteId,
  assetsFolder,
  stats,
  errorSamples,
  dryRun,
}: {
  shardPath: string
  importRoute: string
  importRouteId: string
  assetsFolder: string
  stats: ImportStats
  errorSamples: string[]
  dryRun: boolean
}): Promise<void> => {
  const groups = new Map<string, SpoolEntry[]>()

  const onLine = async (rawLine: string): Promise<void> => {
    const parsed = tryJsonParse(rawLine)
    if (!parsed.ok) {
      stats.errors += 1
      addErrorSample(errorSamples, `spool_json_parse_error: ${parsed.error}`)
      return
    }

    const entry = parsed.value as SpoolEntry
    if (
      !entry
      || typeof entry.patientId !== 'string'
      || typeof entry.resourceType !== 'string'
      || typeof entry.rawLine !== 'string'
    ) {
      stats.errors += 1
      addErrorSample(errorSamples, 'spool_entry_invalid_shape')
      return
    }

    const list = groups.get(entry.patientId) ?? []
    list.push({...entry, decodedNotes: Array.isArray(entry.decodedNotes) ? entry.decodedNotes : []})
    groups.set(entry.patientId, list)
  }

  await forEachLineInShard(shardPath, onLine)

  const patientIds = Array.from(groups.keys())

  type ArticleUpsertEntry = {articleId: string; articleTitle: string; recordText: string; originalData: unknown}

  const processPatients = async (idx: number, batch: ArticleUpsertEntry[]): Promise<ArticleUpsertEntry[]> => {
    if (idx >= patientIds.length) {
      return batch
    }

    const patientId = patientIds[idx] ?? null
    const entries = patientId ? (groups.get(patientId) ?? []) : []
    const hasPatient = entries.some((e) => {
      return e.resourceType === 'Patient'
    })

    if (!patientId) {
      return await processPatients(idx + 1, batch)
    }

    if (!hasPatient) {
      stats.skipped += 1
      return await processPatients(idx + 1, batch)
    }

    const articleTitle = `FHIR Patient ${patientId}`
    const recordText = buildRecordText({patientId, importRoute, assetsFolder, articleTitle, entries})
    const articleId = `${importRoute}:Patient/${patientId}`
    const originalData = {
      recordType: 'fhir_patient',
      patientId,
      importRoute,
      assetsFolder,
      resourceCount: entries.length,
      hasDecodedNotes: entries.some((e) => {
        return e.decodedNotes.length > 0
      }),
    }

    stats.patientsTotal += 1

    const nextBatch: ArticleUpsertEntry[] = [...batch, {articleId, articleTitle, recordText, originalData}]
    const shouldFlush = !dryRun && nextBatch.length >= 50

    if (!shouldFlush) {
      return await processPatients(idx + 1, nextBatch)
    }

    const result = await upsertArticlesBatch({importRoute, importRouteId, batch: nextBatch})
    stats.inserted += result.inserted
    stats.updated += result.updated
    return await processPatients(idx + 1, [])
  }

  const remainingBatch = await processPatients(0, [])

  if (!dryRun && remainingBatch.length > 0) {
    const result = await upsertArticlesBatch({importRoute, importRouteId, batch: remainingBatch})
    stats.inserted += result.inserted
    stats.updated += result.updated
  }
}

export const fhirEhrPatientsWorkflowStoreEntries = async (
  input: unknown,
): Promise<{patientsTotal: number; inserted: number; updated: number; skipped: number; errors: number}> => {
  const normalized = normalizeFhirEhrPatientsImportBody(input)
  if (!normalized.ok) {
    throw new Error(normalized.error)
  }

  const {assetsFolder, importRoute, dryRun} = normalized.value
  const assetsPath = resolve(process.cwd(), assetsFolder)
  const shards = await getShardFilesRecursively(assetsPath)

  const stats: ImportStats = {patientsTotal: 0, inserted: 0, updated: 0, skipped: 0, errors: 0}
  const errorSamples: string[] = []

  const tmpPath = await mkdtemp(join(tmpdir(), 'fhir-ehr-patients-'))
  const spoolWriter = createSpoolWriter(MAX_OPEN_SPOOL_STREAMS)
  const cleanup = async (): Promise<void> => {
    await spoolWriter.closeAll().catch(() => {
      return undefined
    })
    await rm(tmpPath, {recursive: true, force: true}).catch(() => {
      return undefined
    })
  }

  try {
    const writeByPatient = async (patientId: string, entry: Omit<SpoolEntry, 'patientId'> & {patientId?: string}) => {
      const shardIndex = getShardIndex(patientId)
      const filePath = getSpoolPath(tmpPath, 'byPatient', shardIndex)
      await spoolWriter.appendLine(filePath, `${JSON.stringify({patientId, ...entry})}\n`)
    }

    const writeEncounterIndex = async (encounterId: string, patientId: string) => {
      const shardIndex = getShardIndex(encounterId)
      const filePath = getSpoolPath(tmpPath, 'encounterIndex', shardIndex)
      await spoolWriter.appendLine(
        filePath,
        `${JSON.stringify({encounterId, patientId} satisfies EncounterIndexEntry)}\n`,
      )
    }

    const writeByEncounter = async (encounterId: string, entry: Omit<ByEncounterSpoolEntry, 'encounterId'>) => {
      const shardIndex = getShardIndex(encounterId)
      const filePath = getSpoolPath(tmpPath, 'byEncounter', shardIndex)
      await spoolWriter.appendLine(filePath, `${JSON.stringify({encounterId, ...entry})}\n`)
    }

    const pass1 = async (): Promise<void> => {
      const handleLine = async (rawLine: string): Promise<void> => {
        const parsed = tryJsonParse(rawLine)
        if (!parsed.ok) {
          stats.errors += 1
          addErrorSample(errorSamples, `ndjson_json_parse_error: ${parsed.error}`)
          return
        }
        if (!hasResourceType(parsed.value)) {
          return
        }

        const validatedBaseResult = FhirNdjsonLine(parsed.value)
        if (Array.isArray(validatedBaseResult)) {
          stats.errors += 1
          addErrorSample(errorSamples, `ndjson_line_invalid_base: ${getArkErrorMessage(validatedBaseResult)}`)
          return
        }

        const validatedBase = validatedBaseResult as FhirNdjsonLineType

        if (validatedBase.resourceType !== 'Patient') {
          return
        }

        const validatedPatient = FhirPatientLine(parsed.value)
        if (Array.isArray(validatedPatient)) {
          stats.errors += 1
          addErrorSample(errorSamples, 'patient_line_missing_id')
          return
        }

        const patientId = (validatedPatient as {id: string}).id
        const entry: Omit<SpoolEntry, 'patientId'> = {
          resourceType: 'Patient',
          resourceId: patientId,
          sortDate: null,
          rawLine,
          decodedNotes: [],
        }
        await writeByPatient(patientId, entry)
      }

      const run = async (idx: number): Promise<void> => {
        const shard = shards[idx]
        if (!shard) return
        await forEachLineInNdjsonFile(shard, handleLine)
        await run(idx + 1)
      }
      await run(0)
    }

    const pass2 = async (): Promise<void> => {
      const handleLine = async (rawLine: string): Promise<void> => {
        const parsed = tryJsonParse(rawLine)
        if (!parsed.ok) {
          stats.errors += 1
          addErrorSample(errorSamples, `ndjson_json_parse_error: ${parsed.error}`)
          return
        }
        if (!hasResourceType(parsed.value)) {
          return
        }

        const validatedBaseResult = FhirNdjsonLine(parsed.value)
        if (Array.isArray(validatedBaseResult)) {
          stats.errors += 1
          addErrorSample(errorSamples, `ndjson_line_invalid_base: ${getArkErrorMessage(validatedBaseResult)}`)
          return
        }

        const validatedBase = validatedBaseResult as FhirNdjsonLineType

        if (validatedBase.resourceType !== 'Encounter') {
          return
        }

        const validatedEncounter = FhirEncounterLine(parsed.value)
        if (Array.isArray(validatedEncounter)) {
          stats.errors += 1
          addErrorSample(errorSamples, 'encounter_line_missing_required_fields')
          return
        }

        const encounterId = (validatedEncounter as {id: string}).id
        const ref = (validatedEncounter as {subject: {reference: string}}).subject.reference
        const patientId = getFhirReferenceId(ref, 'Patient')
        if (!patientId) {
          stats.errors += 1
          addErrorSample(errorSamples, 'encounter_subject_not_patient')
          return
        }

        await writeEncounterIndex(encounterId, patientId)

        const entry: Omit<SpoolEntry, 'patientId'> = {
          resourceType: 'Encounter',
          resourceId: encounterId,
          sortDate: getFirstDateField(validatedBase),
          rawLine,
          decodedNotes: [],
        }
        await writeByPatient(patientId, entry)
      }

      const run = async (idx: number): Promise<void> => {
        const shard = shards[idx]
        if (!shard) return
        await forEachLineInNdjsonFile(shard, handleLine)
        await run(idx + 1)
      }
      await run(0)
    }

    const pass3 = async (): Promise<void> => {
      const handleLine = async (rawLine: string): Promise<void> => {
        const parsed = tryJsonParse(rawLine)
        if (!parsed.ok) {
          stats.errors += 1
          addErrorSample(errorSamples, `ndjson_json_parse_error: ${parsed.error}`)
          return
        }
        if (!hasResourceType(parsed.value)) {
          return
        }

        const validatedBaseResult = FhirNdjsonLine(parsed.value)
        if (Array.isArray(validatedBaseResult)) {
          stats.errors += 1
          addErrorSample(errorSamples, `ndjson_line_invalid_base: ${getArkErrorMessage(validatedBaseResult)}`)
          return
        }

        const validatedBase = validatedBaseResult as FhirNdjsonLineType

        const resourceType = validatedBase.resourceType
        if (resourceType === 'Patient' || resourceType === 'Encounter') {
          return
        }

        const patientId = getPatientIdFromLine(validatedBase)
        const decodedNotes = getDecodedNotes(resourceType, parsed.value)
        const entryBase = {
          resourceType,
          resourceId: validatedBase.id ?? null,
          sortDate: getFirstDateField(validatedBase),
          rawLine,
          decodedNotes,
        }

        if (patientId) {
          await writeByPatient(patientId, entryBase)
          return
        }

        const encounterId = getEncounterIdFromLine(validatedBase)
        if (encounterId) {
          await writeByEncounter(encounterId, entryBase)
        }
      }

      const run = async (idx: number): Promise<void> => {
        const shard = shards[idx]
        if (!shard) return
        await forEachLineInNdjsonFile(shard, handleLine)
        await run(idx + 1)
      }
      await run(0)
    }

    const joinByEncounter = async (): Promise<void> => {
      const runShard = async (shardIndex: number): Promise<void> => {
        if (shardIndex >= SHARD_COUNT) {
          return
        }

        const encounterIndexPath = getSpoolPath(tmpPath, 'encounterIndex', shardIndex)
        const byEncounterPath = getSpoolPath(tmpPath, 'byEncounter', shardIndex)

        const encounterMap = new Map<string, string>()

        const loadIndexLine = async (raw: string): Promise<void> => {
          const parsed = tryJsonParse(raw)
          if (!parsed.ok) {
            stats.errors += 1
            addErrorSample(errorSamples, `encounter_index_parse_error: ${parsed.error}`)
            return
          }
          const entry = parsed.value as EncounterIndexEntry
          if (!entry || typeof entry.encounterId !== 'string' || typeof entry.patientId !== 'string') {
            stats.errors += 1
            addErrorSample(errorSamples, 'encounter_index_invalid_shape')
            return
          }
          encounterMap.set(entry.encounterId, entry.patientId)
        }

        await forEachLineInShard(encounterIndexPath, loadIndexLine).catch(() => {
          return undefined
        })

        const processEncounterLine = async (raw: string): Promise<void> => {
          const parsed = tryJsonParse(raw)
          if (!parsed.ok) {
            stats.errors += 1
            addErrorSample(errorSamples, `by_encounter_parse_error: ${parsed.error}`)
            return
          }
          const entry = parsed.value as ByEncounterSpoolEntry
          if (!entry || typeof entry.encounterId !== 'string') {
            stats.errors += 1
            addErrorSample(errorSamples, 'by_encounter_invalid_shape')
            return
          }
          const patientId = encounterMap.get(entry.encounterId)
          if (!patientId) {
            stats.errors += 1
            addErrorSample(errorSamples, `encounter_unresolved:${entry.encounterId}`)
            return
          }

          const byPatientEntry: Omit<SpoolEntry, 'patientId'> = {
            resourceType: entry.resourceType,
            resourceId: entry.resourceId ?? null,
            sortDate: entry.sortDate ?? null,
            rawLine: entry.rawLine,
            decodedNotes: Array.isArray(entry.decodedNotes) ? entry.decodedNotes : [],
          }

          await writeByPatient(patientId, byPatientEntry)
        }

        await forEachLineInShard(byEncounterPath, processEncounterLine).catch(() => {
          return undefined
        })

        return await runShard(shardIndex + 1)
      }

      await runShard(0)
    }

    await pass1()
    await pass2()
    await pass3()
    await joinByEncounter()

    const importRouteId = dryRun ? 'dry_run' : await ensureImportRouteRow(importRoute)

    const processShardIndex = async (idx: number): Promise<void> => {
      if (idx >= SHARD_COUNT) {
        return
      }
      const shardPath = getSpoolPath(tmpPath, 'byPatient', idx)
      const canAccess = await access(shardPath).then(
        () => {
          return true
        },
        () => {
          return false
        },
      )
      if (!canAccess) {
        return await processShardIndex(idx + 1)
      }

      await processPatientShard({shardPath, importRoute, importRouteId, assetsFolder, stats, errorSamples, dryRun})
      return await processShardIndex(idx + 1)
    }

    await processShardIndex(0)

    if (errorSamples.length > 0) {
      console.warn('[fhir-ehr-patients] sample-errors', errorSamples)
    }

    return stats
  } finally {
    await cleanup()
  }
}
