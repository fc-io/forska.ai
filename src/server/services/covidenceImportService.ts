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
import {getProjectMartRefreshStateService} from './projectMartRefreshStateService.ts'

type CovidenceImportMode = 'title_abstract' | 'full_text'
type CovidenceFileRole = 'all' | 'irrelevant' | 'full_text' | 'excluded' | 'included'
type CovidenceFileFormat = 'csv' | 'ris'
type CovidencePromptAnswerSet = 'yes|no' | 'yes|no|maybe' | 'yes_no' | 'yes_no_maybe'
type CovidencePromptTx = {queryJson: <TRow>(statement: string) => Promise<TRow[]>}
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
type CovidenceStudyKeySource = 'doi' | 'pmid' | 'reference_id' | 'title_year_first_author'
type CovidenceRecordKeySource = 'covidence' | CovidenceStudyKeySource
type CovidenceStudyKey = {source: CovidenceStudyKeySource; value: string}
type CovidenceRecordKey = {source: CovidenceRecordKeySource; value: string}
type CovidenceMergedArticleCandidate = {
  articleKey: string
  articleKeySource: CovidenceRecordKeySource | 'unkeyed'
  citation: Record<string, string | null>
  covidenceIds: string[]
  duplicateStudyRecordCount: number
  exclusionReasons: string[]
  hasDuplicateStudyRecords: boolean
  hasStudyDecisionConflict: boolean
  isSeededHumanJudgmentAnswered: boolean
  notes: string[]
  referenceIds: string[]
  seededHumanJudgmentAnswer: 'no' | 'yes' | null
  sourceRows: CovidenceReferenceRow[]
  stageMembership: Record<CovidenceFileRole, boolean>
  studyDecisionAnswers: Array<'no' | 'yes'>
  studyKey: string | null
  studyKeySource: CovidenceStudyKeySource | null
  tags: string[]
}
type CovidenceMergeMissingMatch = {
  articleKey: string | null
  articleKeySource: CovidenceRecordKeySource | null
  fileRole: Exclude<CovidenceFileRole, 'all'>
  rowNumber: number
  sourceFileName: string
}
type CovidenceMergeConflict = {
  articleKey: string
  conflictingFileRoles: CovidenceFileRole[]
  sourceRows: CovidenceReferenceRow[]
}
type CovidenceStudyGroupWarningRecord = {
  articleKey: string
  articleKeySource: CovidenceRecordKeySource | 'unkeyed'
  covidenceIds: string[]
  referenceIds: string[]
  seededHumanJudgmentAnswer: 'no' | 'yes' | null
  stageMembership: Record<CovidenceFileRole, boolean>
  title: string | null
}
type CovidenceStudyGroupWarning = {
  articleCount: number
  records: CovidenceStudyGroupWarningRecord[]
  studyKey: string
  studyKeySource: CovidenceStudyKeySource
}
type CovidenceReferenceMergeResult = {
  candidates: CovidenceMergedArticleCandidate[]
  warnings: {
    conflictingStageMemberships: CovidenceMergeConflict[]
    duplicateStudyGroups: CovidenceStudyGroupWarning[]
    missingMatches: CovidenceMergeMissingMatch[]
    studyDecisionConflicts: CovidenceStudyGroupWarning[]
  }
}
type CovidenceCanonicalCandidateState = {
  articleKeySource: CovidenceRecordKeySource | 'unkeyed'
  canonicalRow: CovidenceReferenceRow
  sourceRows: CovidenceReferenceRow[]
}
type CovidenceCanonicalState = {articleKeys: string[]; candidateMap: Map<string, CovidenceCanonicalCandidateState>}
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
  | 'articleKey'
  | 'articleKeySource'
  | 'citation'
  | 'duplicateStudyRecordCount'
  | 'exclusionReasons'
  | 'hasDuplicateStudyRecords'
  | 'hasStudyDecisionConflict'
  | 'notes'
  | 'stageMembership'
  | 'studyKey'
  | 'studyKeySource'
  | 'tags'
>
type CovidenceAnalyzeCounts = {
  conflictingStageMembershipCount: number
  duplicateStudyGroupCount: number
  fileCount: number
  filesByRole: Record<CovidenceFileRole, number>
  mergedRowCount: number
  missingMatchCount: number
  rowCount: number
  rowsByRole: Record<CovidenceFileRole, number>
  studyDecisionConflictCount: number
  studyGroupCount: number
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
  criteriaDisposition?: CovidenceEligibilityFieldDisposition
  criteriaSectionKey?: string
  criteriaSectionLabel?: string
  originalText: string
  promptHeading: string
  type: "'yes' | 'no'" | "'yes' | 'no' | 'maybe'"
}
type CovidenceEligibilityFieldDisposition = 'include' | 'exclude' | 'combined'
type CovidencePromptGrouping = 'per_field' | 'per_section' | 'single_prompt'
type CovidenceEligibilityPromptField = {
  disposition: CovidenceEligibilityFieldDisposition
  sectionKey: string
  sectionLabel: string
  text: string
}
type CovidencePromptRecord = CovidencePromptDefinition & {created: boolean; id: string}
type CovidenceProjectRecord = {
  created: boolean
  humanJudgmentMode: 'prompt' | 'summary'
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
type CovidenceProjectPromptLink = {
  criteriaDisposition?: CovidenceEligibilityFieldDisposition
  criteriaSectionKey?: string
  criteriaSectionLabel?: string
  promptId: string
}

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
const covidenceRecordCovidenceKeys = ['covidence', 'covidence_id']
const covidenceRecordReferenceKeys = ['reference_id', 'ref']
const covidenceStudyReferenceKeys = ['reference_id', 'ref']
const covidenceYearKeys = ['year', 'publication_year', 'published_year', 'publication_date', 'date']
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
  return answerSet === 'yes|no|maybe' || answerSet === 'yes_no_maybe' ? ['yes', 'no', 'maybe'] : ['yes', 'no']
}

const getCovidencePromptCriteriaText = (criteria: string) => {
  const trimmedCriteria = criteria.trim()

  return trimmedCriteria === '' ? '(none provided)' : trimmedCriteria
}

const getCovidencePromptEligibilityHeadingDispositionLabel = (disposition: CovidenceEligibilityFieldDisposition) => {
  return disposition === 'include' ? 'Inclusion' : 'Exclusion'
}

const getCovidencePromptEligibilityGuidance = (params: {
  answerSet: CovidencePromptAnswerSet
  disposition: CovidenceEligibilityFieldDisposition
  sectionLabel: string
}) => {
  const description = `${params.sectionLabel} ${params.disposition === 'include' ? 'inclusion' : 'exclusion'} criteria`
  const lines =
    params.disposition === 'include'
      ? [
          `Review only the ${description} below.`,
          `Answer yes if the study matches the ${description}.`,
          `Answer no if the study does not match the ${description}.`,
        ]
      : [
          `Review only the ${description} below.`,
          `Answer yes if the study matches any of the ${description}.`,
          `Answer no if the study does not match any of the ${description}.`,
        ]

  return getCovidencePromptAnswerValues(params.answerSet).includes('maybe')
    ? [...lines, 'Answer maybe if the report does not provide enough information to decide.'].join('\n')
    : lines.join('\n')
}

const getCovidencePromptEligibilityCriteriaHeading = (params: {
  disposition: CovidenceEligibilityFieldDisposition
  sectionLabel: string
}) => {
  return params.disposition === 'include'
    ? `${params.sectionLabel} inclusion criteria:`
    : `${params.sectionLabel} exclusion criteria:`
}

const getCovidenceCombinedPromptDecisionRules = (params: {
  answerSet: CovidencePromptAnswerSet
  mode: CovidenceImportMode
}) => {
  const maybeRule = getCovidencePromptAnswerValues(params.answerSet).includes('maybe')
    ? [
        `Answer maybe if the report does not provide enough information to determine whether the study should be included ${params.mode === 'full_text' ? 'in the final review' : 'for full text review'}.`,
      ]
    : []

  return [
    `Answer yes only if all inclusion criteria are satisfied and none of the exclusion criteria apply.`,
    `Answer no if any inclusion criterion is not satisfied or any exclusion criterion applies.`,
    ...maybeRule,
  ].join('\n')
}

const getCovidenceCombinedPromptCriteriaHeading = (disposition: 'include' | 'exclude') => {
  return disposition === 'include'
    ? 'Inclusion criteria (evaluate in order):'
    : 'Exclusion criteria (evaluate in order):'
}

const getCovidencePromptText = (params: {
  answerSet: CovidencePromptAnswerSet
  exclusionCriteria: string
  inclusionCriteria: string
  mode: CovidenceImportMode
}) => {
  return [
    covidencePromptQuestionByMode[params.mode],
    '',
    getCovidenceCombinedPromptDecisionRules(params),
    '',
    `${getCovidenceCombinedPromptCriteriaHeading('include')}\n${getCovidencePromptCriteriaText(params.inclusionCriteria)}`,
    '',
    `${getCovidenceCombinedPromptCriteriaHeading('exclude')}\n${getCovidencePromptCriteriaText(params.exclusionCriteria)}`,
  ].join('\n')
}

const getCovidencePromptType = (answerSet: CovidencePromptAnswerSet): CovidencePromptDefinition['type'] => {
  return answerSet === 'yes|no|maybe' || answerSet === 'yes_no_maybe' ? "'yes' | 'no' | 'maybe'" : "'yes' | 'no'"
}

const buildCovidencePromptDefinitionForEligibilityField = (params: {
  answerSet: CovidencePromptAnswerSet
  eligibilityField: CovidenceEligibilityPromptField
  mode: CovidenceImportMode
}): CovidencePromptDefinition => {
  return {
    criteriaDisposition: params.eligibilityField.disposition,
    criteriaSectionKey: params.eligibilityField.sectionKey.trim(),
    criteriaSectionLabel: params.eligibilityField.sectionLabel.trim(),
    originalText: [
      getCovidencePromptEligibilityGuidance({
        answerSet: params.answerSet,
        disposition: params.eligibilityField.disposition,
        sectionLabel: params.eligibilityField.sectionLabel,
      }),
      '',
      getCovidencePromptEligibilityCriteriaHeading({
        disposition: params.eligibilityField.disposition,
        sectionLabel: params.eligibilityField.sectionLabel,
      }),
      params.eligibilityField.text,
    ].join('\n'),
    promptHeading: `Matches ${params.eligibilityField.sectionLabel} ${getCovidencePromptEligibilityHeadingDispositionLabel(params.eligibilityField.disposition)}`,
    type: getCovidencePromptType(params.answerSet),
  }
}

const getNormalizedCovidenceEligibilityPromptFields = (eligibilityFields: CovidenceEligibilityPromptField[]) => {
  return eligibilityFields
    .map((eligibilityField) => {
      return {
        disposition: eligibilityField.disposition,
        sectionKey: eligibilityField.sectionKey.trim(),
        sectionLabel: eligibilityField.sectionLabel.trim(),
        text: eligibilityField.text.trim(),
      }
    })
    .filter((eligibilityField) => {
      return eligibilityField.text !== ''
    })
}

const getCovidencePromptCriteriaGroups = (params: {
  eligibilityFields: CovidenceEligibilityPromptField[]
  promptGrouping: CovidencePromptGrouping
}) => {
  const normalizedEligibilityFields = getNormalizedCovidenceEligibilityPromptFields(params.eligibilityFields)

  return params.promptGrouping === 'per_section'
    ? normalizedEligibilityFields.reduce(
        (groups, eligibilityField) => {
          const existingGroup = groups.find((group) => {
            return group.sectionKey === eligibilityField.sectionKey
          })

          return existingGroup
            ? groups.map((group) => {
                return group.sectionKey === eligibilityField.sectionKey
                  ? {
                      ...group,
                      exclusionCriteria:
                        eligibilityField.disposition === 'exclude'
                          ? [...group.exclusionCriteria, eligibilityField.text]
                          : group.exclusionCriteria,
                      inclusionCriteria:
                        eligibilityField.disposition === 'include'
                          ? [...group.inclusionCriteria, eligibilityField.text]
                          : group.inclusionCriteria,
                    }
                  : group
              })
            : [
                ...groups,
                {
                  exclusionCriteria: eligibilityField.disposition === 'exclude' ? [eligibilityField.text] : [],
                  inclusionCriteria: eligibilityField.disposition === 'include' ? [eligibilityField.text] : [],
                  sectionKey: eligibilityField.sectionKey,
                  sectionLabel: eligibilityField.sectionLabel,
                },
              ]
        },
        [] as Array<{
          exclusionCriteria: string[]
          inclusionCriteria: string[]
          sectionKey: string
          sectionLabel: string
        }>,
      )
    : normalizedEligibilityFields.length === 0
      ? []
      : [
          {
            exclusionCriteria: normalizedEligibilityFields.flatMap((eligibilityField) => {
              return eligibilityField.disposition === 'exclude' ? [eligibilityField.text] : []
            }),
            inclusionCriteria: normalizedEligibilityFields.flatMap((eligibilityField) => {
              return eligibilityField.disposition === 'include' ? [eligibilityField.text] : []
            }),
            sectionKey: null,
            sectionLabel: null,
          },
        ]
}

const buildCovidencePromptDefinitionsPerField = (params: {
  answerSet: CovidencePromptAnswerSet
  eligibilityFields: CovidenceEligibilityPromptField[]
  mode: CovidenceImportMode
}) => {
  return getNormalizedCovidenceEligibilityPromptFields(params.eligibilityFields).map((eligibilityField) => {
    return buildCovidencePromptDefinitionForEligibilityField({...params, eligibilityField})
  })
}

const buildCovidencePromptDefinitionsPerSection = (params: {
  answerSet: CovidencePromptAnswerSet
  eligibilityFields: CovidenceEligibilityPromptField[]
  mode: CovidenceImportMode
}) => {
  return getCovidencePromptCriteriaGroups({
    eligibilityFields: params.eligibilityFields,
    promptGrouping: 'per_section',
  }).map((criteriaGroup) => {
    const promptDefinition = buildCovidencePromptDefinition({
      answerSet: params.answerSet,
      exclusionCriteria: criteriaGroup.exclusionCriteria.join('\n\n'),
      inclusionCriteria: criteriaGroup.inclusionCriteria.join('\n\n'),
      mode: params.mode,
    })

    return criteriaGroup.sectionKey && criteriaGroup.sectionLabel
      ? {
          ...promptDefinition,
          criteriaSectionKey: criteriaGroup.sectionKey,
          criteriaSectionLabel: criteriaGroup.sectionLabel,
          promptHeading: `Matches ${criteriaGroup.sectionLabel} Criteria`,
        }
      : promptDefinition
  })
}

const buildCovidencePromptDefinitionsSinglePrompt = (params: {
  answerSet: CovidencePromptAnswerSet
  eligibilityFields: CovidenceEligibilityPromptField[]
  mode: CovidenceImportMode
}) => {
  return getCovidencePromptCriteriaGroups({
    eligibilityFields: params.eligibilityFields,
    promptGrouping: 'single_prompt',
  }).map((criteriaGroup) => {
    return buildCovidencePromptDefinition({
      answerSet: params.answerSet,
      exclusionCriteria: criteriaGroup.exclusionCriteria.join('\n\n'),
      inclusionCriteria: criteriaGroup.inclusionCriteria.join('\n\n'),
      mode: params.mode,
    })
  })
}

export const buildCovidencePromptDefinitionsForEligibilityFields = (params: {
  answerSet: CovidencePromptAnswerSet
  eligibilityFields: CovidenceEligibilityPromptField[]
  mode: CovidenceImportMode
  promptGrouping?: CovidencePromptGrouping
}) => {
  const promptGrouping = params.promptGrouping ?? 'per_field'

  return promptGrouping === 'per_field'
    ? buildCovidencePromptDefinitionsPerField(params)
    : promptGrouping === 'per_section'
      ? buildCovidencePromptDefinitionsPerSection(params)
      : buildCovidencePromptDefinitionsSinglePrompt(params)
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
    humanJudgmentMode: 'prompt' | 'summary'
    id: string
    modelId: string
    name: string
    useAbstract: boolean
    useFulltext: boolean
    useFulltextNoImages: boolean
    useTitle: boolean
  }>(`
    SELECT
      p.human_judgment_mode AS humanJudgmentMode,
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

const getCovidenceStudyKey = (citation: Record<string, string | null>): CovidenceStudyKey | null => {
  const doi = getNormalizedCovidenceMatchValue(normalizeDoi(getCovidenceCitationValue(citation, ['doi'])))
  const pmid = getNormalizedCovidenceMatchValue(getCovidenceCitationValue(citation, covidencePmidKeys))
  const referenceId = getNormalizedCovidenceMatchValue(getCovidenceCitationValue(citation, covidenceStudyReferenceKeys))
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

const getCovidenceRecordKey = (citation: Record<string, string | null>): CovidenceRecordKey | null => {
  const covidenceId = getNormalizedCovidenceMatchValue(
    getCovidenceCitationValue(citation, covidenceRecordCovidenceKeys),
  )
  const referenceId = getNormalizedCovidenceMatchValue(
    getCovidenceCitationValue(citation, covidenceRecordReferenceKeys),
  )
  const studyKey = getCovidenceStudyKey(citation)

  return covidenceId
    ? {source: 'covidence', value: covidenceId}
    : referenceId
      ? {source: 'reference_id', value: referenceId}
      : studyKey
}

const getCovidenceRowKey = (row: CovidenceReferenceRow) => {
  return getCovidenceRecordKey(row.citation)
}

const isCovidenceOverlayRow = (
  row: CovidenceReferenceRow,
): row is CovidenceReferenceRow & {fileRole: Exclude<CovidenceFileRole, 'all'>} => {
  return row.fileRole !== 'all'
}

const getCovidenceUniqueStrings = (values: Array<string | null>) => {
  const seenValues = new Set<string>()

  return values.reduce<string[]>((uniqueValues, value) => {
    const normalizedValue = value?.trim() ?? ''

    if (normalizedValue === '' || seenValues.has(normalizedValue)) {
      return uniqueValues
    }

    seenValues.add(normalizedValue)
    uniqueValues.push(normalizedValue)

    return uniqueValues
  }, [])
}

const getCovidenceStageMembership = (rows: CovidenceReferenceRow[]) => {
  return rows.reduce<Record<CovidenceFileRole, boolean>>(
    (membership, row) => {
      membership[row.fileRole] = true

      return membership
    },
    {...emptyCovidenceStageMembership},
  )
}

const getCovidenceMergedArticleCandidate = (params: {
  articleKey: string
  articleKeySource: CovidenceRecordKeySource | 'unkeyed'
  canonicalRow: CovidenceReferenceRow
  sourceRows: CovidenceReferenceRow[]
}): CovidenceMergedArticleCandidate => {
  const studyKey = getCovidenceStudyKey(params.canonicalRow.citation)

  return {
    articleKey: params.articleKey,
    articleKeySource: params.articleKeySource,
    citation: params.canonicalRow.citation,
    covidenceIds: getCovidenceUniqueStrings(
      params.sourceRows.map((row) => {
        return getCovidenceCitationValue(row.citation, covidenceRecordCovidenceKeys)
      }),
    ),
    duplicateStudyRecordCount: 1,
    exclusionReasons: getCovidenceUniqueStrings(
      params.sourceRows.map((row) => {
        return row.exclusionReason
      }),
    ),
    hasDuplicateStudyRecords: false,
    hasStudyDecisionConflict: false,
    isSeededHumanJudgmentAnswered: false,
    notes: getCovidenceUniqueStrings(
      params.sourceRows.map((row) => {
        return row.notes
      }),
    ),
    referenceIds: getCovidenceUniqueStrings(
      params.sourceRows.map((row) => {
        return getCovidenceCitationValue(row.citation, covidenceRecordReferenceKeys)
      }),
    ),
    seededHumanJudgmentAnswer: null,
    sourceRows: params.sourceRows,
    stageMembership: getCovidenceStageMembership(params.sourceRows),
    studyDecisionAnswers: [],
    studyKey: studyKey ? `${studyKey.source}:${studyKey.value}` : null,
    studyKeySource: studyKey?.source ?? null,
    tags: getCovidenceUniqueStrings(
      params.sourceRows.flatMap((row) => {
        return row.tags
      }),
    ),
  }
}

const getCovidenceCandidateState = (params: {
  articleKeySource: CovidenceRecordKeySource | 'unkeyed'
  canonicalRow: CovidenceReferenceRow
  sourceRows: CovidenceReferenceRow[]
}): CovidenceCanonicalCandidateState => {
  return {articleKeySource: params.articleKeySource, canonicalRow: params.canonicalRow, sourceRows: params.sourceRows}
}

const createCovidenceCanonicalState = (): CovidenceCanonicalState => {
  return {articleKeys: [] as string[], candidateMap: new Map<string, CovidenceCanonicalCandidateState>()}
}

const appendCovidenceCanonicalRow = (
  state: CovidenceCanonicalState,
  row: CovidenceReferenceRow,
): CovidenceCanonicalState => {
  const resolvedKey = getCovidenceResolvedArticleKey(row)
  const existingCandidate = state.candidateMap.get(resolvedKey.articleKey)

  if (existingCandidate) {
    existingCandidate.sourceRows.push(row)

    return state
  }

  state.candidateMap.set(
    resolvedKey.articleKey,
    getCovidenceCandidateState({articleKeySource: resolvedKey.articleKeySource, canonicalRow: row, sourceRows: [row]}),
  )
  state.articleKeys.push(resolvedKey.articleKey)

  return state
}

const getCovidenceResolvedArticleKey = (
  row: CovidenceReferenceRow,
): {articleKey: string; articleKeySource: CovidenceRecordKeySource | 'unkeyed'} => {
  const key = getCovidenceRowKey(row)

  return {
    articleKey: key ? `${key.source}:${key.value}` : `unkeyed:${row.sourceFileName}:${row.rowNumber}`,
    articleKeySource: key?.source ?? 'unkeyed',
  }
}

const getCovidenceCanonicalStateFromAllRows = (rows: CovidenceReferenceRow[]) => {
  return rows.reduce(appendCovidenceCanonicalRow, createCovidenceCanonicalState())
}

const getCovidenceCanonicalStateFromMasterRows = (rows: CovidenceReferenceRow[]) => {
  return rows
    .filter((row) => {
      return row.fileRole === 'all'
    })
    .reduce(appendCovidenceCanonicalRow, createCovidenceCanonicalState())
}

const getCovidenceOverlayMergedState = (
  rows: CovidenceReferenceRow[],
  canonicalCandidateMap: Map<string, CovidenceCanonicalCandidateState>,
) => {
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

    existingCandidate.sourceRows.push(row)

    return rowMap
  }, new Map(canonicalCandidateMap))

  return {candidateMap, missingMatches}
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

const getCovidenceStudyGroupWarnings = (params: {
  candidates: CovidenceMergedArticleCandidate[]
  mode: CovidenceImportMode
}): {duplicateStudyGroups: CovidenceStudyGroupWarning[]; studyDecisionConflicts: CovidenceStudyGroupWarning[]} => {
  const groupedCandidates = params.candidates.reduce((groupMap, candidate) => {
    if (!candidate.studyKey || !candidate.studyKeySource) {
      return groupMap
    }

    const groupKey = `${candidate.studyKeySource}:${candidate.studyKey}`
    const existingGroup = groupMap.get(groupKey)

    if (existingGroup) {
      existingGroup.push(candidate)
      return groupMap
    }

    groupMap.set(groupKey, [candidate])

    return groupMap
  }, new Map<string, CovidenceMergedArticleCandidate[]>())

  const groups = Array.from(groupedCandidates.values())
    .filter((candidates) => {
      return candidates.length > 1
    })
    .map((candidates) => {
      const [firstCandidate] = candidates

      if (!firstCandidate?.studyKey || !firstCandidate.studyKeySource) {
        throw new Error('Expected Covidence study group key')
      }

      return {
        articleCount: candidates.length,
        records: candidates.map((candidate) => {
          return {
            articleKey: candidate.articleKey,
            articleKeySource: candidate.articleKeySource,
            covidenceIds: candidate.covidenceIds,
            referenceIds: candidate.referenceIds,
            seededHumanJudgmentAnswer: getCovidenceHumanJudgmentAnswer({
              mode: params.mode,
              stageMembership: candidate.stageMembership,
            }),
            stageMembership: candidate.stageMembership,
            title: candidate.citation.title ?? null,
          }
        }),
        studyKey: firstCandidate.studyKey,
        studyKeySource: firstCandidate.studyKeySource,
      }
    })

  return {
    duplicateStudyGroups: groups,
    studyDecisionConflicts: groups.filter((group) => {
      return (
        new Set(
          group.records.flatMap((record) => {
            return record.seededHumanJudgmentAnswer ? [record.seededHumanJudgmentAnswer] : []
          }),
        ).size > 1
      )
    }),
  }
}

const getCovidenceCandidatesWithStudyMetadata = (params: {
  candidates: CovidenceMergedArticleCandidate[]
  mode: CovidenceImportMode
}): CovidenceMergedArticleCandidate[] => {
  const groupedCandidates = params.candidates.reduce((groupMap, candidate) => {
    const groupKey = candidate.studyKey ?? `record:${candidate.articleKey}`
    const existingGroup = groupMap.get(groupKey)

    if (existingGroup) {
      existingGroup.push(candidate)
      return groupMap
    }

    groupMap.set(groupKey, [candidate])

    return groupMap
  }, new Map<string, CovidenceMergedArticleCandidate[]>())

  return params.candidates.map((candidate) => {
    const group = groupedCandidates.get(candidate.studyKey ?? `record:${candidate.articleKey}`) ?? [candidate]
    const studyDecisionAnswers = getCovidenceUniqueStrings(
      group.map((groupCandidate) => {
        return getCovidenceHumanJudgmentAnswer({mode: params.mode, stageMembership: groupCandidate.stageMembership})
      }),
    ) as Array<'no' | 'yes'>
    const seededHumanJudgmentAnswer = getCovidenceHumanJudgmentAnswer({
      mode: params.mode,
      stageMembership: candidate.stageMembership,
    })

    return {
      ...candidate,
      duplicateStudyRecordCount: group.length,
      hasDuplicateStudyRecords: group.length > 1,
      hasStudyDecisionConflict: studyDecisionAnswers.length > 1,
      isSeededHumanJudgmentAnswered: seededHumanJudgmentAnswer !== null,
      seededHumanJudgmentAnswer,
      studyDecisionAnswers,
    }
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
  const records: Array<Record<string, string[]>> = []
  let currentRecord = {} as Record<string, string[]>
  let currentTag: string | null = null
  let malformedLineIndex: number | null = null

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const trimmedLine = line.trimEnd()
    const match = trimmedLine.match(/^([A-Z0-9]{2,})\s*-\s?(.*)$/)

    if (trimmedLine.trim() === '') {
      continue
    }

    if (match) {
      const normalizedTag = getNormalizedCovidenceRisTag(match[1] ?? '')
      const value = getNormalizedCovidenceCellValue(match[2] ?? '') ?? ''

      if (normalizedTag === 'er') {
        records.push(currentRecord)
        currentRecord = {}
        currentTag = null
        continue
      }

      const currentValues = currentRecord[normalizedTag] ?? []
      currentValues.push(value)
      currentRecord[normalizedTag] = currentValues
      currentTag = normalizedTag
      continue
    }

    if (!currentTag) {
      malformedLineIndex = index
      break
    }

    const currentValues = currentRecord[currentTag] ?? ['']
    const lastValueIndex = currentValues.length - 1
    currentValues[lastValueIndex] = `${currentValues[lastValueIndex] ?? ''}\n${line.trim()}`.trim()
    currentRecord[currentTag] = currentValues
  }

  if (malformedLineIndex !== null) {
    return getCovidenceRisParseError({
      code: 'malformed_ris',
      fileRole: params.fileRole,
      message: `Covidence RIS line ${malformedLineIndex + 1} is not a valid RIS field`,
      rowNumber: malformedLineIndex + 1,
      sourceFileName: params.sourceFileName,
    })
  }

  if (Object.keys(currentRecord).length > 0) {
    return getCovidenceRisParseError({
      code: 'malformed_ris',
      fileRole: params.fileRole,
      message: 'Covidence RIS is missing a terminating ER field',
      sourceFileName: params.sourceFileName,
    })
  }

  return records.length === 0
    ? getCovidenceRisParseError({
        code: 'empty_file',
        fileRole: params.fileRole,
        message: 'Covidence RIS is empty',
        sourceFileName: params.sourceFileName,
      })
    : {ok: true, records}
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
  const rows: string[][] = []
  let currentField = ''
  let currentRow: string[] = []
  let inQuotes = false

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]

    if (character === '"') {
      if (inQuotes && content[index + 1] === '"') {
        currentField = `${currentField}"`
        index += 1
        continue
      }

      inQuotes = !inQuotes
      continue
    }

    if (character === '\r') {
      continue
    }

    if (character === ',' && !inQuotes) {
      currentRow.push(currentField)
      currentField = ''
      continue
    }

    if (character === '\n' && !inQuotes) {
      currentRow.push(currentField)
      rows.push(currentRow)
      currentField = ''
      currentRow = []
      continue
    }

    currentField = `${currentField}${character}`
  }

  if (inQuotes) {
    return null
  }

  currentRow.push(currentField)

  return currentRow.length === 1 && currentRow[0] === '' && content.endsWith('\n') ? rows : [...rows, currentRow]
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
    config.mode,
  )
}

const getCovidenceImportOriginalData = (candidate: CovidenceMergedArticleCandidate) => {
  return {
    covidence: {
      articleKey: candidate.articleKey,
      articleKeySource: candidate.articleKeySource,
      citation: candidate.citation,
      covidenceIds: candidate.covidenceIds,
      duplicateStudyRecordCount: candidate.duplicateStudyRecordCount,
      exclusionReasons: candidate.exclusionReasons,
      hasDuplicateStudyRecords: candidate.hasDuplicateStudyRecords,
      hasStudyDecisionConflict: candidate.hasStudyDecisionConflict,
      isSeededHumanJudgmentAnswered: candidate.isSeededHumanJudgmentAnswered,
      notes: candidate.notes,
      recordKey: candidate.articleKey,
      recordKeySource: candidate.articleKeySource,
      referenceIds: candidate.referenceIds,
      seededHumanJudgmentAnswer: candidate.seededHumanJudgmentAnswer,
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
      studyDecisionAnswers: candidate.studyDecisionAnswers,
      studyKey: candidate.studyKey,
      studyKeySource: candidate.studyKeySource,
      tags: candidate.tags,
    },
  }
}

const getCovidenceImportSourceMetadata = (params: {
  candidate: CovidenceMergedArticleCandidate
  config: CovidencePackageConfig
}) => {
  return {
    journalTitle: params.candidate.citation.journal ?? null,
    covidence: {
      articleKey: params.candidate.articleKey,
      articleKeySource: params.candidate.articleKeySource,
      covidenceIds: params.candidate.covidenceIds,
      duplicateStudyRecordCount: params.candidate.duplicateStudyRecordCount,
      files: params.config.files.map((file) => {
        return {
          assetPath: file.assetPath,
          fileRole: file.fileRole,
          format: file.format,
          sourceFileName: file.sourceFileName,
        }
      }),
      hasDuplicateStudyRecords: params.candidate.hasDuplicateStudyRecords,
      hasStudyDecisionConflict: params.candidate.hasStudyDecisionConflict,
      isSeededHumanJudgmentAnswered: params.candidate.isSeededHumanJudgmentAnswered,
      mode: params.config.mode,
      recordKey: params.candidate.articleKey,
      recordKeySource: params.candidate.articleKeySource,
      referenceIds: params.candidate.referenceIds,
      seededHumanJudgmentAnswer: params.candidate.seededHumanJudgmentAnswer,
      sourceFileNames: params.candidate.sourceRows.map((row) => {
        return row.sourceFileName
      }),
      stageMembership: params.candidate.stageMembership,
      studyDecisionAnswers: params.candidate.studyDecisionAnswers,
      studyKey: params.candidate.studyKey,
      studyKeySource: params.candidate.studyKeySource,
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

const getCovidenceHumanJudgmentAnswer = (params: {
  mode: CovidenceImportMode
  stageMembership: Record<CovidenceFileRole, boolean>
}): 'no' | 'yes' | null => {
  return params.mode === 'title_abstract'
    ? params.stageMembership.full_text
      ? 'yes'
      : params.stageMembership.irrelevant
        ? 'no'
        : null
    : params.stageMembership.included
      ? 'yes'
      : params.stageMembership.excluded
        ? 'no'
        : null
}

const getCovidenceHumanJudgmentSeeds = (params: {config: CovidencePackageConfig; importRoute: string}) => {
  return getCovidencePackageRowsFromConfig(params.config).candidates.flatMap<CovidenceHumanJudgmentSeed>(
    (candidate) => {
      const includeCandidate =
        params.config.mode === 'title_abstract'
        || candidate.stageMembership.full_text
        || candidate.stageMembership.excluded
        || candidate.stageMembership.included
      const answer = getCovidenceHumanJudgmentAnswer({
        mode: params.config.mode,
        stageMembership: candidate.stageMembership,
      })

      return includeCandidate
        ? [
            {
              answer,
              articleExternalId: `${params.importRoute}:${getSafeIdentityPart(candidate.articleKey)}`,
              isAnswered: answer !== null,
            },
          ]
        : []
    },
  )
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
  const currentArticleRows = await queryRunner.queryJson<{articleId: string}>(`
    SELECT article_id AS articleId
    FROM app.project_article
    WHERE project_id = ${getSqlLiteral(params.projectId)}
      AND imported_from_project_id = ${getSqlLiteral(params.projectId)}
  `)
  const currentArticleIds = currentArticleRows.map((articleRow) => {
    return articleRow.articleId
  })
  const nextArticleIds = Array.from(new Set(params.articleIds))
  const scopeChanged =
    currentArticleIds.length !== nextArticleIds.length
    || currentArticleIds.some((articleId) => {
      return !nextArticleIds.includes(articleId)
    })

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
    ? scopeChanged
      ? getProjectMartRefreshStateService().markProjectsDirtyAtomically({
          projects: [{articleIds: currentArticleIds, projectId: params.projectId}],
          reason: 'syncCovidenceProjectScopeFromConfig',
          runner: queryRunner,
        })
      : undefined
    : await queryRunner
        .run(
          `
          INSERT INTO app.project_article (id, project_id, article_id, imported_from_project_id)
          VALUES ${params.articleIds
            .map((articleId) => {
              return `(${getQuotedStringList([globalThis.crypto.randomUUID(), params.projectId, articleId, params.projectId]).join(', ')})`
            })
            .join(', ')}
          ON CONFLICT(project_id, article_id) DO NOTHING
        `,
        )
        .then(() => {
          return scopeChanged
            ? getProjectMartRefreshStateService().markProjectsDirtyAtomically({
                projects: [
                  {
                    articleIds: Array.from(new Set([...currentArticleIds, ...nextArticleIds])),
                    projectId: params.projectId,
                  },
                ],
                reason: 'syncCovidenceProjectScopeFromConfig',
                runner: queryRunner,
              })
            : undefined
        })
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
    criteriaDisposition: 'combined',
    originalText: getCovidencePromptText(params),
    promptHeading: covidencePromptHeadingByMode[params.mode],
    type: getCovidencePromptType(params.answerSet),
  }
}

export const getOrCreateCovidencePrompt = async (
  params:
    | {
        answerSet: CovidencePromptAnswerSet
        exclusionCriteria: string
        inclusionCriteria: string
        mode: CovidenceImportMode
        tx?: CovidencePromptTx
      }
    | {promptDefinition: CovidencePromptDefinition; tx?: CovidencePromptTx},
): Promise<CovidencePromptRecord> => {
  const promptDefinition =
    'promptDefinition' in params ? params.promptDefinition : buildCovidencePromptDefinition(params)
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

export const syncCovidenceProjectPrompts = async (params: {
  projectId: string
  promptLinks: CovidenceProjectPromptLink[]
  tx?: CovidenceProjectTx
}) => {
  const queryRunner = getCovidenceProjectQueryRunner(params.tx)
  const promptLinks = params.promptLinks.reduce<CovidenceProjectPromptLink[]>((distinctPromptLinks, promptLink) => {
    return distinctPromptLinks.some((existingPromptLink) => {
      return existingPromptLink.promptId === promptLink.promptId
    })
      ? distinctPromptLinks
      : [...distinctPromptLinks, promptLink]
  }, [])

  return promptLinks.length === 0
    ? undefined
    : await queryRunner.run(`
        INSERT INTO app.project_prompt (
          id,
          project_id,
          prompt_id,
          prompt_order,
          archived,
          enabled,
          origin_project_id,
          criteria_disposition,
          criteria_section_key,
          criteria_section_label
        )
        VALUES ${promptLinks
          .map((promptLink, index) => {
            return `(
              '${escapeSqlString(globalThis.crypto.randomUUID())}',
              '${escapeSqlString(params.projectId)}',
              '${escapeSqlString(promptLink.promptId)}',
              ${index},
              FALSE,
              TRUE,
              NULL,
              ${getSqlLiteral(promptLink.criteriaDisposition ?? null)},
              ${getSqlLiteral(promptLink.criteriaSectionKey ?? null)},
              ${getSqlLiteral(promptLink.criteriaSectionLabel ?? null)}
            )`
          })
          .join(', ')}
        ON CONFLICT(project_id, prompt_id) DO UPDATE SET
          prompt_order = EXCLUDED.prompt_order,
          archived = FALSE,
          enabled = TRUE,
          criteria_disposition = EXCLUDED.criteria_disposition,
          criteria_section_key = EXCLUDED.criteria_section_key,
          criteria_section_label = EXCLUDED.criteria_section_label,
          updated_at = now()
      `)
}

export const getOrCreateCovidenceProject = async (params: {
  importRoute: string
  modelId?: string
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
  const modelId = params.modelId ?? (await getDefaultCovidenceProjectModelId())

  await queryRunner.run(`
    INSERT INTO app.project (
      id,
      name,
      model_id,
      human_judgment_mode,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images
    )
    VALUES (
      '${escapeSqlString(projectId)}',
      ${getSqlLiteral(params.title)},
      '${escapeSqlString(modelId)}',
      'summary',
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

  return {created: true, humanJudgmentMode: 'summary', id: projectId, modelId, name: params.title, ...settings}
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
  const project = params.projectId
    ? await getCovidenceProjectQueryRunner(params.tx)
        .queryJson<Pick<CovidenceProjectRecord, 'humanJudgmentMode' | 'id'>>(
          `
        SELECT id, human_judgment_mode AS humanJudgmentMode
        FROM app.project
        WHERE id = ${getSqlLiteral(params.projectId)}
        LIMIT 1
      `,
        )
        .then((rows) => {
          return rows[0] ?? null
        })
    : await getCovidenceProjectByImportRoute({importRoute: params.importRoute, tx: params.tx})

  if (!project) {
    return
  }

  const judgmentSeeds = getCovidenceHumanJudgmentSeeds({config: params.config, importRoute: params.importRoute})

  if (judgmentSeeds.length === 0) {
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

  if (project.humanJudgmentMode === 'summary') {
    await getChunkedCovidenceHumanJudgmentSeeds(judgmentSeeds, 500).reduce<Promise<void>>(
      (previousRun, judgmentSeedChunk) => {
        return previousRun.then(() => {
          const insertValues = judgmentSeedChunk
            .map((judgmentSeed) => {
              const articleId = articleIdByExternalId.get(judgmentSeed.articleExternalId)

              return articleId
                ? `(${getQuotedStringList([globalThis.crypto.randomUUID(), project.id, articleId]).join(', ')}, ${getSqlLiteral(judgmentSeed.answer)}, 'covidence_import')`
                : null
            })
            .filter((value): value is string => {
              return value !== null
            })
            .join(', ')

          return insertValues === ''
            ? Promise.resolve()
            : queryRunner.run(`
      INSERT INTO app.judgment_human_summary (id, project_id, article_id, answer, origin)
      VALUES ${insertValues}
      ON CONFLICT(project_id, article_id) DO UPDATE SET
        answer = EXCLUDED.answer,
        origin = EXCLUDED.origin,
        updated_at = now()
    `)
        })
      },
      Promise.resolve(),
    )

    return
  }

  const promptRows = await getCovidenceEnabledProjectPromptIds({projectId: project.id, tx: params.tx})
  const promptIds = promptRows.map((promptRow) => {
    return promptRow.promptId
  })

  if (promptIds.length === 0) {
    return
  }

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
    DELETE FROM app.judgment_human_summary
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

export const mergeCovidenceReferenceRows = (
  rows: CovidenceReferenceRow[],
  mode: CovidenceImportMode = 'full_text',
): CovidenceReferenceMergeResult => {
  const canonicalState =
    mode === 'title_abstract'
      ? getCovidenceCanonicalStateFromAllRows(rows)
      : getCovidenceCanonicalStateFromMasterRows(rows)
  const mergedState =
    mode === 'title_abstract'
      ? {candidateMap: canonicalState.candidateMap, missingMatches: [] as CovidenceMergeMissingMatch[]}
      : getCovidenceOverlayMergedState(rows, canonicalState.candidateMap)
  const rawCandidates = canonicalState.articleKeys.map((articleKey) => {
    const candidateState = mergedState.candidateMap.get(articleKey)

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
  const candidates = getCovidenceCandidatesWithStudyMetadata({candidates: rawCandidates, mode})
  const studyGroupWarnings = getCovidenceStudyGroupWarnings({candidates, mode})

  return {
    candidates,
    warnings: {
      conflictingStageMemberships: getCovidenceConflictWarnings(candidates),
      duplicateStudyGroups: studyGroupWarnings.duplicateStudyGroups,
      missingMatches: mergedState.missingMatches,
      studyDecisionConflicts: studyGroupWarnings.studyDecisionConflicts,
    },
  }
}

export const parseCovidenceCsvReferenceRows = (params: {
  content: string
  fileRole: CovidenceFileRole
  format: CovidenceFileFormat
  sourceFileName: string
}) => {
  return parseCovidenceCsvReferenceRowsInternal(params)
}

const readAndParseCovidenceAnalyzeFiles = async (
  files: CovidenceAnalyzeUploadFile[],
  index = 0,
  state = {
    detectedFiles: [] as Array<{
      fileRole: CovidenceFileRole
      format: CovidenceFileFormat
      rowCount: number
      sourceFileName: string
    }>,
    parseError: null as
      | {code: 'parse_error'; message: string; parseError: CovidenceCsvParseError}
      | {code: 'unsupported_format'; message: string}
      | null,
    rows: [] as CovidenceReferenceRow[],
  },
): Promise<typeof state> => {
  const nextFile = files[index]

  if (!nextFile || state.parseError) {
    return state
  }

  const sourceFileName = nextFile.file.name?.trim() || `${nextFile.fileRole}.upload`
  const format = getCovidenceFileFormatFromName(sourceFileName)

  if (!format) {
    return {
      ...state,
      parseError: {
        code: 'unsupported_format',
        message: `Only Covidence CSV and RIS files are supported, got '${sourceFileName}'`,
      },
    }
  }

  const parsedResult = parseCovidenceReferenceRows({
    content: await nextFile.file.text(),
    fileRole: nextFile.fileRole,
    format,
    sourceFileName,
  })

  if (parsedResult.ok === false) {
    return {
      ...state,
      parseError: {code: 'parse_error', message: parsedResult.error.message, parseError: parsedResult.error},
    }
  }

  state.detectedFiles.push({fileRole: nextFile.fileRole, format, rowCount: parsedResult.rows.length, sourceFileName})
  state.rows.push(...parsedResult.rows)

  return await readAndParseCovidenceAnalyzeFiles(files, index + 1, state)
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

  const parsedState = await readAndParseCovidenceAnalyzeFiles(getSortedCovidenceAnalyzeFiles(params.mode, uploads))

  if (parsedState.parseError?.code === 'unsupported_format') {
    return {error: {code: 'unsupported_format', message: parsedState.parseError.message}, ok: false}
  }

  if (parsedState.parseError?.code === 'parse_error') {
    return {
      error: {
        code: 'parse_error',
        message: parsedState.parseError.message,
        parseError: parsedState.parseError.parseError,
      },
      ok: false,
    }
  }

  const mergedResult = mergeCovidenceReferenceRows(parsedState.rows, params.mode)

  return {
    data: {
      counts: {
        conflictingStageMembershipCount: mergedResult.warnings.conflictingStageMemberships.length,
        duplicateStudyGroupCount: mergedResult.warnings.duplicateStudyGroups.length,
        fileCount: parsedState.detectedFiles.length,
        filesByRole: getCovidenceRoleCounts(parsedState.detectedFiles),
        mergedRowCount: mergedResult.candidates.length,
        missingMatchCount: mergedResult.warnings.missingMatches.length,
        rowCount: parsedState.detectedFiles.reduce((count, file) => {
          return count + file.rowCount
        }, 0),
        rowsByRole: getCovidenceRoleCounts(parsedState.rows),
        studyDecisionConflictCount: mergedResult.warnings.studyDecisionConflicts.length,
        studyGroupCount: new Set(
          mergedResult.candidates.map((candidate) => {
            return candidate.studyKey ?? `record:${candidate.articleKey}`
          }),
        ).size,
      },
      detectedFiles: parsedState.detectedFiles,
      mode: params.mode,
      sampleMergedRows: mergedResult.candidates.slice(0, 5).map((candidate) => {
        return {
          articleKey: candidate.articleKey,
          articleKeySource: candidate.articleKeySource,
          citation: candidate.citation,
          duplicateStudyRecordCount: candidate.duplicateStudyRecordCount,
          exclusionReasons: candidate.exclusionReasons,
          hasDuplicateStudyRecords: candidate.hasDuplicateStudyRecords,
          hasStudyDecisionConflict: candidate.hasStudyDecisionConflict,
          notes: candidate.notes,
          stageMembership: candidate.stageMembership,
          studyKey: candidate.studyKey,
          studyKeySource: candidate.studyKeySource,
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
