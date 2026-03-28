import {createHash} from 'node:crypto'
import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import path from 'node:path'

import {normalizeDoi} from '../../utils/articleSourceMetadata.ts'
import {listSelectableProviderModels} from '../providers/providerModelRepository.ts'
import {computePromptContentHash} from '../utils/computePromptContentHash.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {escapeSqlString, getQuotedStringList, getSqlLiteral} from './appQueryHelpers.ts'
import {
  type ArticleImportStoreRow,
  type ArticleImportStoreTx,
  storeImportedArticles,
  syncImportedArticlesWithTx,
} from './articleImportStoreService.ts'

type CovidenceImportMode = 'title_abstract' | 'full_text'
type CovidenceFileRole = 'all' | 'irrelevant' | 'full_text' | 'excluded' | 'included'
type CovidenceFileFormat = 'csv' | 'ris'
type CovidencePromptAnswerSet = 'yes|no' | 'yes|no|unsure' | 'yes_no' | 'yes_no_unsure'
type CovidencePromptTx = {queryJson: <TRow extends Record<string, unknown>>(statement: string) => Promise<TRow[]>}
type CovidenceProjectTx = CovidencePromptTx & {run: (statement: string) => Promise<void>}
type CovidenceCsvParseErrorCode =
  | 'duplicate_header'
  | 'empty_file'
  | 'header_required'
  | 'malformed_csv'
  | 'malformed_ris'
  | 'row_length_mismatch'
  | 'unsupported_format'
type CovidencePackageFile = {
  assetPath: string
  fileRole: CovidenceFileRole
  format: CovidenceFileFormat
  sourceFileName: string
}
type CovidenceReferenceRow = {
  citation: Record<string, string | null>
  exclusionReason: string | null
  fileRole: CovidenceFileRole
  notes: string | null
  rowNumber: number
  sourceFileName: string
  tags: string[]
}
type CovidenceArticleKeySource = 'doi' | 'pmid' | 'reference_id' | 'title_year_first_author'
type CovidenceArticleKey = {source: CovidenceArticleKeySource; value: string}
type CovidenceMergedArticleCandidate = {
  articleKey: string
  articleKeySource: CovidenceArticleKeySource | 'unkeyed'
  citation: Record<string, string | null>
  exclusionReasons: string[]
  notes: string[]
  sourceRows: CovidenceReferenceRow[]
  stageMembership: Record<CovidenceFileRole, boolean>
  tags: string[]
}
type CovidenceMergeMissingMatch = {
  articleKey: string | null
  articleKeySource: CovidenceArticleKeySource | null
  fileRole: Exclude<CovidenceFileRole, 'all'>
  rowNumber: number
  sourceFileName: string
}
type CovidenceMergeConflict = {
  articleKey: string
  conflictingFileRoles: CovidenceFileRole[]
  sourceRows: CovidenceReferenceRow[]
}
type CovidenceReferenceMergeResult = {
  candidates: CovidenceMergedArticleCandidate[]
  warnings: {conflictingStageMemberships: CovidenceMergeConflict[]; missingMatches: CovidenceMergeMissingMatch[]}
}
type CovidenceCanonicalCandidateState = {
  articleKeySource: CovidenceArticleKeySource | 'unkeyed'
  canonicalRow: CovidenceReferenceRow
  sourceRows: CovidenceReferenceRow[]
}
type CovidenceCsvParseError = {
  code: CovidenceCsvParseErrorCode
  fileRole: CovidenceFileRole
  message: string
  rowNumber: number | null
  sourceFileName: string
}
type CovidenceCsvParseResult = {ok: true; rows: CovidenceReferenceRow[]} | {error: CovidenceCsvParseError; ok: false}
type CovidenceCsvHeaderResult = {normalizedHeaders: string[]; ok: true} | {error: CovidenceCsvParseError; ok: false}
type CovidenceRisRecordParseResult =
  | {ok: true; records: Array<Record<string, string[]>>}
  | {error: CovidenceCsvParseError; ok: false}
type CovidencePackageConfig = {
  kind: 'covidence_import'
  version: 1
  mode: CovidenceImportMode
  files: CovidencePackageFile[]
}
type CovidencePackageUploadInput = Blob & {name?: string; type?: string}
type CovidenceAnalyzeUploadFile = {file: CovidencePackageUploadInput; fileRole: CovidenceFileRole}
type CovidenceAnalyzeDetectedFile = {
  fileRole: CovidenceFileRole
  format: CovidenceFileFormat
  rowCount: number
  sourceFileName: string
}
type CovidenceAnalyzeSampleRow = Pick<
  CovidenceMergedArticleCandidate,
  'articleKey' | 'articleKeySource' | 'citation' | 'exclusionReasons' | 'notes' | 'stageMembership' | 'tags'
>
type CovidenceAnalyzeCounts = {
  conflictingStageMembershipCount: number
  fileCount: number
  filesByRole: Record<CovidenceFileRole, number>
  mergedRowCount: number
  missingMatchCount: number
  rowCount: number
  rowsByRole: Record<CovidenceFileRole, number>
}
type CovidenceAnalyzeResult = {
  counts: CovidenceAnalyzeCounts
  detectedFiles: CovidenceAnalyzeDetectedFile[]
  mode: CovidenceImportMode
  sampleMergedRows: CovidenceAnalyzeSampleRow[]
  warnings: CovidenceReferenceMergeResult['warnings']
}
type CovidenceAnalyzeError = {
  code: 'conflicting_stage_memberships' | 'invalid_file_roles' | 'invalid_upload' | 'parse_error' | 'unsupported_format'
  message: string
  parseError?: CovidenceCsvParseError
  warnings?: CovidenceReferenceMergeResult['warnings']
}
type CovidenceAnalyzeResponse = {data: CovidenceAnalyzeResult; ok: true} | {error: CovidenceAnalyzeError; ok: false}
type CovidenceImportResult = {
  config: CovidencePackageConfig
  importRouteIds?: string[]
  stats: {importedCount: number; itemCount: number}
}
type CovidencePromptDefinition = {
  originalText: string
  promptHeading: string
  type: "'yes' | 'no'" | "'yes' | 'no' | 'unsure'"
}
type CovidencePromptRecord = CovidencePromptDefinition & {created: boolean; id: string}
type CovidenceProjectRecord = {
  created: boolean
  id: string
  modelId: string
  name: string
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}
type CovidenceHumanJudgmentSeed = {answer: 'no' | 'yes' | null; articleExternalId: string; isAnswered: boolean}
type CovidenceProjectScopeSeed = {articleExternalId: string}

const covidenceImportFolder = path.resolve(process.cwd(), 'assets/covidence_imports')
const covidenceImportPathPrefix = 'assets/covidence_imports'
const covidencePromptHeadingByMode = {
  full_text: 'Covidence full-text screening',
  title_abstract: 'Covidence title/abstract screening',
} as const satisfies Record<CovidenceImportMode, string>
const covidencePromptQuestionByMode = {
  full_text: 'Based on the inclusion and exclusion criteria, should this study be included in the final review?',
  title_abstract: 'Based on the inclusion and exclusion criteria, should this study be included for full text review?',
} as const satisfies Record<CovidenceImportMode, string>
const covidenceProjectSettingsByMode = {
  full_text: {useAbstract: true, useFulltext: true, useFulltextNoImages: false, useTitle: true},
  title_abstract: {useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true},
} as const satisfies Record<
  CovidenceImportMode,
  {useAbstract: boolean; useFulltext: boolean; useFulltextNoImages: boolean; useTitle: boolean}
>
const titleAbstractRoles: CovidenceFileRole[] = ['all', 'irrelevant', 'full_text']
const fullTextRoles: CovidenceFileRole[] = ['all', 'irrelevant', 'full_text', 'excluded', 'included']
const covidenceTagKeys = new Set(['tag', 'tags'])
const covidenceNoteKeys = new Set(['note', 'notes'])
const covidenceExclusionReasonKeys = new Set([
  'exclusion_reason',
  'exclusion_reasons',
  'reason_for_exclusion',
  'reason_for_exclusions',
])
const covidenceRisTitleKeys = ['ti', 't1', 'ct']
const covidenceRisAbstractKeys = ['ab', 'n2']
const covidenceRisAuthorKeys = ['au', 'a1', 'a2', 'a3', 'a4']
const covidenceRisDoiKeys = ['do']
const covidenceRisPmidKeys = ['pmid', 'an']
const covidenceRisUrlKeys = ['ur', 'l1', 'l2', 'l3', 'l4']
const covidenceRisNoteKeys = ['n1']
const covidenceRisTagKeys = ['kw']
const covidenceRisFieldNames = {
  a1: 'primary_author',
  a2: 'secondary_author',
  a3: 'tertiary_author',
  a4: 'subsidiary_author',
  ab: 'abstract',
  an: 'pmid',
  au: 'authors',
  c7: 'article_number',
  ct: 'title',
  da: 'date',
  do: 'doi',
  id: 'reference_id',
  ja: 'journal_abbreviation',
  jf: 'journal',
  jo: 'journal',
  kw: 'keywords',
  l1: 'url',
  l2: 'url',
  l3: 'url',
  l4: 'url',
  lb: 'source_role',
  m3: 'source_role',
  n1: 'notes',
  n2: 'abstract',
  pmid: 'pmid',
  py: 'publication_year',
  t1: 'title',
  t2: 'secondary_title',
  ti: 'title',
  ty: 'reference_type',
  ur: 'url',
  y1: 'publication_date',
} as const satisfies Record<string, string>
const covidencePmidKeys = ['pmid', 'pubmed_id']
const covidenceReferenceIdKeys = ['reference_id', 'covidence_id']
const covidenceYearKeys = ['year', 'publication_year', 'publication_date', 'date']
const emptyCovidenceStageMembership = {
  all: false,
  excluded: false,
  full_text: false,
  included: false,
  irrelevant: false,
} as const satisfies Record<CovidenceFileRole, boolean>
const covidenceConflictingStageRoleGroups = [
  ['irrelevant', 'full_text'],
  ['excluded', 'included'],
] as const satisfies CovidenceFileRole[][]
const emptyCovidenceRoleCounts = {
  all: 0,
  excluded: 0,
  full_text: 0,
  included: 0,
  irrelevant: 0,
} as const satisfies Record<CovidenceFileRole, number>

const getCovidencePromptAnswerValues = (answerSet: CovidencePromptAnswerSet) => {
  return answerSet === 'yes|no|unsure' || answerSet === 'yes_no_unsure' ? ['yes', 'no', 'unsure'] : ['yes', 'no']
}

const getCovidencePromptCriteriaText = (criteria: string) => {
  const trimmedCriteria = criteria.trim()

  return trimmedCriteria === '' ? '(none provided)' : trimmedCriteria
}

const getCovidencePromptText = (params: {
  answerSet: CovidencePromptAnswerSet
  exclusionCriteria: string
  inclusionCriteria: string
  mode: CovidenceImportMode
}) => {
  const allowedAnswers = getCovidencePromptAnswerValues(params.answerSet).join(', ')

  return [
    covidencePromptQuestionByMode[params.mode],
    '',
    `Allowed answers: ${allowedAnswers}`,
    '',
    `Inclusion:\n${getCovidencePromptCriteriaText(params.inclusionCriteria)}`,
    '',
    `Exclusion:\n${getCovidencePromptCriteriaText(params.exclusionCriteria)}`,
  ].join('\n')
}

const getCovidencePromptType = (answerSet: CovidencePromptAnswerSet): CovidencePromptDefinition['type'] => {
  return answerSet === 'yes|no|unsure' || answerSet === 'yes_no_unsure' ? "'yes' | 'no' | 'unsure'" : "'yes' | 'no'"
}

const getCovidencePromptQueryRunner = (tx?: CovidencePromptTx) => {
  return tx ?? getAppDatabaseService()
}

const getCovidenceProjectQueryRunner = (tx?: CovidenceProjectTx) => {
  return tx ?? getAppDatabaseService()
}

const getCovidenceProjectSettings = (mode: CovidenceImportMode) => {
  return covidenceProjectSettingsByMode[mode]
}

const getDefaultCovidenceProjectModelId = async () => {
  const [model] = await listSelectableProviderModels()

  if (!model) {
    throw new Error('No selectable model available for Covidence project')
  }

  return model.id
}

const getCovidenceProjectByImportRoute = async (params: {importRoute: string; tx?: CovidenceProjectTx}) => {
  const [project] = await getCovidenceProjectQueryRunner(params.tx).queryJson<{
    id: string
    modelId: string
    name: string
    useAbstract: boolean
    useFulltext: boolean
    useFulltextNoImages: boolean
    useTitle: boolean
  }>(`
    SELECT
      p.id AS id,
      p.model_id AS modelId,
      p.name AS name,
      p.use_abstract AS useAbstract,
      p.use_fulltext AS useFulltext,
      p.use_fulltext_no_images AS useFulltextNoImages,
      p.use_title AS useTitle
    FROM app.project_import_route pir
    INNER JOIN app.import_route ir ON ir.id = pir.import_route_id
    INNER JOIN app.project p ON p.id = pir.project_id
    WHERE ir.route = ${getSqlLiteral(params.importRoute)}
    LIMIT 1
  `)

  return project ?? null
}

const getNormalizedCovidenceMatchValue = (value: string | null) => {
  return value ? value.trim().toLowerCase().replace(/\s+/g, ' ') : null
}

const getNormalizedCovidenceKeyPart = (value: string | null) => {
  return value
    ? value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ')
    : null
}

const getCovidenceCitationValue = (citation: Record<string, string | null>, keys: string[]) => {
  return (
    keys
      .map((key) => {
        return citation[key] ?? null
      })
      .find((value) => {
        return value !== null && value.trim() !== ''
      }) ?? null
  )
}

const getCovidenceFirstAuthor = (authors: string | null) => {
  const normalizedAuthors = authors
    ?.split(';')
    .map((author) => {
      return author.trim()
    })
    .find((author) => {
      return author !== ''
    })

  return getNormalizedCovidenceKeyPart(normalizedAuthors ?? null)
}

const getCovidenceYearValue = (citation: Record<string, string | null>) => {
  const yearCandidate = getCovidenceCitationValue(citation, covidenceYearKeys)
  const matchedYear = yearCandidate?.match(/\b\d{4}\b/)?.[0] ?? null

  return matchedYear ? matchedYear : getNormalizedCovidenceMatchValue(yearCandidate)
}

const getCovidenceTitleYearFirstAuthorHash = (citation: Record<string, string | null>) => {
  const normalizedTitle = getNormalizedCovidenceKeyPart(citation.title ?? null)
  const normalizedYear = getCovidenceYearValue(citation)
  const normalizedFirstAuthor = getCovidenceFirstAuthor(citation.authors ?? null)
  const hashInput = [normalizedTitle, normalizedYear, normalizedFirstAuthor].every((value) => {
    return value !== null
  })
    ? [normalizedTitle, normalizedYear, normalizedFirstAuthor].join('|')
    : null

  return hashInput ? createHash('sha256').update(hashInput).digest('hex') : null
}

const getCovidenceArticleKey = (citation: Record<string, string | null>): CovidenceArticleKey | null => {
  const doi = getNormalizedCovidenceMatchValue(normalizeDoi(getCovidenceCitationValue(citation, ['doi'])))
  const pmid = getNormalizedCovidenceMatchValue(getCovidenceCitationValue(citation, covidencePmidKeys))
  const referenceId = getNormalizedCovidenceMatchValue(getCovidenceCitationValue(citation, covidenceReferenceIdKeys))
  const titleYearFirstAuthorHash = getCovidenceTitleYearFirstAuthorHash(citation)

  return doi
    ? {source: 'doi', value: doi}
    : pmid
      ? {source: 'pmid', value: pmid}
      : referenceId
        ? {source: 'reference_id', value: referenceId}
        : titleYearFirstAuthorHash
          ? {source: 'title_year_first_author', value: titleYearFirstAuthorHash}
          : null
}

const getCovidenceRowKey = (row: CovidenceReferenceRow) => {
  return getCovidenceArticleKey(row.citation)
}

const isCovidenceOverlayRow = (
  row: CovidenceReferenceRow,
): row is CovidenceReferenceRow & {fileRole: Exclude<CovidenceFileRole, 'all'>} => {
  return row.fileRole !== 'all'
}

const getCovidenceUniqueStrings = (values: Array<string | null>) => {
  return values.reduce<string[]>((uniqueValues, value) => {
    const normalizedValue = value?.trim() ?? ''

    return normalizedValue === '' || uniqueValues.includes(normalizedValue)
      ? uniqueValues
      : [...uniqueValues, normalizedValue]
  }, [])
}

const getCovidenceStageMembership = (rows: CovidenceReferenceRow[]) => {
  return rows.reduce<Record<CovidenceFileRole, boolean>>(
    (membership, row) => {
      return {...membership, [row.fileRole]: true}
    },
    {...emptyCovidenceStageMembership},
  )
}

const getCovidenceMergedArticleCandidate = (params: {
  articleKey: string
  articleKeySource: CovidenceArticleKeySource | 'unkeyed'
  canonicalRow: CovidenceReferenceRow
  sourceRows: CovidenceReferenceRow[]
}): CovidenceMergedArticleCandidate => {
  return {
    articleKey: params.articleKey,
    articleKeySource: params.articleKeySource,
    citation: params.canonicalRow.citation,
    exclusionReasons: getCovidenceUniqueStrings(
      params.sourceRows.map((row) => {
        return row.exclusionReason
      }),
    ),
    notes: getCovidenceUniqueStrings(
      params.sourceRows.map((row) => {
        return row.notes
      }),
    ),
    sourceRows: params.sourceRows,
    stageMembership: getCovidenceStageMembership(params.sourceRows),
    tags: getCovidenceUniqueStrings(
      params.sourceRows.flatMap((row) => {
        return row.tags
      }),
    ),
  }
}

const getCovidenceCandidateState = (params: {
  articleKeySource: CovidenceArticleKeySource | 'unkeyed'
  canonicalRow: CovidenceReferenceRow
  sourceRows: CovidenceReferenceRow[]
}): CovidenceCanonicalCandidateState => {
  return {articleKeySource: params.articleKeySource, canonicalRow: params.canonicalRow, sourceRows: params.sourceRows}
}

const getCovidenceConflictWarnings = (candidates: CovidenceMergedArticleCandidate[]) => {
  return candidates.flatMap((candidate) => {
    const conflictingFileRoles = getCovidenceUniqueStrings(
      covidenceConflictingStageRoleGroups.flatMap((group) => {
        return group.every((fileRole) => {
          return candidate.stageMembership[fileRole]
        })
          ? group
          : []
      }),
    ) as CovidenceFileRole[]

    return conflictingFileRoles.length > 0
      ? [
          {
            articleKey: candidate.articleKey,
            conflictingFileRoles,
            sourceRows: candidate.sourceRows.filter((row) => {
              return conflictingFileRoles.includes(row.fileRole)
            }),
          },
        ]
      : []
  })
}

const getCovidenceCsvParseError = (params: {
  code: CovidenceCsvParseErrorCode
  fileRole: CovidenceFileRole
  message: string
  rowNumber?: number | null
  sourceFileName: string
}): CovidenceCsvParseResult => {
  return {
    error: {
      code: params.code,
      fileRole: params.fileRole,
      message: params.message,
      rowNumber: params.rowNumber ?? null,
      sourceFileName: params.sourceFileName,
    },
    ok: false,
  }
}

const isCovidenceCsvParseFailure = <T extends {ok: boolean}>(value: T): value is Extract<T, {ok: false}> => {
  return value.ok === false
}

const getCovidenceCsvHeaderError = (params: {
  code: CovidenceCsvParseErrorCode
  fileRole: CovidenceFileRole
  message: string
  rowNumber?: number | null
  sourceFileName: string
}): CovidenceCsvHeaderResult => {
  const errorResult = getCovidenceCsvParseError(params)

  return isCovidenceCsvParseFailure(errorResult)
    ? {error: errorResult.error, ok: false}
    : {normalizedHeaders: [], ok: true}
}

const getCovidenceRisParseError = (params: {
  code: CovidenceCsvParseErrorCode
  fileRole: CovidenceFileRole
  message: string
  rowNumber?: number | null
  sourceFileName: string
}): CovidenceRisRecordParseResult => {
  const errorResult = getCovidenceCsvParseError(params)

  return isCovidenceCsvParseFailure(errorResult) ? {error: errorResult.error, ok: false} : {ok: true, records: []}
}

const getSanitizedFileName = (fileName: string) => {
  return fileName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'upload'
}

const getSafeIdentityPart = (value: string) => {
  const encodedValue = encodeURIComponent(value)

  return encodedValue.length <= 160
    ? encodedValue
    : `${encodedValue.slice(0, 120)}-${createHash('sha256').update(encodedValue).digest('hex').slice(0, 24)}`
}

const getNormalizedCovidenceHeader = (header: string) => {
  return header
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

const getNormalizedCovidenceCellValue = (value: string) => {
  const trimmedValue = value.trim()
  return trimmedValue === '' ? null : trimmedValue
}

const getCovidenceTags = (value: string | null) => {
  return (value ?? '')
    .split(/[;|\n]/)
    .map((part) => {
      return part.trim()
    })
    .filter((part, index, parts) => {
      return part !== '' && parts.indexOf(part) === index
    })
}

const getCovidenceCitationFieldsFromEntries = (entries: Array<[string, string | null]>) => {
  return entries.reduce<Record<string, string | null>>((citation, [key, value]) => {
    return covidenceTagKeys.has(key) || covidenceNoteKeys.has(key) || covidenceExclusionReasonKeys.has(key)
      ? citation
      : {...citation, [key]: value}
  }, {})
}

const getNormalizedCovidenceRisTag = (tag: string) => {
  return tag.trim().toLowerCase()
}

const getCovidenceRisFieldName = (tag: string) => {
  return covidenceRisFieldNames[tag as keyof typeof covidenceRisFieldNames] ?? getNormalizedCovidenceHeader(tag)
}

const getCovidenceRisFieldValues = (fields: Record<string, string[]>, keys: string[]) => {
  return keys.flatMap((key) => {
    return fields[key] ?? []
  })
}

const getCovidenceRisSingleValue = (fields: Record<string, string[]>, keys: string[]) => {
  return (
    getCovidenceRisFieldValues(fields, keys).find((value) => {
      return value !== ''
    }) ?? null
  )
}

const getCovidenceRisJoinedValue = (fields: Record<string, string[]>, keys: string[]) => {
  const values = getCovidenceRisFieldValues(fields, keys)

  return values.length > 0 ? values.join('; ') : null
}

const getCovidenceRisEntries = (fields: Record<string, string[]>) => {
  const normalizedEntries = Object.entries(fields).flatMap(([tag, values]) => {
    const fieldName = getCovidenceRisFieldName(tag)
    const normalizedValue = values.length > 0 ? values.join('; ') : null

    return normalizedValue === null ? [] : ([[fieldName, normalizedValue]] as Array<[string, string | null]>)
  })
  const preferredEntries: Array<[string, string | null]> = [
    ['title', getCovidenceRisSingleValue(fields, covidenceRisTitleKeys)],
    ['abstract', getCovidenceRisSingleValue(fields, covidenceRisAbstractKeys)],
    ['authors', getCovidenceRisJoinedValue(fields, covidenceRisAuthorKeys)],
    ['doi', getCovidenceRisSingleValue(fields, covidenceRisDoiKeys)],
    ['pmid', getCovidenceRisSingleValue(fields, covidenceRisPmidKeys)],
    ['url', getCovidenceRisSingleValue(fields, covidenceRisUrlKeys)],
  ]
  const preferredKeys = new Set(
    preferredEntries.flatMap(([key, value]) => {
      return value === null ? [] : [key]
    }),
  )

  return [
    ...preferredEntries.filter(([, value]) => {
      return value !== null
    }),
    ...normalizedEntries.filter(([key]) => {
      return !preferredKeys.has(key)
    }),
  ]
}

const getParsedCovidenceRisRecords = (params: {
  content: string
  fileRole: CovidenceFileRole
  sourceFileName: string
}): CovidenceRisRecordParseResult => {
  const normalizedContent = params.content.replace(/^\uFEFF/, '')
  const trimmedContent = normalizedContent.trim()

  if (trimmedContent === '') {
    return getCovidenceRisParseError({
      code: 'empty_file',
      fileRole: params.fileRole,
      message: 'Covidence RIS is empty',
      sourceFileName: params.sourceFileName,
    })
  }

  const lines = normalizedContent.split(/\r?\n/)
  const state = lines.reduce(
    (currentState, line, index) => {
      const trimmedLine = line.trimEnd()
      const match = trimmedLine.match(/^([A-Z0-9]{2,})\s*-\s?(.*)$/)

      if (trimmedLine.trim() === '') {
        return currentState
      }

      if (match) {
        const normalizedTag = getNormalizedCovidenceRisTag(match[1] ?? '')
        const value = getNormalizedCovidenceCellValue(match[2] ?? '') ?? ''
        const updatedRecord =
          normalizedTag === 'er'
            ? currentState.currentRecord
            : {
                ...currentState.currentRecord,
                [normalizedTag]: [...(currentState.currentRecord[normalizedTag] ?? []), value],
              }

        return normalizedTag === 'er'
          ? {
              currentRecord: {},
              currentTag: null,
              malformedLineIndex: currentState.malformedLineIndex,
              records: [...currentState.records, updatedRecord],
            }
          : {
              currentRecord: updatedRecord,
              currentTag: normalizedTag,
              malformedLineIndex: currentState.malformedLineIndex,
              records: currentState.records,
            }
      }

      return currentState.currentTag
        ? {
            currentRecord: {
              ...currentState.currentRecord,
              [currentState.currentTag]: [
                ...(currentState.currentRecord[currentState.currentTag] ?? []).slice(0, -1),
                `${(currentState.currentRecord[currentState.currentTag] ?? []).at(-1) ?? ''}\n${line.trim()}`.trim(),
              ],
            },
            currentTag: currentState.currentTag,
            malformedLineIndex: currentState.malformedLineIndex,
            records: currentState.records,
          }
        : {...currentState, malformedLineIndex: currentState.malformedLineIndex ?? index}
    },
    {
      currentRecord: {} as Record<string, string[]>,
      currentTag: null as string | null,
      malformedLineIndex: null as number | null,
      records: [] as Array<Record<string, string[]>>,
    },
  )

  if (state.malformedLineIndex !== null) {
    return getCovidenceRisParseError({
      code: 'malformed_ris',
      fileRole: params.fileRole,
      message: `Covidence RIS line ${state.malformedLineIndex + 1} is not a valid RIS field`,
      rowNumber: state.malformedLineIndex + 1,
      sourceFileName: params.sourceFileName,
    })
  }

  if (Object.keys(state.currentRecord).length > 0) {
    return getCovidenceRisParseError({
      code: 'malformed_ris',
      fileRole: params.fileRole,
      message: 'Covidence RIS is missing a terminating ER field',
      sourceFileName: params.sourceFileName,
    })
  }

  return state.records.length === 0
    ? getCovidenceRisParseError({
        code: 'empty_file',
        fileRole: params.fileRole,
        message: 'Covidence RIS is empty',
        sourceFileName: params.sourceFileName,
      })
    : {ok: true, records: state.records}
}

const getCovidenceReferenceRowFromEntries = (params: {
  citationEntries: Array<[string, string | null]>
  exclusionReason: string | null
  fileRole: CovidenceFileRole
  notes: string | null
  rowNumber: number
  sourceFileName: string
  tags: string[]
}): CovidenceReferenceRow => {
  return {
    citation: getCovidenceCitationFieldsFromEntries(params.citationEntries),
    exclusionReason: params.exclusionReason,
    fileRole: params.fileRole,
    notes: params.notes,
    rowNumber: params.rowNumber,
    sourceFileName: params.sourceFileName,
    tags: params.tags,
  }
}

const getParsedCovidenceCsvRows = (content: string) => {
  const state = Array.from(content).reduce(
    (currentState, character, index, characters) => {
      if (currentState.skipNext) {
        return {...currentState, skipNext: false}
      }

      if (character === '"') {
        return currentState.inQuotes && characters[index + 1] === '"'
          ? {...currentState, currentField: `${currentState.currentField}"`, skipNext: true}
          : {...currentState, inQuotes: !currentState.inQuotes}
      }

      if (character === '\r') {
        return currentState
      }

      if (character === ',' && !currentState.inQuotes) {
        return {...currentState, currentField: '', currentRow: [...currentState.currentRow, currentState.currentField]}
      }

      if (character === '\n' && !currentState.inQuotes) {
        return {
          ...currentState,
          currentField: '',
          currentRow: [],
          rows: [...currentState.rows, [...currentState.currentRow, currentState.currentField]],
        }
      }

      return {...currentState, currentField: `${currentState.currentField}${character}`}
    },
    {currentField: '', currentRow: [] as string[], inQuotes: false, rows: [] as string[][], skipNext: false},
  )
  const rows = [...state.rows, [...state.currentRow, state.currentField]].filter((row, index, allRows) => {
    return !(index === allRows.length - 1 && row.length === 1 && row[0] === '' && content.endsWith('\n'))
  })

  return state.inQuotes ? null : rows
}

const getCovidenceCsvHeaders = (params: {
  fileRole: CovidenceFileRole
  headers: string[]
  sourceFileName: string
}): CovidenceCsvHeaderResult => {
  const normalizedHeaders = params.headers.map((header) => {
    return getNormalizedCovidenceHeader(header)
  })
  const firstBlankHeaderIndex = normalizedHeaders.findIndex((header) => {
    return header === ''
  })

  if (firstBlankHeaderIndex !== -1) {
    return getCovidenceCsvHeaderError({
      code: 'header_required',
      fileRole: params.fileRole,
      message: `Covidence CSV header ${firstBlankHeaderIndex + 1} is empty`,
      rowNumber: 1,
      sourceFileName: params.sourceFileName,
    })
  }

  const duplicateHeader = normalizedHeaders.find((header, index) => {
    return normalizedHeaders.indexOf(header) !== index
  })

  return duplicateHeader
    ? getCovidenceCsvHeaderError({
        code: 'duplicate_header',
        fileRole: params.fileRole,
        message: `Covidence CSV contains duplicate header '${duplicateHeader}'`,
        rowNumber: 1,
        sourceFileName: params.sourceFileName,
      })
    : {normalizedHeaders, ok: true}
}

const getCovidenceCitationFields = (headers: string[], values: string[]) => {
  return getCovidenceCitationFieldsFromEntries(
    headers.map((header, index) => {
      return [header, getNormalizedCovidenceCellValue(values[index] ?? '')] as [string, string | null]
    }),
  )
}

const getCovidenceReferenceRow = (params: {
  fileRole: CovidenceFileRole
  normalizedHeaders: string[]
  rowNumber: number
  sourceFileName: string
  values: string[]
}): CovidenceReferenceRow => {
  const normalizedValues = params.values.map((value) => {
    return getNormalizedCovidenceCellValue(value)
  })
  const rowEntries = params.normalizedHeaders.reduce<Record<string, string | null>>((row, header, index) => {
    return {...row, [header]: normalizedValues[index] ?? null}
  }, {})

  return getCovidenceReferenceRowFromEntries({
    citationEntries: Object.entries(getCovidenceCitationFields(params.normalizedHeaders, params.values)),
    exclusionReason:
      params.normalizedHeaders
        .map((header) => {
          return (covidenceExclusionReasonKeys.has(header) ? rowEntries[header] : null) ?? null
        })
        .find((value) => {
          return value !== null
        }) ?? null,
    fileRole: params.fileRole,
    notes:
      params.normalizedHeaders
        .map((header) => {
          return (covidenceNoteKeys.has(header) ? rowEntries[header] : null) ?? null
        })
        .find((value) => {
          return value !== null
        }) ?? null,
    rowNumber: params.rowNumber,
    sourceFileName: params.sourceFileName,
    tags: params.normalizedHeaders.flatMap((header) => {
      return covidenceTagKeys.has(header) ? getCovidenceTags(rowEntries[header] ?? null) : []
    }),
  })
}

const getCovidenceFileFormatFromName = (fileName: string) => {
  const loweredName = fileName.toLowerCase()
  return loweredName.endsWith('.csv') ? ('csv' as const) : loweredName.endsWith('.ris') ? ('ris' as const) : null
}

const getAllowedRoles = (mode: CovidenceImportMode) => {
  return mode === 'title_abstract' ? titleAbstractRoles : fullTextRoles
}

const getSortedCovidencePackageFiles = (mode: CovidenceImportMode, files: CovidencePackageFile[]) => {
  const roleOrder = getAllowedRoles(mode)

  return [...files].sort((left, right) => {
    return roleOrder.indexOf(left.fileRole) - roleOrder.indexOf(right.fileRole)
  })
}

const getCovidenceFileRoleValidationMessage = (params: {fileRoles: CovidenceFileRole[]; mode: CovidenceImportMode}) => {
  const allowedRoles = getAllowedRoles(params.mode)
  const uniqueRoles = Array.from(new Set(params.fileRoles))
  const duplicateRoles = uniqueRoles.filter((fileRole) => {
    return (
      params.fileRoles.filter((candidateRole) => {
        return candidateRole === fileRole
      }).length > 1
    )
  })
  const disallowedRoles = uniqueRoles.filter((fileRole) => {
    return !allowedRoles.includes(fileRole)
  })
  const missingRoles = allowedRoles.filter((fileRole) => {
    return !uniqueRoles.includes(fileRole)
  })
  const messageParts = [
    missingRoles.length > 0 ? `missing required files: ${missingRoles.join(', ')}` : null,
    duplicateRoles.length > 0 ? `duplicate file roles: ${duplicateRoles.join(', ')}` : null,
    disallowedRoles.length > 0 ? `roles not allowed for ${params.mode}: ${disallowedRoles.join(', ')}` : null,
  ].filter((messagePart): messagePart is string => {
    return messagePart !== null
  })

  return messageParts.length > 0 ? `Invalid Covidence package file roles: ${messageParts.join('; ')}` : null
}

const getSortedCovidenceAnalyzeFiles = <T extends {fileRole: CovidenceFileRole}>(
  mode: CovidenceImportMode,
  files: T[],
) => {
  const roleOrder = getAllowedRoles(mode)

  return [...files].sort((left, right) => {
    return roleOrder.indexOf(left.fileRole) - roleOrder.indexOf(right.fileRole)
  })
}

const getCovidenceRoleCounts = <T extends {fileRole: CovidenceFileRole}>(values: T[]) => {
  return values.reduce<Record<CovidenceFileRole, number>>(
    (counts, value) => {
      return {...counts, [value.fileRole]: counts[value.fileRole] + 1}
    },
    {...emptyCovidenceRoleCounts},
  )
}

const getValidatedCovidencePackageFiles = (params: {
  mode: CovidenceImportMode
  files: CovidencePackageFile[]
}): CovidencePackageFile[] => {
  const validationMessage = getCovidenceFileRoleValidationMessage({
    fileRoles: params.files.map((file) => {
      return file.fileRole
    }),
    mode: params.mode,
  })

  if (validationMessage) {
    throw new Error(validationMessage)
  }

  return getSortedCovidencePackageFiles(params.mode, params.files)
}

const getCovidencePackageConfigValue = (cursor: string | null): CovidencePackageConfig | null => {
  if (!cursor) {
    return null
  }

  try {
    const parsedValue = JSON.parse(cursor) as Partial<CovidencePackageConfig>
    const files = Array.isArray(parsedValue.files)
      ? parsedValue.files.filter((file): file is CovidencePackageFile => {
          return (
            typeof file === 'object'
            && file !== null
            && typeof file.assetPath === 'string'
            && typeof file.fileRole === 'string'
            && typeof file.format === 'string'
            && typeof file.sourceFileName === 'string'
          )
        })
      : []

    return parsedValue.kind === 'covidence_import'
      && parsedValue.version === 1
      && (parsedValue.mode === 'title_abstract' || parsedValue.mode === 'full_text')
      && files.length === parsedValue.files?.length
      ? {
          kind: 'covidence_import',
          version: 1,
          mode: parsedValue.mode,
          files: getValidatedCovidencePackageFiles({files, mode: parsedValue.mode}),
        }
      : null
  } catch {
    return null
  }
}

const getCovidencePackageConfigCursor = (config: CovidencePackageConfig) => {
  return JSON.stringify(config)
}

const getCovidencePackageFolder = (datasourceId: string) => {
  return path.join(covidenceImportFolder, datasourceId)
}

const ensureCovidencePackageFolder = (datasourceId: string) => {
  mkdirSync(getCovidencePackageFolder(datasourceId), {recursive: true})
}

const getCovidenceAssetPathParts = (assetPath: string) => {
  const normalizedAssetPath = assetPath.replace(/\\/g, '/')
  const pathSegments = normalizedAssetPath.split('/').filter((segment) => {
    return segment.length > 0
  })

  return pathSegments.length === 4
    && pathSegments[0] === 'assets'
    && pathSegments[1] === 'covidence_imports'
    && pathSegments[2]
    ? {datasourceId: pathSegments[2], fileName: pathSegments[3] ?? ''}
    : null
}

const getCovidencePackageAbsolutePath = (assetPath: string) => {
  const assetPathParts = getCovidenceAssetPathParts(assetPath)

  if (!assetPathParts) {
    return null
  }

  const datasourceFolder = getCovidencePackageFolder(assetPathParts.datasourceId)
  const absolutePath = path.resolve(process.cwd(), assetPath)
  const allowedPrefix = `${datasourceFolder}${path.sep}`

  return absolutePath.startsWith(allowedPrefix) ? absolutePath : null
}

const getCovidencePackageRowsFromConfig = (config: CovidencePackageConfig) => {
  const parsedRows = config.files.map((file) => {
    return parseCovidenceReferenceRows({
      content: getCovidencePackageFileContent(file.assetPath),
      fileRole: file.fileRole,
      format: file.format,
      sourceFileName: file.sourceFileName,
    })
  })
  const parseFailure = parsedRows.find((result) => {
    return result.ok === false
  })

  if (parseFailure && parseFailure.ok === false) {
    throw new Error(parseFailure.error.message)
  }

  return mergeCovidenceReferenceRows(
    parsedRows.flatMap((result) => {
      return result.ok ? result.rows : []
    }),
  )
}

const getCovidenceImportOriginalData = (candidate: CovidenceMergedArticleCandidate) => {
  return {
    covidence: {
      articleKey: candidate.articleKey,
      articleKeySource: candidate.articleKeySource,
      citation: candidate.citation,
      exclusionReasons: candidate.exclusionReasons,
      notes: candidate.notes,
      sourceRows: candidate.sourceRows.map((row) => {
        return {
          citation: row.citation,
          exclusionReason: row.exclusionReason,
          fileRole: row.fileRole,
          notes: row.notes,
          rowNumber: row.rowNumber,
          sourceFileName: row.sourceFileName,
          tags: row.tags,
        }
      }),
      stageMembership: candidate.stageMembership,
      tags: candidate.tags,
    },
  }
}

const getCovidenceImportSourceMetadata = (params: {
  candidate: CovidenceMergedArticleCandidate
  config: CovidencePackageConfig
}) => {
  return {
    covidence: {
      articleKey: params.candidate.articleKey,
      articleKeySource: params.candidate.articleKeySource,
      files: params.config.files.map((file) => {
        return {
          assetPath: file.assetPath,
          fileRole: file.fileRole,
          format: file.format,
          sourceFileName: file.sourceFileName,
        }
      }),
      mode: params.config.mode,
      sourceFileNames: params.candidate.sourceRows.map((row) => {
        return row.sourceFileName
      }),
      stageMembership: params.candidate.stageMembership,
      tags: params.candidate.tags,
    },
  }
}

const getCovidenceImportRows = (params: {
  config: CovidencePackageConfig
  importRoute: string
}): ArticleImportStoreRow[] => {
  const mergedResult = getCovidencePackageRowsFromConfig(params.config)

  return mergedResult.candidates.map((candidate) => {
    const articleId = `${params.importRoute}:${getSafeIdentityPart(candidate.articleKey)}`
    const originalData = getCovidenceImportOriginalData(candidate)

    return {
      articleAuthors: candidate.citation.authors
        ? candidate.citation.authors
            .split(';')
            .map((author) => {
              return author.trim()
            })
            .filter((author) => {
              return author !== ''
            })
        : null,
      articleId,
      articleSummary: candidate.citation.abstract ?? null,
      articleTitle: candidate.citation.title?.trim() || `Covidence article ${candidate.articleKey}`,
      doi: normalizeDoi(candidate.citation.doi),
      importRoute: params.importRoute,
      originalData,
      pubmedId: getCovidenceCitationValue(candidate.citation, covidencePmidKeys),
      sourceMetadata: getCovidenceImportSourceMetadata({candidate, config: params.config}),
      url: candidate.citation.url ?? null,
    }
  })
}

const getCovidenceImportResultFromConfig = async (params: {
  config: CovidencePackageConfig
  importRoute: string
  tx?: ArticleImportStoreTx
}): Promise<CovidenceImportResult> => {
  const rows = getCovidenceImportRows(params)

  if (params.tx) {
    const importRefreshState = await syncImportedArticlesWithTx({importRoute: params.importRoute, rows, tx: params.tx})

    return {
      config: params.config,
      importRouteIds: importRefreshState.importRouteIds,
      stats: {importedCount: rows.length, itemCount: rows.length},
    }
  }

  await storeImportedArticles(rows)

  return {config: params.config, stats: {importedCount: rows.length, itemCount: rows.length}}
}

const getCovidenceHumanJudgmentAnswer = (stageMembership: Record<CovidenceFileRole, boolean>) => {
  return stageMembership.irrelevant ? 'no' : stageMembership.full_text ? 'yes' : null
}

const getCovidenceHumanJudgmentSeeds = (params: {config: CovidencePackageConfig; importRoute: string}) => {
  return getCovidencePackageRowsFromConfig(params.config).candidates.map<CovidenceHumanJudgmentSeed>((candidate) => {
    const answer = getCovidenceHumanJudgmentAnswer(candidate.stageMembership)

    return {
      answer,
      articleExternalId: `${params.importRoute}:${getSafeIdentityPart(candidate.articleKey)}`,
      isAnswered: answer !== null,
    }
  })
}

const getCovidenceFullTextProjectScopeSeeds = (params: {config: CovidencePackageConfig; importRoute: string}) => {
  return getCovidencePackageRowsFromConfig(params.config).candidates.flatMap<CovidenceProjectScopeSeed>((candidate) => {
    return candidate.stageMembership.full_text
      || candidate.stageMembership.excluded
      || candidate.stageMembership.included
      ? [{articleExternalId: `${params.importRoute}:${getSafeIdentityPart(candidate.articleKey)}`}]
      : []
  })
}

const getCovidenceEnabledProjectPromptIds = async (params: {projectId: string; tx?: CovidenceProjectTx}) => {
  return await getCovidenceProjectQueryRunner(params.tx).queryJson<{promptId: string}>(`
    SELECT prompt_id AS promptId
    FROM app.project_prompt
    WHERE project_id = ${getSqlLiteral(params.projectId)}
      AND archived = FALSE
      AND enabled = TRUE
  `)
}

const getChunkedCovidenceHumanJudgmentSeeds = (
  seeds: CovidenceHumanJudgmentSeed[],
  chunkSize: number,
): CovidenceHumanJudgmentSeed[][] => {
  return seeds.length <= chunkSize
    ? [seeds]
    : [seeds.slice(0, chunkSize), ...getChunkedCovidenceHumanJudgmentSeeds(seeds.slice(chunkSize), chunkSize)]
}

const getCovidenceInternalArticleIds = async (params: {articleExternalIds: string[]; tx?: CovidenceProjectTx}) => {
  return params.articleExternalIds.length === 0
    ? []
    : await getCovidenceProjectQueryRunner(params.tx).queryJson<{articleExternalId: string; articleId: string}>(`
        SELECT article_id AS articleExternalId, id AS articleId
        FROM app.article
        WHERE article_id IN (${getQuotedStringList(params.articleExternalIds).join(', ')})
      `)
}

const syncCovidenceSeededProjectArticles = async (params: {
  articleIds: string[]
  projectId: string
  tx?: CovidenceProjectTx
}) => {
  const queryRunner = getCovidenceProjectQueryRunner(params.tx)

  await queryRunner.run(`
    DELETE FROM app.project_article
    WHERE project_id = ${getSqlLiteral(params.projectId)}
      AND imported_from_project_id = ${getSqlLiteral(params.projectId)}
      ${
        params.articleIds.length > 0
          ? `AND article_id NOT IN (${getQuotedStringList(params.articleIds).join(', ')})`
          : ''
      }
  `)

  return params.articleIds.length === 0
    ? undefined
    : await queryRunner.run(`
        INSERT INTO app.project_article (id, project_id, article_id, imported_from_project_id)
        VALUES ${params.articleIds
          .map((articleId) => {
            return `(${getQuotedStringList([globalThis.crypto.randomUUID(), params.projectId, articleId, params.projectId]).join(', ')})`
          })
          .join(', ')}
        ON CONFLICT(project_id, article_id) DO NOTHING
      `)
}

export const buildCovidencePackageConfig = (params: {
  mode: CovidenceImportMode
  files: CovidencePackageFile[]
}): CovidencePackageConfig => {
  return {kind: 'covidence_import', version: 1, mode: params.mode, files: getValidatedCovidencePackageFiles(params)}
}

export const buildCovidencePromptDefinition = (params: {
  answerSet: CovidencePromptAnswerSet
  exclusionCriteria: string
  inclusionCriteria: string
  mode: CovidenceImportMode
}): CovidencePromptDefinition => {
  return {
    originalText: getCovidencePromptText(params),
    promptHeading: covidencePromptHeadingByMode[params.mode],
    type: getCovidencePromptType(params.answerSet),
  }
}

export const getOrCreateCovidencePrompt = async (params: {
  answerSet: CovidencePromptAnswerSet
  exclusionCriteria: string
  inclusionCriteria: string
  mode: CovidenceImportMode
  tx?: CovidencePromptTx
}): Promise<CovidencePromptRecord> => {
  const promptDefinition = buildCovidencePromptDefinition(params)
  const contentHash = computePromptContentHash(
    promptDefinition.originalText,
    null,
    promptDefinition.promptHeading,
    promptDefinition.type,
  )
  const queryRunner = getCovidencePromptQueryRunner(params.tx)
  const [existingPrompt] = await queryRunner.queryJson<{id: string}>(`
    SELECT id
    FROM app.prompt
    WHERE content_hash = ${getSqlLiteral(contentHash)}
      AND archived = FALSE
    LIMIT 1
  `)

  if (existingPrompt) {
    return {...promptDefinition, created: false, id: existingPrompt.id}
  }

  const [insertedPrompt] = await queryRunner.queryJson<{id: string}>(`
    INSERT INTO app.prompt (id, original_text, transformed_text, prompt_heading, type, content_hash, archived)
    VALUES (
      '${escapeSqlString(globalThis.crypto.randomUUID())}',
      ${getSqlLiteral(promptDefinition.originalText)},
      NULL,
      ${getSqlLiteral(promptDefinition.promptHeading)},
      ${getSqlLiteral(promptDefinition.type)},
      ${getSqlLiteral(contentHash)},
      FALSE
    )
    RETURNING id
  `)

  if (!insertedPrompt) {
    throw new Error('Failed to create Covidence prompt')
  }

  return {...promptDefinition, created: true, id: insertedPrompt.id}
}

export const getOrCreateCovidenceProject = async (params: {
  importRoute: string
  mode: CovidenceImportMode
  promptId?: string | null
  title: string
  tx?: CovidenceProjectTx
}): Promise<CovidenceProjectRecord> => {
  const existingProject = await getCovidenceProjectByImportRoute(params)
  const queryRunner = getCovidenceProjectQueryRunner(params.tx)

  if (existingProject) {
    if (params.promptId) {
      await queryRunner.run(`
        INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, archived, enabled, origin_project_id)
        VALUES (
          '${escapeSqlString(globalThis.crypto.randomUUID())}',
          '${escapeSqlString(existingProject.id)}',
          '${escapeSqlString(params.promptId)}',
          0,
          FALSE,
          TRUE,
          NULL
        )
        ON CONFLICT(project_id, prompt_id) DO UPDATE SET
          prompt_order = EXCLUDED.prompt_order,
          archived = FALSE,
          enabled = TRUE,
          updated_at = now()
      `)
    }

    return {...existingProject, created: false}
  }

  const [importRouteRow] = await queryRunner.queryJson<{id: string}>(`
    SELECT id
    FROM app.import_route
    WHERE route = ${getSqlLiteral(params.importRoute)}
    LIMIT 1
  `)

  if (!importRouteRow) {
    throw new Error('Covidence import route not found for project creation')
  }

  const settings = getCovidenceProjectSettings(params.mode)
  const projectId = globalThis.crypto.randomUUID()
  const modelId = await getDefaultCovidenceProjectModelId()

  await queryRunner.run(`
    INSERT INTO app.project (
      id,
      name,
      model_id,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images
    )
    VALUES (
      '${escapeSqlString(projectId)}',
      ${getSqlLiteral(params.title)},
      '${escapeSqlString(modelId)}',
      ${settings.useTitle ? 'TRUE' : 'FALSE'},
      ${settings.useAbstract ? 'TRUE' : 'FALSE'},
      ${settings.useFulltext ? 'TRUE' : 'FALSE'},
      ${settings.useFulltextNoImages ? 'TRUE' : 'FALSE'}
    )
  `)

  await queryRunner.run(`
    INSERT INTO app.project_import_route (id, project_id, import_route_id)
    VALUES (
      '${escapeSqlString(globalThis.crypto.randomUUID())}',
      '${escapeSqlString(projectId)}',
      '${escapeSqlString(importRouteRow.id)}'
    )
    ON CONFLICT(project_id, import_route_id) DO NOTHING
  `)

  if (params.promptId) {
    await queryRunner.run(`
      INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, archived, enabled, origin_project_id)
      VALUES (
        '${escapeSqlString(globalThis.crypto.randomUUID())}',
        '${escapeSqlString(projectId)}',
        '${escapeSqlString(params.promptId)}',
        0,
        FALSE,
        TRUE,
        NULL
      )
      ON CONFLICT(project_id, prompt_id) DO NOTHING
    `)
  }

  return {created: true, id: projectId, modelId, name: params.title, ...settings}
}

export const syncCovidenceProjectScopeFromConfig = async (params: {
  config: CovidencePackageConfig
  importRoute: string
  projectId?: string | null
  tx?: CovidenceProjectTx
}) => {
  if (params.config.mode !== 'full_text') {
    return
  }

  const project = params.projectId
    ? ({id: params.projectId} as Pick<CovidenceProjectRecord, 'id'>)
    : await getCovidenceProjectByImportRoute({importRoute: params.importRoute, tx: params.tx})

  if (!project) {
    return
  }

  const scopeSeeds = getCovidenceFullTextProjectScopeSeeds({config: params.config, importRoute: params.importRoute})
  const articleRows = await getCovidenceInternalArticleIds({
    articleExternalIds: scopeSeeds.map((scopeSeed) => {
      return scopeSeed.articleExternalId
    }),
    tx: params.tx,
  })
  const articleIds = articleRows.map((articleRow) => {
    return articleRow.articleId
  })

  await syncCovidenceSeededProjectArticles({articleIds, projectId: project.id, tx: params.tx})
}

export const seedCovidenceHumanJudgmentsFromConfig = async (params: {
  config: CovidencePackageConfig
  importRoute: string
  projectId?: string | null
  tx?: CovidenceProjectTx
}) => {
  if (params.config.mode !== 'title_abstract') {
    return
  }

  const project = params.projectId
    ? ({id: params.projectId} as Pick<CovidenceProjectRecord, 'id'>)
    : await getCovidenceProjectByImportRoute({importRoute: params.importRoute, tx: params.tx})

  if (!project) {
    return
  }

  const promptRows = await getCovidenceEnabledProjectPromptIds({projectId: project.id, tx: params.tx})
  const promptIds = promptRows.map((promptRow) => {
    return promptRow.promptId
  })
  const judgmentSeeds = getCovidenceHumanJudgmentSeeds({config: params.config, importRoute: params.importRoute})

  if (promptIds.length === 0 || judgmentSeeds.length === 0) {
    return
  }

  const articleRows = await getCovidenceInternalArticleIds({
    articleExternalIds: judgmentSeeds.map((judgmentSeed) => {
      return judgmentSeed.articleExternalId
    }),
    tx: params.tx,
  })
  const articleIdByExternalId = new Map(
    articleRows.map((articleRow) => {
      return [articleRow.articleExternalId, articleRow.articleId]
    }),
  )
  const articleIds = judgmentSeeds.flatMap((judgmentSeed) => {
    const articleId = articleIdByExternalId.get(judgmentSeed.articleExternalId)

    return articleId ? [articleId] : []
  })

  if (articleRows.length === 0) {
    return
  }

  const queryRunner = getCovidenceProjectQueryRunner(params.tx)
  await syncCovidenceSeededProjectArticles({articleIds, projectId: project.id, tx: params.tx})
  await getChunkedCovidenceHumanJudgmentSeeds(judgmentSeeds, 500).reduce<Promise<void>>(
    (previousRun, judgmentSeedChunk) => {
      return previousRun.then(() => {
        const insertValues = promptIds
          .flatMap((promptId) => {
            return judgmentSeedChunk.map((judgmentSeed) => {
              const articleId = articleIdByExternalId.get(judgmentSeed.articleExternalId)

              return articleId
                ? `(${getQuotedStringList([globalThis.crypto.randomUUID(), project.id, articleId, promptId]).join(', ')}, ${getSqlLiteral(judgmentSeed.isAnswered)}, ${getSqlLiteral(judgmentSeed.answer)}, NULL)`
                : null
            })
          })
          .filter((value): value is string => {
            return value !== null
          })
          .join(', ')

        return insertValues === ''
          ? Promise.resolve()
          : queryRunner.run(`
      INSERT INTO app.judgment_human (id, project_id, article_id, prompt_id, is_answered, answer, comment)
      VALUES ${insertValues}
      ON CONFLICT(project_id, article_id, prompt_id) DO UPDATE SET
        is_answered = EXCLUDED.is_answered,
        answer = EXCLUDED.answer,
        comment = EXCLUDED.comment,
        updated_at = now()
    `)
      })
    },
    Promise.resolve(),
  )
}

export const clearCovidenceSeededHumanJudgments = async (params: {importRoute: string; tx?: CovidenceProjectTx}) => {
  const project = await getCovidenceProjectByImportRoute({importRoute: params.importRoute, tx: params.tx})

  if (!project) {
    return
  }

  const queryRunner = getCovidenceProjectQueryRunner(params.tx)

  await queryRunner.run(`
    DELETE FROM app.judgment_human
    WHERE project_id = ${getSqlLiteral(project.id)}
  `)

  await queryRunner.run(`
    DELETE FROM app.project_article
    WHERE project_id = ${getSqlLiteral(project.id)}
      AND imported_from_project_id = ${getSqlLiteral(project.id)}
  `)
}

export const getCovidencePackageConfig = (cursor: string | null) => {
  return getCovidencePackageConfigValue(cursor)
}

export const getCovidencePackageCursor = (config: CovidencePackageConfig) => {
  return getCovidencePackageConfigCursor(config)
}

export const storeCovidencePackageFiles = async (params: {
  datasourceId: string
  files: Array<{file: CovidencePackageUploadInput; fileRole: CovidenceFileRole}>
}) => {
  ensureCovidencePackageFolder(params.datasourceId)

  return await Promise.all(
    params.files.map(async ({file, fileRole}) => {
      const sourceFileName = file.name?.trim() || `${fileRole}.upload`
      const format = getCovidenceFileFormatFromName(sourceFileName)

      if (!format) {
        throw new Error('Only Covidence CSV and RIS files are supported')
      }

      const sanitizedFileName = getSanitizedFileName(sourceFileName)
      const assetPath = `${covidenceImportPathPrefix}/${params.datasourceId}/${fileRole}-${sanitizedFileName}`
      const absolutePath = path.resolve(process.cwd(), assetPath)

      writeFileSync(absolutePath, await file.text())

      return {assetPath, fileRole, format, sourceFileName}
    }),
  )
}

export const getCovidencePackageFileContent = (assetPath: string) => {
  const absolutePath = getCovidencePackageAbsolutePath(assetPath)

  if (!absolutePath) {
    throw new Error('Invalid Covidence package asset path')
  }

  return readFileSync(absolutePath, 'utf8')
}

const parseCovidenceCsvReferenceRowsInternal = (params: {
  content: string
  fileRole: CovidenceFileRole
  format: CovidenceFileFormat
  sourceFileName: string
}): CovidenceCsvParseResult => {
  if (params.format !== 'csv') {
    return getCovidenceCsvParseError({
      code: 'unsupported_format',
      fileRole: params.fileRole,
      message: `Covidence reference parsing only supports CSV inputs, got '${params.format}'`,
      sourceFileName: params.sourceFileName,
    })
  }

  const parsedRows = getParsedCovidenceCsvRows(params.content.replace(/^\uFEFF/, ''))

  if (!parsedRows) {
    return getCovidenceCsvParseError({
      code: 'malformed_csv',
      fileRole: params.fileRole,
      message: 'Covidence CSV has an unclosed quoted field',
      sourceFileName: params.sourceFileName,
    })
  }

  if (
    parsedRows.length === 0
    || parsedRows.every((row) => {
      return row.every((value) => {
        return value.trim() === ''
      })
    })
  ) {
    return getCovidenceCsvParseError({
      code: 'empty_file',
      fileRole: params.fileRole,
      message: 'Covidence CSV is empty',
      sourceFileName: params.sourceFileName,
    })
  }

  const headerRow = parsedRows[0]

  if (
    !headerRow
    || headerRow.every((value) => {
      return value.trim() === ''
    })
  ) {
    return getCovidenceCsvParseError({
      code: 'header_required',
      fileRole: params.fileRole,
      message: 'Covidence CSV requires a header row',
      rowNumber: 1,
      sourceFileName: params.sourceFileName,
    })
  }

  const headerResult = getCovidenceCsvHeaders({
    fileRole: params.fileRole,
    headers: headerRow,
    sourceFileName: params.sourceFileName,
  })

  if (isCovidenceCsvParseFailure(headerResult)) {
    return {error: headerResult.error, ok: false}
  }

  const rowLengthMismatch = parsedRows.slice(1).find((row) => {
    return row.length !== headerResult.normalizedHeaders.length
  })
  const rowLengthMismatchIndex = rowLengthMismatch ? parsedRows.indexOf(rowLengthMismatch) : -1

  if (rowLengthMismatch && rowLengthMismatchIndex !== -1) {
    return getCovidenceCsvParseError({
      code: 'row_length_mismatch',
      fileRole: params.fileRole,
      message: `Covidence CSV row ${rowLengthMismatchIndex + 1} has ${rowLengthMismatch.length} fields; expected ${headerResult.normalizedHeaders.length}`,
      rowNumber: rowLengthMismatchIndex + 1,
      sourceFileName: params.sourceFileName,
    })
  }

  return {
    ok: true,
    rows: parsedRows.slice(1).map((row, index) => {
      return getCovidenceReferenceRow({
        fileRole: params.fileRole,
        normalizedHeaders: headerResult.normalizedHeaders,
        rowNumber: index + 2,
        sourceFileName: params.sourceFileName,
        values: row,
      })
    }),
  }
}

const parseCovidenceRisReferenceRows = (params: {
  content: string
  fileRole: CovidenceFileRole
  format: CovidenceFileFormat
  sourceFileName: string
}): CovidenceCsvParseResult => {
  if (params.format !== 'ris') {
    return getCovidenceCsvParseError({
      code: 'unsupported_format',
      fileRole: params.fileRole,
      message: `Covidence reference parsing only supports RIS inputs, got '${params.format}'`,
      sourceFileName: params.sourceFileName,
    })
  }

  const parsedRecords = getParsedCovidenceRisRecords(params)

  if (parsedRecords.ok === false) {
    return parsedRecords
  }

  return {
    ok: true,
    rows: parsedRecords.records.map((fields, index) => {
      return getCovidenceReferenceRowFromEntries({
        citationEntries: getCovidenceRisEntries(fields),
        exclusionReason: null,
        fileRole: params.fileRole,
        notes: getCovidenceRisSingleValue(fields, covidenceRisNoteKeys),
        rowNumber: index + 1,
        sourceFileName: params.sourceFileName,
        tags: getCovidenceRisFieldValues(fields, covidenceRisTagKeys),
      })
    }),
  }
}

export const parseCovidenceReferenceRows = (params: {
  content: string
  fileRole: CovidenceFileRole
  format: CovidenceFileFormat
  sourceFileName: string
}): CovidenceCsvParseResult => {
  return params.format === 'csv'
    ? parseCovidenceCsvReferenceRowsInternal(params)
    : parseCovidenceRisReferenceRows(params)
}

export const mergeCovidenceReferenceRows = (rows: CovidenceReferenceRow[]): CovidenceReferenceMergeResult => {
  const canonicalState = rows
    .filter((row) => {
      return row.fileRole === 'all'
    })
    .reduce(
      (state, row) => {
        const key = getCovidenceRowKey(row)
        const articleKey = key ? `${key.source}:${key.value}` : `unkeyed:${row.sourceFileName}:${row.rowNumber}`
        const existingCandidate = state.candidateMap.get(articleKey)
        const candidateState = getCovidenceCandidateState({
          articleKeySource: key?.source ?? 'unkeyed',
          canonicalRow: existingCandidate?.canonicalRow ?? row,
          sourceRows: [...(existingCandidate?.sourceRows ?? []), row],
        })

        state.candidateMap.set(articleKey, candidateState)

        return {...state, articleKeys: existingCandidate ? state.articleKeys : [...state.articleKeys, articleKey]}
      },
      {articleKeys: [] as string[], candidateMap: new Map<string, CovidenceCanonicalCandidateState>()},
    )
  const missingMatches: CovidenceMergeMissingMatch[] = []
  const candidateMap = rows.filter(isCovidenceOverlayRow).reduce((rowMap, row) => {
    const key = getCovidenceRowKey(row)
    const articleKey = key ? `${key.source}:${key.value}` : null
    const existingCandidate = articleKey ? rowMap.get(articleKey) : null

    if (!articleKey || !existingCandidate) {
      missingMatches.push({
        articleKey,
        articleKeySource: key?.source ?? null,
        fileRole: row.fileRole,
        rowNumber: row.rowNumber,
        sourceFileName: row.sourceFileName,
      })

      return rowMap
    }

    rowMap.set(articleKey, {
      articleKeySource: existingCandidate.articleKeySource,
      canonicalRow: existingCandidate.canonicalRow,
      sourceRows: [...existingCandidate.sourceRows, row],
    })

    return rowMap
  }, new Map(canonicalState.candidateMap))
  const candidates = canonicalState.articleKeys.map((articleKey) => {
    const candidateState = candidateMap.get(articleKey)

    if (!candidateState) {
      throw new Error('Expected Covidence candidate state')
    }

    return getCovidenceMergedArticleCandidate({
      articleKey,
      articleKeySource: candidateState.articleKeySource,
      canonicalRow: candidateState.canonicalRow,
      sourceRows: candidateState.sourceRows,
    })
  })

  return {candidates, warnings: {conflictingStageMemberships: getCovidenceConflictWarnings(candidates), missingMatches}}
}

export const parseCovidenceCsvReferenceRows = (params: {
  content: string
  fileRole: CovidenceFileRole
  format: CovidenceFileFormat
  sourceFileName: string
}) => {
  return parseCovidenceCsvReferenceRowsInternal(params)
}

export const analyzeCovidencePackageFiles = async (params: {
  files: CovidenceAnalyzeUploadFile[]
  mode: CovidenceImportMode
}): Promise<CovidenceAnalyzeResponse> => {
  const uploads = params.files.filter((file) => {
    return file.file instanceof Blob
  })
  const fileRoleValidationMessage =
    uploads.length === params.files.length
      ? getCovidenceFileRoleValidationMessage({
          fileRoles: uploads.map((file) => {
            return file.fileRole
          }),
          mode: params.mode,
        })
      : null
  const uploadValidationMessage =
    uploads.length === params.files.length ? null : 'Covidence analyze requires valid uploaded files'

  if (uploadValidationMessage || fileRoleValidationMessage) {
    return {
      error: {
        code: uploadValidationMessage ? 'invalid_upload' : 'invalid_file_roles',
        message: uploadValidationMessage ?? fileRoleValidationMessage ?? 'Invalid Covidence analyze input',
      },
      ok: false,
    }
  }

  const filesWithContent = await Promise.all(
    getSortedCovidenceAnalyzeFiles(params.mode, uploads).map(async ({file, fileRole}) => {
      const sourceFileName = file.name?.trim() || `${fileRole}.upload`
      const format = getCovidenceFileFormatFromName(sourceFileName)

      return {content: await file.text(), fileRole, format, sourceFileName}
    }),
  )
  const invalidFormatFile = filesWithContent.find((file) => {
    return file.format === null
  })

  if (invalidFormatFile) {
    return {
      error: {
        code: 'unsupported_format',
        message: `Only Covidence CSV and RIS files are supported, got '${invalidFormatFile.sourceFileName}'`,
      },
      ok: false,
    }
  }

  const validFormatFiles = filesWithContent.filter((file): file is typeof file & {format: CovidenceFileFormat} => {
    return file.format !== null
  })

  const parsedFiles = validFormatFiles.map((file) => {
    const parsedResult = parseCovidenceReferenceRows({
      content: file.content,
      fileRole: file.fileRole,
      format: file.format,
      sourceFileName: file.sourceFileName,
    })

    return {file, parsedResult}
  })
  const parseFailure = parsedFiles.find((entry) => {
    return entry.parsedResult.ok === false
  })

  if (parseFailure && parseFailure.parsedResult.ok === false) {
    return {
      error: {
        code: 'parse_error',
        message: parseFailure.parsedResult.error.message,
        parseError: parseFailure.parsedResult.error,
      },
      ok: false,
    }
  }

  const detectedFiles = parsedFiles.flatMap((entry) => {
    return entry.parsedResult.ok
      ? [
          {
            fileRole: entry.file.fileRole,
            format: entry.file.format,
            rowCount: entry.parsedResult.rows.length,
            sourceFileName: entry.file.sourceFileName,
          },
        ]
      : []
  })
  const mergedResult = mergeCovidenceReferenceRows(
    parsedFiles.flatMap((entry) => {
      return entry.parsedResult.ok ? entry.parsedResult.rows : []
    }),
  )

  return mergedResult.warnings.conflictingStageMemberships.length > 0
    ? {
        error: {
          code: 'conflicting_stage_memberships',
          message: 'Covidence package has mutually exclusive stage memberships',
          warnings: mergedResult.warnings,
        },
        ok: false,
      }
    : {
        data: {
          counts: {
            conflictingStageMembershipCount: mergedResult.warnings.conflictingStageMemberships.length,
            fileCount: detectedFiles.length,
            filesByRole: getCovidenceRoleCounts(detectedFiles),
            mergedRowCount: mergedResult.candidates.length,
            missingMatchCount: mergedResult.warnings.missingMatches.length,
            rowCount: detectedFiles.reduce((count, file) => {
              return count + file.rowCount
            }, 0),
            rowsByRole: getCovidenceRoleCounts(
              parsedFiles.flatMap((entry) => {
                return entry.parsedResult.ok ? entry.parsedResult.rows : []
              }),
            ),
          },
          detectedFiles,
          mode: params.mode,
          sampleMergedRows: mergedResult.candidates.slice(0, 5).map((candidate) => {
            return {
              articleKey: candidate.articleKey,
              articleKeySource: candidate.articleKeySource,
              citation: candidate.citation,
              exclusionReasons: candidate.exclusionReasons,
              notes: candidate.notes,
              stageMembership: candidate.stageMembership,
              tags: candidate.tags,
            }
          }),
          warnings: mergedResult.warnings,
        },
        ok: true,
      }
}

export const deleteCovidencePackageFiles = (datasourceId: string) => {
  rmSync(getCovidencePackageFolder(datasourceId), {force: true, recursive: true})
}

export const importCovidencePackageFromConfig = async (params: {
  config: CovidencePackageConfig
  datasourceId: string
  importRoute: string
  tx?: ArticleImportStoreTx
}) => {
  return await getCovidenceImportResultFromConfig({
    config: params.config,
    importRoute: params.importRoute,
    tx: params.tx,
  })
}
