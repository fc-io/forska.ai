import {
  namedReviewFastCountDefinitions,
  type NamedReviewFastCountKey,
  type ReviewServingReadContract,
} from './reviewServingContracts.ts'
import {reviewServingReadContractList} from './reviewServingReadContracts.ts'
import {reviewServingSqlForbiddenPatterns} from './reviewServingSqlForbiddenPatterns.ts'

export type ReviewServingSqlShapeResult =
  | {ok: true; violations: []}
  | {ok: false; violations: readonly {label: string; pattern: string}[]}

export type ReviewServingSqlShapeOptions = {
  allowedTables?: readonly string[]
  requireLimit?: boolean
  requireOrderBy?: boolean
  requireProjectScope?: boolean
  requireRegisteredTable?: boolean
  requireSnapshotScope?: boolean
}

const tableReferencePattern = /\b(?:from|join)\s+((?:"[^"]+"|[a-z_][\w]*)(?:\.(?:"[^"]+"|[a-z_][\w]*))?)/giu
const tableReferenceWithAliasPattern =
  /\b(?:from|join)\s+((?:"[^"]+"|[a-z_][\w]*)(?:\.(?:"[^"]+"|[a-z_][\w]*))?)(?:\s+(?:as\s+)?((?!where\b|on\b|join\b|order\b|limit\b|group\b|having\b|qualify\b|using\b|inner\b|left\b|right\b|full\b|cross\b)(?:"[^"]+"|[a-z_][\w]*)))?/giu
const sqlClauseKeywords = new Set([
  'cross',
  'full',
  'group',
  'having',
  'inner',
  'join',
  'left',
  'limit',
  'on',
  'order',
  'qualify',
  'right',
  'using',
  'where',
])
type ReviewServingSqlTableReference = {alias: string | null; table: string}

export const reviewServingRegisteredSqlTables = [
  ...new Set([
    ...reviewServingReadContractList.map((contract) => {
      return contract.servingTable
    }),
  ]),
].sort()

const getDefaultReviewServingSqlShapeOptions = (): Required<ReviewServingSqlShapeOptions> => {
  return {
    allowedTables: reviewServingRegisteredSqlTables,
    requireLimit: true,
    requireOrderBy: true,
    requireProjectScope: true,
    requireRegisteredTable: true,
    requireSnapshotScope: true,
  }
}

const getSortSql = (contract: ReviewServingReadContract) => {
  return contract.sort.fields
    .map((field) => {
      return /\b(?:asc|desc)\b/iu.test(field) ? field : `${field} ${contract.sort.direction.toUpperCase()}`
    })
    .join(', ')
}

const normalizeSqlIdentifier = (identifier: string) => {
  return identifier.replaceAll('"', '').toLowerCase()
}

const escapeRegex = (value: string) => {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

const getNormalizedSqlAlias = (alias: string | undefined) => {
  const normalizedAlias = alias ? normalizeSqlIdentifier(alias) : null

  return normalizedAlias && !sqlClauseKeywords.has(normalizedAlias) ? normalizedAlias : null
}

export const getReviewServingSqlForbiddenPatternViolations = (sql: string) => {
  return reviewServingSqlForbiddenPatterns
    .filter((forbiddenPattern) => {
      if (forbiddenPattern.label === 'raw article table scan' && hasBoundedArticleLookupJoin(sql)) {
        return false
      }

      if (forbiddenPattern.label === 'raw judgment table scan' && hasBoundedJudgmentAuthoritativeHydrationJoin(sql)) {
        return false
      }

      if (forbiddenPattern.label === 'json extraction' && hasOnlyBoundedJsonExtraction(sql)) {
        return false
      }

      return forbiddenPattern.pattern.test(sql)
    })
    .map((forbiddenPattern) => {
      return {label: forbiddenPattern.label, pattern: String(forbiddenPattern.pattern)}
    })
}

export const getReviewServingSqlTableReferences = (sql: string) => {
  return [
    ...new Set(
      [...sql.matchAll(tableReferencePattern)].map((match) => {
        return normalizeSqlIdentifier(match[1] ?? '')
      }),
    ),
  ].filter((tableReference) => {
    return tableReference.length > 0
  })
}

const getReviewServingSqlTableReferenceDetails = (sql: string): ReviewServingSqlTableReference[] => {
  return [...sql.matchAll(tableReferenceWithAliasPattern)]
    .map((match) => {
      return {alias: getNormalizedSqlAlias(match[2]), table: normalizeSqlIdentifier(match[1] ?? '')}
    })
    .filter((tableReference) => {
      return tableReference.table.length > 0
    })
}

const hasBoundedArticleLookupJoin = (sql: string) => {
  return (
    /\bleft\s+join\s+app\.article\s+article\s+on\s+article\.id\s*=\s*mart\.review_article_serving_v4\.article_id\b/iu.test(
      sql,
    )
    || /\bleft\s+join\s+app\.article\s+article[`',\s]*\n\s*`?\s*on\s+article\.id\s*=\s*\$\{reviewServingArticleTable\}\.article_id\b/iu.test(
      sql,
    )
  )
}

const hasBoundedJudgmentPromptMetadataJoin = (sql: string) => {
  return (
    /\bleft\s+join\s+app\.project_prompt\s+project_prompt\s+on\s+project_prompt\.project_id\s*=\s*[$:@?a-z_][\w.$:]*/iu.test(
      sql,
    )
    && /\bproject_prompt\.prompt_id\s*=\s*mart\.review_article_judgment_detail_serving_v4\.prompt_id\b/iu.test(sql)
    && /\bleft\s+join\s+app\.prompt\s+prompt\s+on\s+prompt\.id\s*=\s*mart\.review_article_judgment_detail_serving_v4\.prompt_id\b/iu.test(
      sql,
    )
  )
}

const hasBoundedJudgmentAuthoritativeHydrationJoin = (sql: string) => {
  return (
    /\bleft\s+join\s+app\."?judgment"?\s+llm_judgment\b/iu.test(sql)
    && /\bllm_judgment\.id\s*=\s*mart\.review_article_judgment_detail_serving_v4\.judgment_id\b/iu.test(sql)
    && /\bllm_judgment\.article_id\s*=\s*mart\.review_article_judgment_detail_serving_v4\.article_id\b/iu.test(sql)
    && /\bllm_judgment\.prompt_id\s*=\s*mart\.review_article_judgment_detail_serving_v4\.prompt_id\b/iu.test(sql)
    && /\bllm_judgment\.deleted_at\s+is\s+null\b/iu.test(sql)
  )
}

const hasOnlyBoundedJsonExtraction = (sql: string) => {
  const extractionCalls = [...sql.matchAll(/\bjson_extract(?:_string)?\s*\([^)]*\)/giu)].map((match) => {
    return match[0]
  })

  return (
    extractionCalls.length > 0
    && extractionCalls.every((call) => {
      return (
        (hasBoundedJudgmentAuthoritativeHydrationJoin(sql)
          && /json_extract_string\s*\(\s*model\.metadata_json\s*,\s*'\$\.options\.thinking'\s*\)/iu.test(call))
        || (hasBoundedSelectedSourceRecordLookupJoin(sql)
          && /json_extract_string\s*\(\s*selected_source\.raw_payload\s*,\s*'\$\.covidence\.citation\.url'\s*\)/iu.test(
            call,
          ))
      )
    })
  )
}

const isBoundedArticleLookupReference = (sql: string, tableReference: ReviewServingSqlTableReference) => {
  return (
    tableReference.table === 'app.article' && tableReference.alias === 'article' && hasBoundedArticleLookupJoin(sql)
  )
}

const hasBoundedSelectedImportLookupJoin = (sql: string) => {
  return (
    /\bleft\s+join\s+app\.review_selected_article_import_v4\s+selected_import\b/iu.test(sql)
    && /\bselected_import\.project_id\s*=\s*[$:@?a-z_][\w.$:]*/iu.test(sql)
    && /\bselected_import\.project_id\s*=\s*mart\.review_article_serving_v4\.project_id\b/iu.test(sql)
    && /\bselected_import\.project_scope_identity\s*=\s*[$:@?a-z_][\w.$:]*/iu.test(sql)
    && /\bselected_import\.selected_import_snapshot_id\s*=\s*[$:@?a-z_][\w.$:]*/iu.test(sql)
    && /\bselected_import\.article_id\s*=\s*mart\.review_article_serving_v4\.article_id\b/iu.test(sql)
    && /\bnot\s+selected_import\.tombstone\b/iu.test(sql)
  )
}

const isBoundedSelectedImportLookupReference = (sql: string, tableReference: ReviewServingSqlTableReference) => {
  return (
    tableReference.table === 'app.review_selected_article_import_v4'
    && tableReference.alias === 'selected_import'
    && hasBoundedSelectedImportLookupJoin(sql)
  )
}

const hasBoundedSelectedSourceRecordLookupJoin = (sql: string) => {
  return (
    /\bleft\s+join\s+app\.article_import_route_source_record\s+selected_source\b/iu.test(sql)
    && /\bselected_source\.import_route_id\s*=\s*selected_import\.import_route_id\b/iu.test(sql)
    && /\bselected_source\.article_id\s*=\s*mart\.review_article_serving_v4\.article_id\b/iu.test(sql)
    && /\bselected_source\.source_record_key\s*=\s*selected_import\.source_record_key\b/iu.test(sql)
    && /\bselected_source\.quarantined_at\s+is\s+null\b/iu.test(sql)
    && hasBoundedSelectedImportLookupJoin(sql)
  )
}

const isBoundedSelectedSourceRecordLookupReference = (sql: string, tableReference: ReviewServingSqlTableReference) => {
  return (
    tableReference.table === 'app.article_import_route_source_record'
    && tableReference.alias === 'selected_source'
    && hasBoundedSelectedSourceRecordLookupJoin(sql)
  )
}

const hasBoundedSelectedHotFieldLookupJoin = (sql: string) => {
  return (
    /\bleft\s+join\s+app\.review_import_article_hot_field\s+selected_hot\b/iu.test(sql)
    && /\bselected_hot\.import_route_id\s*=\s*selected_import\.import_route_id\b/iu.test(sql)
    && /\bselected_hot\.article_id\s*=\s*mart\.review_article_serving_v4\.article_id\b/iu.test(sql)
    && /\bselected_hot\.source_record_key\s*=\s*selected_import\.source_record_key\b/iu.test(sql)
    && /\bnot\s+selected_hot\.tombstone\b/iu.test(sql)
    && hasBoundedSelectedImportLookupJoin(sql)
  )
}

const isBoundedSelectedHotFieldLookupReference = (sql: string, tableReference: ReviewServingSqlTableReference) => {
  return (
    tableReference.table === 'app.review_import_article_hot_field'
    && tableReference.alias === 'selected_hot'
    && hasBoundedSelectedHotFieldLookupJoin(sql)
  )
}

const isBoundedJudgmentPromptMetadataReference = (sql: string, tableReference: ReviewServingSqlTableReference) => {
  return (
    ((tableReference.table === 'app.project_prompt' && tableReference.alias === 'project_prompt')
      || (tableReference.table === 'app.prompt' && tableReference.alias === 'prompt'))
    && hasBoundedJudgmentPromptMetadataJoin(sql)
  )
}

const isBoundedJudgmentAuthoritativeHydrationReference = (
  sql: string,
  tableReference: ReviewServingSqlTableReference,
) => {
  return (
    [
      ['app.judgment', 'llm_judgment'],
      ['app.judgment_assessment', 'assessment'],
      ['app.judgment_assessment', 'latest_assessment'],
      ['app.model', 'model'],
      ['app.provider_connection', 'provider_connection'],
      ['app.judgment_human', 'human_judgment'],
      ['app.judgment_human_summary', 'human_summary'],
    ].some(([table, alias]) => {
      return tableReference.table === table && tableReference.alias === alias
    }) && hasBoundedJudgmentAuthoritativeHydrationJoin(sql)
  )
}

const getReviewServingSqlRegisteredTableViolations = (sql: string, options: Required<ReviewServingSqlShapeOptions>) => {
  if (!options.requireRegisteredTable) {
    return []
  }

  const allowedTables = new Set(
    options.allowedTables.map((table) => {
      return normalizeSqlIdentifier(table)
    }),
  )
  const tableReferences = getReviewServingSqlTableReferences(sql)
  const missingTableViolations =
    tableReferences.length === 0
      ? [{label: 'registered serving table', pattern: 'FROM <registered review-serving table>'}]
      : []
  const unregisteredTableViolations = tableReferences
    .filter((tableReference) => {
      return tableReference !== 'app.article' || !hasBoundedArticleLookupJoin(sql)
    })
    .filter((tableReference) => {
      return tableReference !== 'app.review_selected_article_import_v4' || !hasBoundedSelectedImportLookupJoin(sql)
    })
    .filter((tableReference) => {
      return (
        tableReference !== 'app.article_import_route_source_record' || !hasBoundedSelectedSourceRecordLookupJoin(sql)
      )
    })
    .filter((tableReference) => {
      return tableReference !== 'app.review_import_article_hot_field' || !hasBoundedSelectedHotFieldLookupJoin(sql)
    })
    .filter((tableReference) => {
      return (
        !['app.project_prompt', 'app.prompt'].includes(tableReference) || !hasBoundedJudgmentPromptMetadataJoin(sql)
      )
    })
    .filter((tableReference) => {
      return (
        ![
          'app.judgment',
          'app.judgment_assessment',
          'app.model',
          'app.provider_connection',
          'app.judgment_human',
          'app.judgment_human_summary',
        ].includes(tableReference) || !hasBoundedJudgmentAuthoritativeHydrationJoin(sql)
      )
    })
    .filter((tableReference) => {
      return !allowedTables.has(tableReference)
    })
    .map((tableReference) => {
      return {label: `unregistered table reference: ${tableReference}`, pattern: tableReference}
    })

  return [...missingTableViolations, ...unregisteredTableViolations]
}

const getReviewServingSqlBoundedReadViolations = (sql: string, options: Required<ReviewServingSqlShapeOptions>) => {
  const tableReferences = getReviewServingSqlTableReferenceDetails(sql)
  const hasMultipleReferences = tableReferences.length > 1
  const scopedPredicateClause =
    sql.match(/\bfrom\b([\s\S]*?)(?:\bqualify\b|\border\s+by\b|\blimit\b|\bgroup\s+by\b|\bhaving\b|$)/iu)?.[1] ?? ''
  const wherePredicateClause = [
    ...sql.matchAll(/\bwhere\b([\s\S]*?)(?:\bqualify\b|\border\s+by\b|\blimit\b|\bgroup\s+by\b|\bhaving\b|$)/giu),
  ]
    .map((match) => {
      return match[1] ?? ''
    })
    .join('\n')
  const bindOperandPattern = '(?:\\?|[$:@](?:[a-z_][\\w.]*|[0-9]+))'
  const getQualifierPattern = (tableReference: ReviewServingSqlTableReference) => {
    if (tableReference.alias) {
      return `${escapeRegex(tableReference.alias)}\\s*\\.\\s*`
    }

    return hasMultipleReferences ? `${escapeRegex(tableReference.table)}\\s*\\.\\s*` : '(?:[a-z_][\\w]*\\s*\\.\\s*)?'
  }
  const getScopePredicatePattern = (
    tableReference: ReviewServingSqlTableReference,
    field: 'project_id' | 'snapshot_id',
  ) => {
    const qualifiedFieldPattern = `${getQualifierPattern(tableReference)}${field}`

    return new RegExp(
      `(?:\\b${qualifiedFieldPattern}\\b\\s*(?:=|is\\s+not\\s+distinct\\s+from)\\s*${bindOperandPattern}|${bindOperandPattern}\\s*(?:=|is\\s+not\\s+distinct\\s+from)\\s*\\b${qualifiedFieldPattern}\\b)`,
      'iu',
    )
  }
  const getScopeViolations = (field: 'project_id' | 'snapshot_id', label: string, required: boolean) => {
    return required
      ? tableReferences
          .filter((tableReference, tableReferenceIndex) => {
            if (
              isBoundedArticleLookupReference(sql, tableReference)
              || isBoundedSelectedImportLookupReference(sql, tableReference)
              || isBoundedSelectedSourceRecordLookupReference(sql, tableReference)
              || isBoundedSelectedHotFieldLookupReference(sql, tableReference)
              || isBoundedJudgmentPromptMetadataReference(sql, tableReference)
              || isBoundedJudgmentAuthoritativeHydrationReference(sql, tableReference)
            ) {
              return false
            }

            const predicateClause = tableReferenceIndex === 0 ? wherePredicateClause : scopedPredicateClause

            return !getScopePredicatePattern(tableReference, field).test(predicateClause)
          })
          .map((tableReference) => {
            const scopedLabel = tableReference.alias ?? tableReference.table

            return tableReferences.length === 1
              ? {label, pattern: `WHERE ... ${field}`}
              : {label: `${label}: ${scopedLabel}`, pattern: `${scopedLabel}.${field}`}
          })
      : []
  }
  const projectScopeViolations = getScopeViolations('project_id', 'project scoped read', options.requireProjectScope)
  const snapshotScopeViolations = getScopeViolations(
    'snapshot_id',
    'snapshot scoped read',
    options.requireSnapshotScope,
  )
  const orderByViolations =
    options.requireOrderBy && !/\border\s+by\b/iu.test(sql) ? [{label: 'keyset ordering', pattern: 'ORDER BY'}] : []
  const limitViolations =
    options.requireLimit && !/\blimit\b/iu.test(sql) ? [{label: 'bounded limit', pattern: 'LIMIT'}] : []

  return [...projectScopeViolations, ...snapshotScopeViolations, ...orderByViolations, ...limitViolations]
}

export const getReviewServingSqlShapeViolations = (sql: string, options?: ReviewServingSqlShapeOptions) => {
  const shapeOptions = {...getDefaultReviewServingSqlShapeOptions(), ...options}

  return [
    ...getReviewServingSqlForbiddenPatternViolations(sql),
    ...getReviewServingSqlRegisteredTableViolations(sql, shapeOptions),
    ...getReviewServingSqlBoundedReadViolations(sql, shapeOptions),
  ]
}

export const assertReviewServingSqlShape = (
  sql: string,
  options?: ReviewServingSqlShapeOptions,
): ReviewServingSqlShapeResult => {
  const violations = getReviewServingSqlShapeViolations(sql, options)
  return violations.length === 0 ? {ok: true, violations: []} : {ok: false, violations}
}

const reviewServingSnapshotManifestTable = 'app.review_serving_snapshot_manifest'
const reviewServingBulkOperationJobTable = 'app.review_bulk_operation_job'
const reviewServingSearchJobTable = 'app.review_search_job'
const reviewServingArticleTable = 'mart.review_article_serving_v4'
const reviewServingSelectedImportTable = 'app.review_selected_article_import_v4'
const reviewServingPayloadTable = 'mart.review_article_serving_payload_v4'
const reviewServingFilterPostingTable = 'mart.review_article_filter_posting_serving_v4'
const reviewServingFilterFacetTable = 'mart.review_filter_facet_serving_v4'
const reviewServingFilterOptionTable = 'mart.review_filter_option_serving_v4'
const reviewServingJudgmentDetailTable = 'mart.review_article_judgment_detail_serving_v4'
const reviewServingListModePrioritySql =
  "CASE list_mode_key WHEN 'both' THEN 0 WHEN 'llm' THEN 1 WHEN 'human' THEN 2 WHEN 'unassessed' THEN 3 ELSE 4 END"
const reviewServingJudgmentDetailListModePrioritySql = `CASE ${reviewServingJudgmentDetailTable}.list_mode_key WHEN 'both' THEN 0 WHEN 'llm' THEN 1 WHEN 'human' THEN 2 WHEN 'unassessed' THEN 3 ELSE 4 END`
const reviewServingListModePriorityAlias = 'list_mode_priority'
const reviewServingArticlePhysicalSelectColumns = [
  'project_id',
  'review_config_hash',
  'snapshot_id',
  'base_generation',
  'patch_watermark',
  'list_mode_key',
  'article_id',
  'article_created_at',
  'sort_key',
  'activity_sort_at',
].map((column) => {
  return `${reviewServingArticleTable}.${column}`
})
const reviewServingArticleSelectedImportColumns = ['selected_import.import_route_id AS selected_import_route_id']
const reviewServingArticleSourceMetadataSql = `CASE
    WHEN article.source_metadata IS NULL AND selected_source.import_metadata IS NULL THEN NULL
    ELSE json_merge_patch(
      COALESCE(article.source_metadata, CAST('{}' AS JSON)),
      COALESCE(selected_source.import_metadata, CAST('{}' AS JSON))
    )
  END`
const reviewServingArticlePayloadDisplayColumns = [
  `COALESCE(selected_hot.article_title, article.article_title) AS article_title`,
  `COALESCE(selected_hot.external_id, article.article_id) AS article_external_id`,
  `article.article_updated_at AS article_updated_at`,
  `article.arxiv_id AS arxiv_id`,
  `article.biorxiv_id AS biorxiv_id`,
  `article.medrxiv_id AS medrxiv_id`,
  `article.doi AS doi`,
  `article.pubmed_id AS pmid`,
  `selected_hot.journal_title AS journal_title`,
  `COALESCE(json_extract_string(selected_source.raw_payload, '$.covidence.citation.url'), article.url) AS url`,
  `article.full_text_pdf AS full_text_pdf`,
  `article.full_text_fetched_at AS full_text_fetched_at`,
  `article.full_text_conversion_status AS full_text_conversion_status`,
  `${reviewServingArticleSourceMetadataSql} AS source_metadata`,
].map((column) => {
  return column
})
const reviewServingJudgmentDetailFullColumns = [
  ...[
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'payload_kind',
    'article_id',
    'prompt_id',
    'prompt_order',
    'judgment_id',
    'is_answered',
    'answered_original',
    'answered_original_as_array',
    'judgment_created_at',
    'human_comment',
    'placeholder_kind',
    'detail_updated_at',
  ].map((column) => {
    return `${reviewServingJudgmentDetailTable}.${column}`
  }),
  `llm_judgment.model_id AS judgment_model_id`,
  `llm_judgment.explanation AS explanation`,
  `llm_judgment.quotes AS quotes`,
  `CASE WHEN ${reviewServingJudgmentDetailTable}.prompt_id = 'summary' THEN 'Overall human screening decision' ELSE prompt.original_text END AS prompt_original_text`,
  `CASE WHEN ${reviewServingJudgmentDetailTable}.prompt_id = 'summary' THEN NULL ELSE prompt.prompt_heading END AS prompt_heading`,
  `CASE WHEN ${reviewServingJudgmentDetailTable}.prompt_id = 'summary' THEN 'summary' ELSE prompt.type END AS prompt_type`,
  `CASE WHEN ${reviewServingJudgmentDetailTable}.prompt_id = 'summary' THEN NULL ELSE project_prompt.criteria_disposition END AS prompt_criteria_disposition`,
  `COALESCE(llm_judgment.updated_at, human_judgment.updated_at, human_summary.updated_at) AS judgment_updated_at`,
  `llm_judgment.chunking_strategy AS chunking_strategy`,
  `llm_judgment.confidence_original AS confidence_original`,
  `llm_judgment.snapshot_project_id AS snapshot_project_id`,
  `llm_judgment.snapshot_project_model_name AS snapshot_project_model_name`,
  `COALESCE(model.display_name, model.name, llm_judgment.snapshot_project_model_name) AS model_name`,
  `provider_connection.provider_kind AS model_provider`,
  `json_extract_string(model.metadata_json, '$.options.thinking') AS model_thinking`,
  `model.variant AS model_version`,
  `assessment.id AS assessment_id`,
  `assessment.judgment_id AS assessment_judgment_id`,
  `assessment.assessment_is_correct AS assessment_is_correct`,
  `assessment.assessment_comment AS assessment_comment`,
  `assessment.created_at AS assessment_created_at`,
  `assessment.updated_at AS assessment_updated_at`,
]
const reviewServingJudgmentDetailRouteListColumns = [
  ...[
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'payload_kind',
    'article_id',
    'prompt_id',
    'prompt_order',
    'judgment_id',
    'answered_original',
    'answered_original_as_array',
    'judgment_created_at',
    'human_comment',
    'placeholder_kind',
    'detail_updated_at',
  ].map((column) => {
    return `${reviewServingJudgmentDetailTable}.${column}`
  }),
  `llm_judgment.model_id AS judgment_model_id`,
  `llm_judgment.explanation AS explanation`,
  `llm_judgment.quotes AS quotes`,
]
const reviewServingJudgmentDetailFullColumnContractKeys = new Set<ReviewServingReadContract['key']>([
  'review.detail.judgments',
  'review.detail.humanJudgments',
])

const getReviewServingJudgmentDetailSelectColumns = (contract: ReviewServingReadContract) => {
  const listModeColumn =
    contract.listMode === 'both' ? "'both' AS list_mode_key" : `${reviewServingJudgmentDetailTable}.list_mode_key`
  const columns = reviewServingJudgmentDetailFullColumnContractKeys.has(contract.key)
    ? reviewServingJudgmentDetailFullColumns
    : reviewServingJudgmentDetailRouteListColumns

  return [...columns.slice(0, 3), listModeColumn, ...columns.slice(3)]
}

const getReviewServingJudgmentDetailAuthoritativeHydrationJoin = (params: {
  contract: ReviewServingReadContract
  projectIdParameter: string
  reviewConfigHashParameter: string
  snapshotIdParameter: string
}) => {
  const llmJudgmentJoin = [
    ` LEFT JOIN app."judgment" llm_judgment`,
    ` ON ${reviewServingJudgmentDetailTable}.payload_kind = 'llm'`,
    ` AND llm_judgment.id = ${reviewServingJudgmentDetailTable}.judgment_id`,
    ` AND llm_judgment.article_id = ${reviewServingJudgmentDetailTable}.article_id`,
    ` AND llm_judgment.prompt_id = ${reviewServingJudgmentDetailTable}.prompt_id`,
    ` AND llm_judgment.deleted_at IS NULL`,
  ].join('')

  return reviewServingJudgmentDetailFullColumnContractKeys.has(params.contract.key)
    ? [
        llmJudgmentJoin,
        ` LEFT JOIN app.judgment_assessment assessment`,
        ` ON assessment.id = (`,
        ` SELECT latest_assessment.id`,
        ` FROM app.judgment_assessment latest_assessment`,
        ` WHERE latest_assessment.judgment_id = llm_judgment.id`,
        ` ORDER BY latest_assessment.updated_at DESC NULLS LAST, latest_assessment.created_at DESC NULLS LAST, latest_assessment.id DESC`,
        ` LIMIT 1`,
        ` )`,
        ` LEFT JOIN app.model model`,
        ` ON model.id = llm_judgment.model_id`,
        ` LEFT JOIN app.provider_connection provider_connection`,
        ` ON provider_connection.id = model.provider_connection_id`,
        ` LEFT JOIN app."judgment_human" human_judgment`,
        ` ON ${reviewServingJudgmentDetailTable}.payload_kind = 'human'`,
        ` AND ${reviewServingJudgmentDetailTable}.prompt_id <> 'summary'`,
        ` AND human_judgment.project_id = ${params.projectIdParameter}`,
        ` AND human_judgment.id = ${reviewServingJudgmentDetailTable}.judgment_id`,
        ` AND human_judgment.article_id = ${reviewServingJudgmentDetailTable}.article_id`,
        ` AND human_judgment.prompt_id = ${reviewServingJudgmentDetailTable}.prompt_id`,
        ` LEFT JOIN app."judgment_human_summary" human_summary`,
        ` ON ${reviewServingJudgmentDetailTable}.payload_kind = 'human'`,
        ` AND ${reviewServingJudgmentDetailTable}.prompt_id = 'summary'`,
        ` AND human_summary.project_id = ${params.projectIdParameter}`,
        ` AND human_summary.id = ${reviewServingJudgmentDetailTable}.judgment_id`,
        ` AND human_summary.article_id = ${reviewServingJudgmentDetailTable}.article_id`,
        ` LEFT JOIN app.project_prompt project_prompt`,
        ` ON project_prompt.project_id = ${params.projectIdParameter}`,
        ` AND project_prompt.prompt_id = ${reviewServingJudgmentDetailTable}.prompt_id`,
        ` LEFT JOIN app.prompt prompt`,
        ` ON prompt.id = ${reviewServingJudgmentDetailTable}.prompt_id`,
      ].join('')
    : llmJudgmentJoin
}

const getReviewServingRowsSqlIdentityPredicates = (params: {
  contract: ReviewServingReadContract
  displayIdentityParameter: string
  filterOptionIdentityParameter?: string | null
  payloadIdentityParameter: string
  projectScopeIdentityParameter: string
  reviewConfigHashParameter: string
  searchIdentityParameter: string
  snapshotIdParameter: string
}) => {
  if (params.contract.servingTable === reviewServingPayloadTable) {
    return ` AND display_identity = ${params.displayIdentityParameter} AND payload_identity = ${params.payloadIdentityParameter} AND snapshot_id = ${params.snapshotIdParameter}`
  }

  if (params.contract.servingTable === reviewServingSnapshotManifestTable) {
    return ` AND review_config_hash IS NOT DISTINCT FROM ${params.reviewConfigHashParameter} AND snapshot_status IN ('active', 'retired')`
  }

  if (params.contract.servingTable === reviewServingSearchJobTable) {
    return ''
  }

  if (params.contract.servingTable === reviewServingBulkOperationJobTable) {
    return ` AND review_config_hash IS NOT DISTINCT FROM ${params.reviewConfigHashParameter} AND (snapshot_id = ${params.snapshotIdParameter} OR (latest_snapshot_semantics = TRUE AND snapshot_id IS NULL))`
  }

  if (params.contract.servingTable === reviewServingFilterOptionTable) {
    const filterOptionIdentityParameter = getRequiredReviewServingRowsSqlParameter(
      params.filterOptionIdentityParameter,
      'filter option identity',
      params.contract,
    )

    return ` AND review_config_hash = ${params.reviewConfigHashParameter} AND snapshot_id = ${params.snapshotIdParameter} AND search_identity = ${params.searchIdentityParameter} AND filter_option_identity = ${filterOptionIdentityParameter}`
  }

  const snapshotIdColumn = getReviewServingRowsSqlScopeColumn({contract: params.contract, field: 'snapshot_id'})
  const reviewConfigHashColumn =
    params.contract.servingTable === reviewServingJudgmentDetailTable
      ? `${reviewServingJudgmentDetailTable}.review_config_hash`
      : params.contract.servingTable === reviewServingFilterPostingTable
        ? `${reviewServingFilterPostingTable}.review_config_hash`
        : 'review_config_hash'

  return params.contract.servingTable === 'mart.review_title_search_serving_v4'
    ? ` AND search_identity = ${params.searchIdentityParameter} AND project_scope_identity = ${params.projectScopeIdentityParameter} AND snapshot_id = ${params.snapshotIdParameter}`
    : ` AND ${reviewConfigHashColumn} = ${params.reviewConfigHashParameter} AND ${snapshotIdColumn} = ${params.snapshotIdParameter}`
}

const reviewServingListModePredicateTables = new Set([
  'mart.review_article_filter_posting_serving_v4',
  'mart.review_article_judgment_detail_serving_v4',
  'mart.review_article_serving_v4',
])
const reviewServingCountServingTable = 'mart.review_article_count_serving_v4'
const reviewServingRuntimeListModeStrategies = new Set(['postingIntersection'])
const reviewServingCountListModesByKey: Partial<Record<NamedReviewFastCountKey, string>> = {
  'review.both.conflictByPrompt': 'both',
  'review.human.reviewedByPrompt': 'human',
  'review.llm.assessedByPrompt': 'llm',
  'review.llm.unassessedByPrompt': 'unassessed',
  'review.queue.unassessedReady': 'unassessed',
}

const getReviewServingRowsSqlListModePredicate = (params: {
  contract: ReviewServingReadContract
  listModeParameter: string
}) => {
  if (!reviewServingListModePredicateTables.has(params.contract.servingTable)) {
    return ''
  }

  const listModeColumn =
    params.contract.servingTable === reviewServingJudgmentDetailTable
      ? `${reviewServingJudgmentDetailTable}.list_mode_key`
      : params.contract.servingTable === reviewServingFilterPostingTable
        ? `${reviewServingFilterPostingTable}.list_mode_key`
        : 'list_mode_key'

  if (params.contract.listMode) {
    const physicalListMode =
      params.contract.servingTable === reviewServingJudgmentDetailTable && params.contract.listMode === 'both'
        ? params.contract.key === 'review.both.list.humanJudgments'
          ? 'human'
          : 'llm'
        : params.contract.listMode

    return ` AND ${listModeColumn} = ${getSqlStringLiteral(physicalListMode)}`
  }

  return reviewServingRuntimeListModeStrategies.has(params.contract.physicalAccessStrategy)
    ? ` AND ${listModeColumn} = ${params.listModeParameter}`
    : ''
}

const getReviewServingRowsSqlJudgmentPayloadKindPredicate = (contract: ReviewServingReadContract) => {
  if (contract.servingTable !== reviewServingJudgmentDetailTable) {
    return ''
  }

  const payloadKindColumn = `${reviewServingJudgmentDetailTable}.payload_kind`

  return contract.key === 'review.detail.humanJudgments'
    || contract.key === 'review.human.list.judgments'
    || contract.key === 'review.both.list.humanJudgments'
    ? ` AND ${payloadKindColumn} = 'human'`
    : ` AND ${payloadKindColumn} = 'llm'`
}

const reviewServingLlmListJudgmentContractsWithoutPlaceholders = new Set<ReviewServingReadContract['key']>([
  'review.llm.list.judgments',
  'review.both.list.judgments',
])

const getReviewServingRowsSqlJudgmentPlaceholderPredicate = (contract: ReviewServingReadContract) => {
  return reviewServingLlmListJudgmentContractsWithoutPlaceholders.has(contract.key)
    ? ` AND ${reviewServingJudgmentDetailTable}.placeholder_kind IS NULL`
    : ''
}

const getSqlStringLiteral = (value: string) => {
  return `'${value.replaceAll("'", "''")}'`
}

const getReviewServingRowsSqlCountPredicate = (params: {
  contract: ReviewServingReadContract
  countFilterKeyParameter?: string | null
  listModeParameter: string
  namedCountKey?: NamedReviewFastCountKey | null
}) => {
  if (params.contract.servingTable !== reviewServingCountServingTable) {
    return ''
  }

  if (!params.namedCountKey || !params.contract.namedFastCounts.includes(params.namedCountKey)) {
    throw new Error(`Missing supported named count key for ${params.contract.key}`)
  }

  if (!params.countFilterKeyParameter) {
    throw new Error(`Missing count filter key for ${params.contract.key}`)
  }

  const summaryDefinition = namedReviewFastCountDefinitions[params.namedCountKey]
  const listModeKey = reviewServingCountListModesByKey[params.namedCountKey] ?? params.contract.listMode ?? 'global'
  const listModePredicate = ` AND list_mode_key = ${getSqlStringLiteral(listModeKey)}`

  return [
    listModePredicate,
    ` AND count_kind = ${getSqlStringLiteral(params.namedCountKey)}`,
    ` AND summary_definition_version = ${getSqlStringLiteral(summaryDefinition.summaryDefinitionVersion)}`,
    ` AND filter_key = ${params.countFilterKeyParameter}`,
  ].join('')
}

const getReviewServingRowsSqlFacetVersionPredicate = (params: {
  contract: ReviewServingReadContract
  countFilterKeyParameter?: string | null
  countFilterKeysParameter?: string | null
}) => {
  if (params.contract.servingTable !== reviewServingFilterFacetTable) {
    return ''
  }

  const facetDefinitionVersions = params.contract.namedFastCounts
    .map((countKey) => {
      return namedReviewFastCountDefinitions[countKey]
    })
    .filter((definition) => {
      return definition.kind === 'facet'
    })
    .map((definition) => {
      return getSqlStringLiteral(definition.summaryDefinitionVersion)
    })

  if (facetDefinitionVersions.length === 0) {
    throw new Error(`Missing facet summary definition for ${params.contract.key}`)
  }

  const summaryIdentityPredicate = params.countFilterKeysParameter
    ? ` AND summary_identity IN (SELECT unnest(${params.countFilterKeysParameter}))`
    : ` AND summary_identity = ${getRequiredReviewServingRowsSqlParameter(
        params.countFilterKeyParameter,
        'facet filter key',
        params.contract,
      )}`

  const facetKindPredicate =
    params.contract.key === 'review.human.filters.facets' ? " AND facet_kind = 'human'" : " AND facet_kind = 'review'"
  const summaryVersionPredicate =
    facetDefinitionVersions.length === 1
      ? ` AND summary_definition_version = ${facetDefinitionVersions[0]}`
      : ` AND summary_definition_version IN (${facetDefinitionVersions.join(', ')})`

  return `${facetKindPredicate}${summaryVersionPredicate}${summaryIdentityPredicate}`
}

const getRequiredReviewServingRowsSqlParameter = (
  parameter: string | null | undefined,
  label: string,
  contract: ReviewServingReadContract,
) => {
  if (!parameter) {
    throw new Error(`Missing ${label} for ${contract.key}`)
  }

  return parameter
}

const getReviewServingRowsSqlScopeColumn = (params: {contract: ReviewServingReadContract; field: string}) => {
  return `${params.contract.servingTable}.${params.field}`
}

const getReviewServingRowsSqlArticlePredicate = (params: {
  articleIdParameter?: string | null
  articleIdsParameter?: string | null
  contract: ReviewServingReadContract
}) => {
  if (!params.contract.allowedFilters.includes('articleId')) {
    return ''
  }

  if (params.contract.physicalAccessStrategy === 'articleSetLookup') {
    const articleIdsParameter = getRequiredReviewServingRowsSqlParameter(
      params.articleIdsParameter,
      'article ids',
      params.contract,
    )

    return ` AND ${params.contract.servingTable}.article_id IN (SELECT unnest(${articleIdsParameter}))`
  }

  if (params.contract.physicalAccessStrategy !== 'keyedLookup') {
    return ''
  }

  const articleIdParameter = getRequiredReviewServingRowsSqlParameter(
    params.articleIdParameter,
    'article id',
    params.contract,
  )

  return ` AND ${params.contract.servingTable}.article_id = ${articleIdParameter}`
}

const getReviewServingRowsSqlPostingPredicate = (params: {
  contract: ReviewServingReadContract
  filterPredicatesSql?: string | null
  filterKindParameter?: string | null
  filterValueParameter?: string | null
  listModeParameter: string
  projectIdParameter: string
  projectScopeIdentityParameter: string
  reviewConfigHashParameter: string
  searchIdentityParameter: string
  searchTokenPrefixParameter?: string | null
  snapshotIdParameter: string
}) => {
  if (params.contract.physicalAccessStrategy !== 'postingIntersection') {
    return ''
  }

  const filterKindParameter = getRequiredReviewServingRowsSqlParameter(
    params.filterKindParameter,
    'filter kind',
    params.contract,
  )
  const filterValueParameter = getRequiredReviewServingRowsSqlParameter(
    params.filterValueParameter,
    'filter value',
    params.contract,
  )

  const anchorPredicate = ` AND filter_kind = ${filterKindParameter} AND filter_value = ${filterValueParameter}`
  const searchPredicate = params.searchTokenPrefixParameter
    ? [
        ' AND EXISTS (SELECT 1 FROM mart.review_title_search_serving_v4 search',
        ` WHERE search.project_id = ${params.projectIdParameter}`,
        ` AND search.search_identity = ${params.searchIdentityParameter}`,
        ` AND search.project_scope_identity = ${params.projectScopeIdentityParameter}`,
        ` AND search.snapshot_id = ${params.snapshotIdParameter}`,
        ` AND search.article_id = ${params.contract.servingTable}.article_id`,
        ` AND starts_with(search.token, ${params.searchTokenPrefixParameter}))`,
      ].join('')
    : ''

  if (!params.filterPredicatesSql) {
    return `${anchorPredicate}${searchPredicate}`
  }

  throw new Error(`Multi-filter posting intersections require a precomputed serving lookup for ${params.contract.key}`)
}

const getReviewServingRowsSqlSearchPredicate = (params: {
  contract: ReviewServingReadContract
  searchTokenPrefixParameter?: string | null
}) => {
  if (params.contract.physicalAccessStrategy !== 'tokenPrefixIndex') {
    return ''
  }

  const searchTokenPrefixParameter = getRequiredReviewServingRowsSqlParameter(
    params.searchTokenPrefixParameter,
    'search token prefix',
    params.contract,
  )

  return ` AND starts_with(token, ${searchTokenPrefixParameter})`
}

const getReviewServingRowsSqlQueuePredicate = (params: {
  contract: ReviewServingReadContract
  projectIdParameter: string
  projectScopeIdentityParameter: string
  queueKindParameter?: string | null
  searchIdentityParameter: string
  searchTokenPrefixParameter?: string | null
  searchTokenPrefixesParameter?: string | null
  snapshotIdParameter: string
}) => {
  if (params.contract.physicalAccessStrategy !== 'queueOrdering') {
    return ''
  }

  const queueKindParameter = getRequiredReviewServingRowsSqlParameter(
    params.queueKindParameter,
    'queue kind',
    params.contract,
  )

  const searchPredicate = params.searchTokenPrefixesParameter
    ? [
        ` AND NOT EXISTS (SELECT 1 FROM (SELECT unnest(${params.searchTokenPrefixesParameter}) AS token_prefix) search_prefix`,
        ' WHERE NOT EXISTS (SELECT 1 FROM mart.review_title_search_serving_v4 search',
        ` WHERE search.project_id = ${params.projectIdParameter}`,
        ` AND search.search_identity = ${params.searchIdentityParameter}`,
        ` AND search.project_scope_identity = ${params.projectScopeIdentityParameter}`,
        ` AND search.snapshot_id = ${params.snapshotIdParameter}`,
        ` AND search.article_id = ${params.contract.servingTable}.article_id`,
        ' AND starts_with(search.token, search_prefix.token_prefix)))',
      ].join('')
    : ''

  return ` AND queue_kind = ${queueKindParameter}${searchPredicate}`
}

const getReviewServingRowsSqlUnassessedQueuePredicate = (params: {
  contract: ReviewServingReadContract
  projectIdParameter: string
  reviewConfigHashParameter: string
  snapshotIdParameter: string
}) => {
  return params.contract.key === 'review.unassessed.rows'
    ? [
        ' AND EXISTS (SELECT 1 FROM mart.review_unassessed_queue_serving_v4 queue',
        ` WHERE queue.project_id = ${params.projectIdParameter}`,
        ` AND queue.review_config_hash = ${params.reviewConfigHashParameter}`,
        ` AND queue.snapshot_id = ${params.snapshotIdParameter}`,
        " AND queue.queue_kind = 'unassessed'",
        ` AND queue.article_id = ${params.contract.servingTable}.article_id)`,
      ].join('')
    : ''
}

const getReviewServingRowsSqlJobPredicate = (params: {
  contract: ReviewServingReadContract
  jobFilterSignatureParameter?: string | null
  projectScopeIdentityParameter: string
  reviewConfigHashParameter: string
  searchIdentityParameter: string
  searchTextParameter?: string | null
  snapshotIdParameter: string
}) => {
  if (params.contract.physicalAccessStrategy !== 'jobCriteria') {
    return ''
  }

  const jobFilterSignatureParameter = getRequiredReviewServingRowsSqlParameter(
    params.jobFilterSignatureParameter,
    'job filter signature',
    params.contract,
  )

  if (params.contract.servingTable === reviewServingBulkOperationJobTable) {
    return ` AND job_kind = ${getSqlStringLiteral(params.contract.key)} AND filter_signature = ${jobFilterSignatureParameter}`
  }

  if (params.contract.servingTable === reviewServingSearchJobTable) {
    const searchTextParameter = getRequiredReviewServingRowsSqlParameter(
      params.searchTextParameter,
      'search text',
      params.contract,
    )

    return [
      ` AND search_identity IS NOT DISTINCT FROM ${params.searchIdentityParameter}`,
      ` AND project_scope_identity = ${params.projectScopeIdentityParameter}`,
      ` AND review_config_hash IS NOT DISTINCT FROM ${params.reviewConfigHashParameter}`,
      ` AND snapshot_id IS NOT DISTINCT FROM ${params.snapshotIdParameter}`,
      ` AND search_mode = ${getSqlStringLiteral(params.contract.searchMode)}`,
      ` AND search_text = ${searchTextParameter}`,
      ` AND filter_signature = ${jobFilterSignatureParameter}`,
    ].join('')
  }

  throw new Error(`Unsupported job criteria table for ${params.contract.key}`)
}

const getReviewServingRowsSqlListModeDedupeQualifier = (contract: ReviewServingReadContract) => {
  if (contract.key === 'review.prompt.preview') {
    return ` QUALIFY ${reviewServingListModePrioritySql} = min(${reviewServingListModePrioritySql}) OVER (PARTITION BY ${reviewServingArticleTable}.article_id)`
  }

  return contract.servingTable === reviewServingJudgmentDetailTable
    ? ` QUALIFY ${reviewServingJudgmentDetailListModePrioritySql} = min(${reviewServingJudgmentDetailListModePrioritySql}) OVER (PARTITION BY ${reviewServingJudgmentDetailTable}.article_id, ${reviewServingJudgmentDetailTable}.prompt_id)`
    : ''
}

const getReviewServingRowsSqlSelect = (contract: ReviewServingReadContract) => {
  if (contract.servingTable === reviewServingArticleTable) {
    const articleSelectColumns = [
      ...reviewServingArticlePhysicalSelectColumns,
      ...reviewServingArticleSelectedImportColumns,
      ...reviewServingArticlePayloadDisplayColumns,
      ...(contract.key === 'review.prompt.preview' ? ['LEFT(article.article_summary, 2000) AS article_summary'] : []),
    ].join(', ')

    return contract.sort.fields.some((field) => {
      return (
        field.includes(reviewServingListModePrioritySql)
        || field.includes(reviewServingJudgmentDetailListModePrioritySql)
      )
    })
      ? `SELECT ${articleSelectColumns}, ${reviewServingListModePrioritySql} AS ${reviewServingListModePriorityAlias}`
      : `SELECT ${articleSelectColumns}`
  }

  if (contract.servingTable === reviewServingJudgmentDetailTable) {
    const selectColumns = getReviewServingJudgmentDetailSelectColumns(contract).join(', ')
    const listModePrioritySql = reviewServingJudgmentDetailFullColumnContractKeys.has(contract.key)
      ? reviewServingJudgmentDetailListModePrioritySql
      : reviewServingListModePrioritySql

    return contract.sort.fields.some((field) => {
      return (
        field.includes(reviewServingListModePrioritySql)
        || field.includes(reviewServingJudgmentDetailListModePrioritySql)
      )
    })
      ? `SELECT ${selectColumns}, ${listModePrioritySql} AS ${reviewServingListModePriorityAlias}`
      : `SELECT ${selectColumns}`
  }

  if (contract.servingTable === reviewServingFilterPostingTable) {
    return `SELECT ${reviewServingFilterPostingTable}.*, ${reviewServingArticleTable}.sort_key AS sort_key`
  }

  return contract.sort.fields.some((field) => {
    return field.includes(reviewServingListModePrioritySql)
  })
    ? `SELECT *, ${reviewServingListModePrioritySql} AS ${reviewServingListModePriorityAlias}`
    : 'SELECT *'
}

const getReviewServingRowsSqlPhysicalFilterPredicate = (params: {
  articleIdParameter?: string | null
  articleIdsParameter?: string | null
  contract: ReviewServingReadContract
  filterPredicatesSql?: string | null
  filterKindParameter?: string | null
  filterValueParameter?: string | null
  jobFilterSignatureParameter?: string | null
  listModeParameter: string
  projectIdParameter: string
  projectScopeIdentityParameter: string
  reviewConfigHashParameter: string
  searchIdentityParameter: string
  queueKindParameter?: string | null
  searchTokenPrefixParameter?: string | null
  searchTokenPrefixesParameter?: string | null
  searchTextParameter?: string | null
  snapshotIdParameter: string
}) => {
  return [
    getReviewServingRowsSqlArticlePredicate(params),
    getReviewServingRowsSqlPostingPredicate(params),
    getReviewServingRowsSqlSearchPredicate(params),
    getReviewServingRowsSqlQueuePredicate(params),
    getReviewServingRowsSqlUnassessedQueuePredicate(params),
    getReviewServingRowsSqlJobPredicate(params),
    params.filterPredicatesSql ?? '',
  ].join('')
}

export const buildReviewServingRowsSql = (params: {
  articleIdParameter?: string | null
  articleIdsParameter?: string | null
  contract: ReviewServingReadContract
  countFilterKeyParameter?: string | null
  countFilterKeysParameter?: string | null
  cursorPredicate?: string
  displayIdentityParameter: string
  filterOptionIdentityParameter?: string | null
  filterPredicatesSql?: string | null
  filterKindParameter?: string | null
  filterValueParameter?: string | null
  jobFilterSignatureParameter?: string | null
  limitParameter: string
  listModeParameter: string
  namedCountKey?: NamedReviewFastCountKey | null
  payloadIdentityParameter: string
  projectIdParameter: string
  projectScopeIdentityParameter: string
  queueKindParameter?: string | null
  reviewConfigHashParameter: string
  searchIdentityParameter: string
  selectedImportSnapshotIdParameter?: string | null
  searchTextParameter?: string | null
  searchTokenPrefixParameter?: string | null
  searchTokenPrefixesParameter?: string | null
  snapshotIdParameter: string
}) => {
  const selectedImportSnapshotIdParameter =
    params.contract.servingTable === reviewServingArticleTable
      ? (params.selectedImportSnapshotIdParameter ?? '$selectedImportSnapshotId')
      : null
  const articlePayloadJoin =
    params.contract.servingTable === reviewServingArticleTable
      ? [
          ` INNER JOIN ${reviewServingPayloadTable} payload`,
          ` ON payload.project_id = ${params.projectIdParameter}`,
          ` AND payload.project_id = ${reviewServingArticleTable}.project_id`,
          ` AND payload.display_identity = ${params.displayIdentityParameter}`,
          ` AND payload.payload_identity = ${params.payloadIdentityParameter}`,
          ` AND payload.snapshot_id = ${params.snapshotIdParameter}`,
          ` AND payload.snapshot_id = ${reviewServingArticleTable}.snapshot_id`,
          ` AND payload.article_id = ${reviewServingArticleTable}.article_id`,
          ` LEFT JOIN ${reviewServingSelectedImportTable} selected_import`,
          ` ON selected_import.project_id = ${params.projectIdParameter}`,
          ` AND selected_import.project_id = ${reviewServingArticleTable}.project_id`,
          ` AND selected_import.project_scope_identity = ${params.projectScopeIdentityParameter}`,
          ` AND selected_import.selected_import_snapshot_id = ${selectedImportSnapshotIdParameter}`,
          ` AND selected_import.article_id = ${reviewServingArticleTable}.article_id`,
          ` AND NOT selected_import.tombstone`,
          ` LEFT JOIN app.article article`,
          ` ON article.id = ${reviewServingArticleTable}.article_id`,
          ` LEFT JOIN app.review_import_article_hot_field selected_hot`,
          ` ON selected_hot.import_route_id = selected_import.import_route_id`,
          ` AND selected_hot.article_id = ${reviewServingArticleTable}.article_id`,
          ` AND selected_hot.source_record_key = selected_import.source_record_key`,
          ` AND NOT selected_hot.tombstone`,
          ` LEFT JOIN app.article_import_route_source_record selected_source`,
          ` ON selected_source.import_route_id = selected_import.import_route_id`,
          ` AND selected_source.article_id = ${reviewServingArticleTable}.article_id`,
          ` AND selected_source.source_record_key = selected_import.source_record_key`,
          ` AND selected_source.quarantined_at IS NULL`,
        ].join('')
      : ''
  const judgmentDetailHydrationJoin =
    params.contract.servingTable === reviewServingJudgmentDetailTable
      ? getReviewServingJudgmentDetailAuthoritativeHydrationJoin(params)
      : ''
  const postingArticleSortJoin =
    params.contract.servingTable === reviewServingFilterPostingTable
      ? [
          ` INNER JOIN ${reviewServingArticleTable}`,
          ` ON ${reviewServingArticleTable}.project_id = ${params.projectIdParameter}`,
          ` AND ${reviewServingArticleTable}.project_id = ${reviewServingFilterPostingTable}.project_id`,
          ` AND ${reviewServingArticleTable}.review_config_hash = ${params.reviewConfigHashParameter}`,
          ` AND ${reviewServingArticleTable}.review_config_hash = ${reviewServingFilterPostingTable}.review_config_hash`,
          ` AND ${reviewServingArticleTable}.snapshot_id = ${params.snapshotIdParameter}`,
          ` AND ${reviewServingArticleTable}.snapshot_id = ${reviewServingFilterPostingTable}.snapshot_id`,
          ` AND ${reviewServingArticleTable}.list_mode_key = ${reviewServingFilterPostingTable}.list_mode_key`,
          ` AND ${reviewServingArticleTable}.article_id = ${reviewServingFilterPostingTable}.article_id`,
        ].join('')
      : ''
  const cursorPredicate = params.cursorPredicate ? ` AND (${params.cursorPredicate})` : ''
  const identityPredicates = getReviewServingRowsSqlIdentityPredicates(params)
  const listModePredicate = getReviewServingRowsSqlListModePredicate(params)
  const judgmentPayloadKindPredicate = getReviewServingRowsSqlJudgmentPayloadKindPredicate(params.contract)
  const judgmentPlaceholderPredicate = getReviewServingRowsSqlJudgmentPlaceholderPredicate(params.contract)
  const countPredicate = getReviewServingRowsSqlCountPredicate(params)
  const facetVersionPredicate = getReviewServingRowsSqlFacetVersionPredicate(params)
  const physicalFilterPredicate = getReviewServingRowsSqlPhysicalFilterPredicate(params)
  const listModeDedupeQualifier = getReviewServingRowsSqlListModeDedupeQualifier(params.contract)
  const selectSql = getReviewServingRowsSqlSelect(params.contract)
  const sortSql = getSortSql(params.contract)

  const projectIdColumn = getReviewServingRowsSqlScopeColumn({contract: params.contract, field: 'project_id'})

  return [
    `${selectSql} FROM ${params.contract.servingTable}${articlePayloadJoin}${judgmentDetailHydrationJoin}${postingArticleSortJoin} WHERE ${projectIdColumn} = ${params.projectIdParameter}`,
    identityPredicates,
    listModePredicate,
    judgmentPayloadKindPredicate,
    judgmentPlaceholderPredicate,
    countPredicate,
    facetVersionPredicate,
    physicalFilterPredicate,
    cursorPredicate,
    listModeDedupeQualifier,
    ` ORDER BY ${sortSql} LIMIT ${params.limitParameter}`,
  ].join('')
}
