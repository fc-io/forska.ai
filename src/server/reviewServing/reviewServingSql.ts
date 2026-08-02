import {
  namedReviewFastCountDefinitions,
  type NamedReviewFastCountKey,
  type ReviewServingListMode,
  type ReviewServingReadContract,
} from './reviewServingContracts.ts'
import {reviewServingReadContractList} from './reviewServingReadContracts.ts'
import {reviewServingSqlForbiddenPatterns} from './reviewServingSqlForbiddenPatterns.ts'

export type ReviewServingSqlShapeResult =
  | {ok: true; violations: []}
  | {ok: false; violations: readonly {label: string; pattern: string}[]}

export type ReviewServingSqlShapeOptions = {
  allowCanonicalPromptAnswerFallback?: boolean
  allowedTables?: readonly string[]
  requireLimit?: boolean
  requireOrderBy?: boolean
  requireProjectScope?: boolean
  requireRegisteredTable?: boolean
  requireSnapshotScope?: boolean
}

export type ReviewServingPostingFilterIntersectionGroup = {filterKind: string; filterValues: readonly string[]}

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
    'mart.review_article_serving_base_v4',
    'mart.review_article_serving_list_mode_state_v4',
    'mart.review_unassessed_queue_article_rank_serving_v4',
  ]),
].sort()

const getDefaultReviewServingSqlShapeOptions = (): Required<ReviewServingSqlShapeOptions> => {
  return {
    allowCanonicalPromptAnswerFallback: false,
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

export const getReviewServingSqlForbiddenPatternViolations = (sql: string, options?: ReviewServingSqlShapeOptions) => {
  const shapeOptions = {...getDefaultReviewServingSqlShapeOptions(), ...options}
  const allowCanonicalPromptAnswerFallback =
    shapeOptions.allowCanonicalPromptAnswerFallback && hasOnlyBoundedLazyPromptAnswerCanonicalForbiddenPatterns(sql)

  return reviewServingSqlForbiddenPatterns
    .filter((forbiddenPattern) => {
      if (forbiddenPattern.label === 'raw article table scan' && hasBoundedArticleLookupJoin(sql)) {
        return false
      }

      if (
        forbiddenPattern.label === 'raw judgment table scan'
        && (hasBoundedJudgmentAuthoritativeHydrationJoin(sql) || allowCanonicalPromptAnswerFallback)
      ) {
        return false
      }

      if (forbiddenPattern.label === 'window row number' && allowCanonicalPromptAnswerFallback) {
        return false
      }

      if (
        forbiddenPattern.label === 'json extraction'
        && (hasOnlyBoundedJsonExtraction(sql) || allowCanonicalPromptAnswerFallback)
      ) {
        return false
      }

      if (
        forbiddenPattern.label === 'foreground aggregation'
        && (hasOnlyBoundedPostingFilterIntersectionAggregation(sql)
          || hasOnlyBoundedUnassessedQueueArticleAnchorAggregation(sql)
          || hasOnlyBoundedLazyPromptAnswerPostingCacheAggregation(sql)
          || allowCanonicalPromptAnswerFallback)
      ) {
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

const getReviewServingSqlCteNames = (sql: string) => {
  const matches = /^\s*with\b/iu.test(sql) ? [...sql.matchAll(/(?:\bwith|,)\s+([a-z_][\w]*)\s+as\s*\(/giu)] : []

  return new Set(
    matches.map((match) => {
      return normalizeSqlIdentifier(match[1] ?? '')
    }),
  )
}

const hasBoundedArticleLookupJoin = (sql: string) => {
  return (
    /\bleft\s+join\s+app\.article\s+article\s+on\s+article\.id\s*=\s*mart\.review_article_serving_base_v4\.article_id\b/iu.test(
      sql,
    )
    || /\bleft\s+join\s+app\.article\s+article\s+on\s+article\.id\s*=\s*serving\.article_id\b/iu.test(sql)
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

const hasBoundedLazyPromptAnswerCanonicalSource = (sql: string) => {
  return (
    /\bcanonical_prompt_answer_posting_rows\s+as\s*\(/iu.test(sql)
    && /\bposting_filter_rows\s+as\s*\(/iu.test(sql)
    && /\bfrom\s+app\."?judgment"?\s+judgment\b/iu.test(sql)
    && /\binner\s+join\s+scoped_serving\s+serving\s+on\s+serving\.article_id\s*=\s*judgment\.article_id\b/iu.test(sql)
    && /\binner\s+join\s+active_prompt\s+prompt\s+on\s+prompt\.prompt_id\s*=\s*judgment\.prompt_id\b/iu.test(sql)
    && /\bwhere\s+judgment\.deleted_at\s+is\s+null\b/iu.test(sql)
    && /\bfrom\s+app\."?judgment_human"?\s+judgment_human\b/iu.test(sql)
    && /\bjudgment_human\.project_id\b/iu.test(sql)
    && /\bfrom\s+app\."?judgment_human_summary"?\s+judgment_human_summary\b/iu.test(sql)
    && /\bjudgment_human_summary\.project_id\b/iu.test(sql)
    && /\bfrom\s+mart\.review_article_serving_list_mode_state_v4\s+list_mode_state\b/iu.test(sql)
    && /\blist_mode_state\.project_id\s*=\s*[$:@?][\w.]+/iu.test(sql)
    && /\blist_mode_state\.review_config_hash\s*=\s*[$:@?][\w.]+/iu.test(sql)
    && /\blist_mode_state\.snapshot_id\s*=\s*[$:@?][\w.]+/iu.test(sql)
    && /\bfrom\s+app\.project_prompt\s+project_prompt\b/iu.test(sql)
    && /\bproject_prompt\.project_id\s*=\s*[$:@?][\w.]+/iu.test(sql)
    && /\bproject_prompt\.enabled\b/iu.test(sql)
    && /\bnot\s+project_prompt\.archived\b/iu.test(sql)
  )
}

const hasOnlyBoundedLazyPromptAnswerCanonicalForbiddenPatterns = (sql: string) => {
  if (!hasBoundedLazyPromptAnswerCanonicalSource(sql)) {
    return false
  }

  const rawJudgmentReferences = getReviewServingSqlTableReferenceDetails(sql).filter((tableReference) => {
    return ['app.judgment', 'app.judgment_human', 'app.judgment_human_summary'].includes(tableReference.table)
  })
  const hasOnlyExpectedJudgmentAliases = rawJudgmentReferences.every((tableReference) => {
    return (
      (tableReference.table === 'app.judgment' && tableReference.alias === 'judgment')
      || (tableReference.table === 'app.judgment_human' && tableReference.alias === 'judgment_human')
      || (tableReference.table === 'app.judgment_human_summary' && tableReference.alias === 'judgment_human_summary')
    )
  })

  return (
    hasOnlyExpectedJudgmentAliases
    && [...sql.matchAll(/\brow_number\s*\(/giu)].length === 1
    && [...sql.matchAll(/\bgroup\s+by\b/giu)].length === 2
    && /\bgroup\s+by\s+requested\.filter_value\b/iu.test(sql)
    && /\bgroup\s+by\s+serving\.article_id,\s*serving\.list_mode_key\b/iu.test(sql)
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

const hasOnlyBoundedPostingFilterIntersectionAggregation = (sql: string) => {
  const groupByClauses = [...sql.matchAll(/\bgroup\s+by\b/giu)]

  return (
    groupByClauses.length === 1
    && /\bposting_filtered_article_ids\s+as\s*\(/iu.test(sql)
    && /\bfrom\s+mart\.review_article_filter_posting_serving_v4\s+posting\b/iu.test(sql)
    && /\bwhere\s+posting\.project_id\s*=\s*[$:@?][\w.]+/iu.test(sql)
    && /\bposting\.snapshot_id\s*=\s*[$:@?][\w.]+/iu.test(sql)
    && /\bposting\.review_config_hash\s*=\s*[$:@?][\w.]+/iu.test(sql)
    && /\bposting\.list_mode_key\s*=/iu.test(sql)
    && /\bcross\s+join\s+unnest\s*\(\s*posting\.article_ids\s*\)\s+as\s+posting_article\s*\(\s*article_id\s*\)/iu.test(
      sql,
    )
    && /\bgroup\s+by\s+posting_article\.article_id\b/iu.test(sql)
    && /\bhaving\s+count\s*\(\s*distinct\s+case\b/iu.test(sql)
  )
}

const hasOnlyBoundedUnassessedQueueArticleAnchorAggregation = (sql: string) => {
  return (
    /\bunassessed_queue_candidate\s+as\s*\(/iu.test(sql)
    && /\bfrom\s+mart\.review_unassessed_queue_article_rank_serving_v4\s+queue\b/iu.test(sql)
    && /\bwhere\s+queue\.project_id\s*=\s*[$:@?][\w.]+/iu.test(sql)
    && /\bqueue\.snapshot_id\s*=\s*[$:@?][\w.]+/iu.test(sql)
    && /\bqueue\.review_config_hash\s*=\s*[$:@?][\w.]+/iu.test(sql)
    && /\bqueue\.queue_kind\s*=\s*'unassessed'/iu.test(sql)
  )
}

const hasOnlyBoundedLazyPromptAnswerPostingCacheAggregation = (sql: string) => {
  return (
    /\binsert\s+into\s+mart\.review_article_filter_posting_serving_v4\b/iu.test(sql)
    && /\bfrom\s*\(\s*select\s+distinct\s+unnest\s*\(\s*\$\{input\.filterValuesSql\}::varchar\[\]\s*\)\s+as\s+filter_value\s*\)\s+requested\b/iu.test(
      sql,
    )
    && /\bleft\s+join\s*\(\s*\$\{getReviewServingLazyPromptAnswerPostingSourceSql\(input\)\}\s*\)\s+source\b/iu.test(
      sql,
    )
    && /\bsource\.filter_value\s*=\s*requested\.filter_value\b/iu.test(sql)
    && /\bwhere\s+requested\.filter_value\s+is\s+not\s+null\b/iu.test(sql)
    && /\brequested\.filter_value\s*<>\s*''\b/iu.test(sql)
    && /\bgroup\s+by\s+requested\.filter_value\b/iu.test(sql)
  )
}

const isBoundedArticleLookupReference = (sql: string, tableReference: ReviewServingSqlTableReference) => {
  return (
    tableReference.table === 'app.article' && tableReference.alias === 'article' && hasBoundedArticleLookupJoin(sql)
  )
}

const hasBoundedSelectedImportLookupJoin = (sql: string) => {
  return (
    /\bleft\s+join\s+mart\.review_selected_article_import_current_v4\s+selected_import\b/iu.test(sql)
    && /\bselected_import\.project_id\s*=\s*[$:@?a-z_][\w.$:]*/iu.test(sql)
    && /\bselected_import\.project_id\s*=\s*(?:mart\.review_article_serving_base_v4|serving)\.project_id\b/iu.test(sql)
    && /\bselected_import\.project_scope_identity\s*=\s*[$:@?a-z_][\w.$:]*/iu.test(sql)
    && /\bselected_import\.selected_import_snapshot_id\s*=\s*[$:@?a-z_][\w.$:]*/iu.test(sql)
    && /\bselected_import\.article_id\s*=\s*(?:mart\.review_article_serving_base_v4|serving)\.article_id\b/iu.test(sql)
    && /\bnot\s+selected_import\.tombstone\b/iu.test(sql)
  )
}

const isBoundedSelectedImportLookupReference = (sql: string, tableReference: ReviewServingSqlTableReference) => {
  return (
    tableReference.table === 'mart.review_selected_article_import_current_v4'
    && tableReference.alias === 'selected_import'
    && hasBoundedSelectedImportLookupJoin(sql)
  )
}

const hasBoundedSelectedSourceRecordLookupJoin = (sql: string) => {
  return (
    /\bleft\s+join\s+app\.article_import_route_source_record\s+selected_source\b/iu.test(sql)
    && /\bselected_source\.import_route_id\s*=\s*selected_import\.import_route_id\b/iu.test(sql)
    && /\bselected_source\.article_id\s*=\s*(?:mart\.review_article_serving_base_v4|serving)\.article_id\b/iu.test(sql)
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
    && /\bselected_hot\.article_id\s*=\s*(?:mart\.review_article_serving_base_v4|serving)\.article_id\b/iu.test(sql)
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

const hasBoundedPromptAnswerProjectSettingsLookup = (sql: string) => {
  return (
    /\bselect\s+coalesce\s*\(\s*\(\s*select\s+project\.human_judgment_mode\s+from\s+app\.project\s+project\s+where\s+project\.id\s*=\s*[$:@?][\w.]+\s*\)\s*,\s*'prompt'\s*\)\s+as\s+human_judgment_mode\b/iu.test(
      sql,
    ) && /\bproject_settings\s+as\s*\(/iu.test(sql)
  )
}

const isBoundedPromptAnswerProjectSettingsReference = (sql: string, tableReference: ReviewServingSqlTableReference) => {
  return (
    tableReference.table === 'app.project'
    && tableReference.alias === 'project'
    && hasBoundedPromptAnswerProjectSettingsLookup(sql)
  )
}

const isBoundedTableFunctionReference = (tableReference: ReviewServingSqlTableReference) => {
  return ['json_each', 'unnest'].includes(tableReference.table)
}

const isBoundedLazyPromptAnswerCanonicalReference = (
  sql: string,
  tableReference: ReviewServingSqlTableReference,
  options: Required<ReviewServingSqlShapeOptions>,
) => {
  return (
    options.allowCanonicalPromptAnswerFallback
    && hasBoundedLazyPromptAnswerCanonicalSource(sql)
    && [
      'active_prompt',
      'and',
      'app.judgment',
      'app.judgment_human',
      'app.judgment_human_summary',
      'app.project',
      'app.project_prompt',
      'app.prompt',
      'judgment',
      'judgment_human',
      'judgment_human_summary',
      'latest_llm_judgment',
      'project',
      'project_prompt',
      'project_settings',
      'prompt',
      'scoped_serving',
      'serving',
    ].includes(tableReference.alias ?? tableReference.table)
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
  const cteNames = getReviewServingSqlCteNames(sql)
  const tableReferences = getReviewServingSqlTableReferences(sql)
  const missingTableViolations =
    tableReferences.length === 0
      ? [{label: 'registered serving table', pattern: 'FROM <registered review-serving table>'}]
      : []
  const unregisteredTableViolations = tableReferences
    .filter((tableReference) => {
      return !cteNames.has(tableReference)
    })
    .filter((tableReference) => {
      return tableReference !== 'app.article' || !hasBoundedArticleLookupJoin(sql)
    })
    .filter((tableReference) => {
      return (
        tableReference !== 'mart.review_selected_article_import_current_v4' || !hasBoundedSelectedImportLookupJoin(sql)
      )
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
        !['app.project_prompt', 'app.prompt'].includes(tableReference)
        || !(options.allowCanonicalPromptAnswerFallback && hasBoundedLazyPromptAnswerCanonicalSource(sql))
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
        ].includes(tableReference)
        || !(
          hasBoundedJudgmentAuthoritativeHydrationJoin(sql)
          || (options.allowCanonicalPromptAnswerFallback && hasBoundedLazyPromptAnswerCanonicalSource(sql))
        )
      )
    })
    .filter((tableReference) => {
      return (
        tableReference !== 'app.project'
        || !(
          hasBoundedPromptAnswerProjectSettingsLookup(sql)
          || (options.allowCanonicalPromptAnswerFallback && hasBoundedLazyPromptAnswerCanonicalSource(sql))
        )
      )
    })
    .filter((tableReference) => {
      return !['json_each', 'unnest'].includes(tableReference)
    })
    .filter((tableReference) => {
      return (
        !(options.allowCanonicalPromptAnswerFallback && hasBoundedLazyPromptAnswerCanonicalSource(sql))
        || !/^[a-z_][\w]*\.(?:project_id|snapshot_id)$/iu.test(tableReference)
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
  const cteNames = getReviewServingSqlCteNames(sql)
  const tableReferences = getReviewServingSqlTableReferenceDetails(sql).filter((tableReference) => {
    return !cteNames.has(tableReference.table)
  })
  const hasMultipleReferences = tableReferences.length > 1
  const scopedPredicateClause =
    sql.match(/\bfrom\b([\s\S]*?)(?:\bqualify\b|\border\s+by\b|\blimit\b|\bgroup\s+by\b|\bhaving\b|$)/iu)?.[1] ?? ''
  const joinedPredicateClause = sql.match(/\bfrom\b([\s\S]*?)(?:\bqualify\b|\border\s+by\b|\blimit\b|$)/iu)?.[1] ?? ''
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
              || isBoundedLazyPromptAnswerCanonicalReference(sql, tableReference, options)
              || isBoundedPromptAnswerProjectSettingsReference(sql, tableReference)
              || isBoundedTableFunctionReference(tableReference)
            ) {
              return false
            }

            const predicateClause = tableReferenceIndex === 0 ? wherePredicateClause : scopedPredicateClause
            const joinedAliasPredicateClause =
              tableReferenceIndex === 0 ? predicateClause : `${predicateClause}\n${joinedPredicateClause}`

            return !getScopePredicatePattern(tableReference, field).test(joinedAliasPredicateClause)
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
    ...getReviewServingSqlForbiddenPatternViolations(sql, shapeOptions),
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
const reviewServingArticleBaseTable = 'mart.review_article_serving_base_v4'
const reviewServingArticleListModeStateTable = 'mart.review_article_serving_list_mode_state_v4'
const reviewServingArticleDirectBaseAlias = 'serving'
const reviewServingArticleDirectStateAlias = 'list_mode_state'
const reviewServingArticlePostingSortAlias = 'serving_order'
const reviewServingUnassessedQueueArticleRankTable = 'mart.review_unassessed_queue_article_rank_serving_v4'
const reviewServingUnassessedQueueAlias = 'queue'
const reviewServingUnassessedQueueCandidateAlias = 'unassessed_queue_candidate'
const reviewServingUnassessedQueuePageAlias = 'unassessed_queue_page'
const reviewServingQueueArticleFilterAlias = 'queue_article'
const reviewServingSelectedImportTable = 'mart.review_selected_article_import_current_v4'
const reviewServingFilterPostingTable = 'mart.review_article_filter_posting_serving_v4'
const reviewServingFilterPostingArticleAlias = 'filter_posting_article'
const reviewServingFilterFacetTable = 'mart.review_filter_facet_serving_v4'
const reviewServingFilterOptionTable = 'mart.review_filter_option_serving_v4'
const reviewServingJudgmentDetailTable = 'mart.review_article_judgment_detail_serving_v4'
const reviewServingTitleSearchTable = 'mart.review_title_search_serving_v4'
const reviewServingListModePrioritySql =
  "CASE list_mode_key WHEN 'both' THEN 0 WHEN 'llm' THEN 1 WHEN 'human' THEN 2 WHEN 'unassessed' THEN 3 ELSE 4 END"
const reviewServingJudgmentDetailListModePrioritySql = `CASE ${reviewServingJudgmentDetailTable}.payload_kind WHEN 'llm' THEN 1 WHEN 'human' THEN 2 ELSE 4 END`
const reviewServingListModePriorityAlias = 'list_mode_priority'
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
  `NULL AS judgment_model_id`,
  `NULL AS explanation`,
  `NULL AS quotes`,
]
const reviewServingJudgmentDetailFullColumnContractKeys = new Set<ReviewServingReadContract['key']>([
  'review.detail.judgments',
  'review.detail.humanJudgments',
])

const getReviewServingJudgmentDetailSelectColumns = (contract: ReviewServingReadContract) => {
  const listModeColumn =
    contract.listMode === 'both'
      ? "'both' AS list_mode_key"
      : `CASE ${reviewServingJudgmentDetailTable}.payload_kind WHEN 'llm' THEN 'llm' WHEN 'human' THEN 'human' ELSE ${reviewServingJudgmentDetailTable}.payload_kind END AS list_mode_key`
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
  if (!reviewServingJudgmentDetailFullColumnContractKeys.has(params.contract.key)) {
    return ''
  }

  const llmJudgmentJoin = [
    ` LEFT JOIN app."judgment" llm_judgment`,
    ` ON ${reviewServingJudgmentDetailTable}.payload_kind = 'llm'`,
    ` AND llm_judgment.id = ${reviewServingJudgmentDetailTable}.judgment_id`,
    ` AND llm_judgment.article_id = ${reviewServingJudgmentDetailTable}.article_id`,
    ` AND llm_judgment.prompt_id = ${reviewServingJudgmentDetailTable}.prompt_id`,
    ` AND llm_judgment.deleted_at IS NULL`,
  ].join('')

  return [
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
  const reviewConfigHashColumn = shouldUseDirectReviewArticleServingRead(params.contract)
    ? `${reviewServingArticleDirectBaseAlias}.review_config_hash`
    : params.contract.servingTable === reviewServingJudgmentDetailTable
      ? `${reviewServingJudgmentDetailTable}.review_config_hash`
      : params.contract.servingTable === reviewServingFilterPostingTable
        ? `${reviewServingFilterPostingTable}.review_config_hash`
        : 'review_config_hash'

  return params.contract.servingTable === reviewServingTitleSearchTable
    ? ` AND search_identity = ${params.searchIdentityParameter} AND project_scope_identity = ${params.projectScopeIdentityParameter} AND snapshot_id = ${params.snapshotIdParameter}`
    : ` AND ${reviewConfigHashColumn} = ${params.reviewConfigHashParameter} AND ${snapshotIdColumn} = ${params.snapshotIdParameter}`
}

const getReviewServingSearchFilteredArticleIdsPredicate = (articleIdSql: string) => {
  return `(NOT EXISTS (SELECT 1 FROM search_prefixes) OR EXISTS (SELECT 1 FROM search_filtered_article_ids WHERE search_filtered_article_ids.article_id = ${articleIdSql}))`
}

const getReviewServingRowsSqlSearchArticleCtes = (params: {
  contract: ReviewServingReadContract
  filterKindParameter?: string | null
  filterValueParameter?: string | null
  listModeParameter: string
  projectIdParameter: string
  projectScopeIdentityParameter: string
  queueKindParameter?: string | null
  reviewConfigHashParameter: string
  searchIdentityParameter: string
  searchTokenPrefixParameter?: string | null
  searchTokenPrefixesParameter?: string | null
  useSearchCandidateArticleIds?: boolean
  snapshotIdParameter: string
}) => {
  const searchPrefixesSql = params.searchTokenPrefixesParameter
    ? `search_prefixes AS (SELECT DISTINCT token_prefix FROM (SELECT unnest(${params.searchTokenPrefixesParameter}) AS token_prefix) WHERE token_prefix IS NOT NULL AND token_prefix <> '')`
    : params.searchTokenPrefixParameter
      ? `search_prefixes AS (SELECT ${params.searchTokenPrefixParameter} AS token_prefix)`
      : ''

  if (
    !searchPrefixesSql
    || !['postingIntersection', 'queueOrdering'].includes(params.contract.physicalAccessStrategy)
  ) {
    return []
  }

  const getSearchCandidateArticleIdsCte = () => {
    if (params.useSearchCandidateArticleIds) {
      return ''
    }

    if (params.contract.physicalAccessStrategy === 'postingIntersection') {
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

      return [
        'search_candidate_article_ids AS (SELECT DISTINCT search_candidate_article.article_id',
        ` FROM ${reviewServingFilterPostingTable} search_candidate_posting`,
        ' CROSS JOIN UNNEST(search_candidate_posting.article_ids) AS search_candidate_article(article_id)',
        ` WHERE search_candidate_posting.project_id = ${params.projectIdParameter}`,
        ` AND search_candidate_posting.review_config_hash = ${params.reviewConfigHashParameter}`,
        ` AND search_candidate_posting.snapshot_id = ${params.snapshotIdParameter}`,
        ` AND search_candidate_posting.list_mode_key = ${params.listModeParameter}`,
        ` AND search_candidate_posting.filter_kind = ${filterKindParameter}`,
        ` AND search_candidate_posting.filter_value = ${filterValueParameter})`,
      ].join('')
    }

    if (params.contract.physicalAccessStrategy === 'queueOrdering') {
      const queueKindParameter = getRequiredReviewServingRowsSqlParameter(
        params.queueKindParameter,
        'queue kind',
        params.contract,
      )

      return [
        'search_candidate_article_ids AS (SELECT DISTINCT search_candidate_queue.article_id',
        ` FROM ${params.contract.servingTable} search_candidate_queue`,
        ` WHERE search_candidate_queue.project_id = ${params.projectIdParameter}`,
        ` AND search_candidate_queue.review_config_hash = ${params.reviewConfigHashParameter}`,
        ` AND search_candidate_queue.snapshot_id = ${params.snapshotIdParameter}`,
        ` AND search_candidate_queue.queue_kind = ${queueKindParameter})`,
      ].join('')
    }

    return ''
  }
  const searchCandidateArticleIdsCte = getSearchCandidateArticleIdsCte()
  const hasSearchCandidateArticleIds = Boolean(params.useSearchCandidateArticleIds || searchCandidateArticleIdsCte)
  const expandedSearchArticleIdsCte = hasSearchCandidateArticleIds
    ? [
        'expanded_search_article_ids AS (SELECT DISTINCT search_prefix.token_prefix, search_candidate_article.article_id AS article_id',
        ' FROM search_candidate_article_ids search_candidate_article',
        ` JOIN ${reviewServingTitleSearchTable} search`,
        ' ON list_contains(search.article_ids, search_candidate_article.article_id)',
        ' JOIN search_prefixes search_prefix',
        ' ON starts_with(search.token, search_prefix.token_prefix)',
        ` WHERE search.project_id = ${params.projectIdParameter}`,
        ` AND search.search_identity = ${params.searchIdentityParameter}`,
        ` AND search.project_scope_identity = ${params.projectScopeIdentityParameter}`,
        ` AND search.snapshot_id = ${params.snapshotIdParameter}`,
        ')',
      ].join('')
    : [
        'expanded_search_article_ids AS (SELECT DISTINCT search_prefix.token_prefix, search_article.article_id AS article_id',
        ` FROM ${reviewServingTitleSearchTable} search`,
        ' JOIN search_prefixes search_prefix',
        ' ON starts_with(search.token, search_prefix.token_prefix)',
        ' CROSS JOIN UNNEST(search.article_ids) AS search_article(article_id)',
        ` WHERE search.project_id = ${params.projectIdParameter}`,
        ` AND search.search_identity = ${params.searchIdentityParameter}`,
        ` AND search.project_scope_identity = ${params.projectScopeIdentityParameter}`,
        ` AND search.snapshot_id = ${params.snapshotIdParameter}`,
        ')',
      ].join('')

  return [
    searchPrefixesSql,
    searchCandidateArticleIdsCte,
    expandedSearchArticleIdsCte,
    [
      'search_filtered_article_ids AS (SELECT DISTINCT expanded_search_article_ids.article_id',
      ' FROM expanded_search_article_ids',
      ' WHERE NOT EXISTS (SELECT 1 FROM search_prefixes required_search_prefix',
      ' WHERE NOT EXISTS (SELECT 1 FROM expanded_search_article_ids matched_search_article',
      ' WHERE matched_search_article.article_id = expanded_search_article_ids.article_id',
      ' AND matched_search_article.token_prefix = required_search_prefix.token_prefix)))',
    ].join(''),
  ].filter((cte) => {
    return cte.length > 0
  })
}

const getReviewServingFilterPostingArticleIdSql = () => {
  return `${reviewServingFilterPostingArticleAlias}.article_id`
}

const reviewServingListModePredicateTables = new Set([
  'mart.review_article_filter_posting_serving_v4',
  reviewServingArticleBaseTable,
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

const reviewServingListModeMembershipColumns: Record<ReviewServingListMode, string> = {
  both: 'has_both_list_mode',
  human: 'has_human_list_mode',
  llm: 'has_llm_list_mode',
  unassessed: 'has_unassessed_list_mode',
}

const getReviewServingDirectListModeExpansionSql = (stateAlias: string) => {
  return [
    ' CROSS JOIN (VALUES',
    ` ('both', ${stateAlias}.has_both_list_mode),`,
    ` ('llm', ${stateAlias}.has_llm_list_mode),`,
    ` ('human', ${stateAlias}.has_human_list_mode),`,
    ` ('unassessed', ${stateAlias}.has_unassessed_list_mode)`,
    ') AS list_mode(list_mode_key, has_list_mode)',
  ].join('')
}

const getReviewServingRowsSqlListModePredicate = (params: {
  contract: ReviewServingReadContract
  listModeParameter: string
}) => {
  if (!reviewServingListModePredicateTables.has(params.contract.servingTable)) {
    return ''
  }

  if (shouldUseDirectReviewArticleServingRead(params.contract) && params.contract.listMode) {
    return ` AND ${reviewServingArticleDirectStateAlias}.${reviewServingListModeMembershipColumns[params.contract.listMode]} IS TRUE`
  }

  if (shouldUseDirectReviewArticleServingRead(params.contract)) {
    return ' AND list_mode.has_list_mode IS TRUE'
  }

  const listModeColumn =
    params.contract.servingTable === reviewServingFilterPostingTable
      ? `${reviewServingFilterPostingTable}.list_mode_key`
      : 'list_mode_key'

  if (params.contract.listMode) {
    return ` AND ${listModeColumn} = ${getSqlStringLiteral(params.contract.listMode)}`
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

const getSqlStringLiteralArray = (values: readonly string[]) => {
  return `[${values.map(getSqlStringLiteral).join(', ')}]::VARCHAR[]`
}

const getPostingFilterIntersectionGroupPredicate = (input: {
  alias: string
  group: ReviewServingPostingFilterIntersectionGroup
}) => {
  return `${input.alias}.filter_kind = ${getSqlStringLiteral(input.group.filterKind)} AND ${
    input.alias
  }.filter_value IN (SELECT unnest(${getSqlStringLiteralArray(input.group.filterValues)}))`
}

export const buildReviewServingPostingFilterIntersectionArticleCte = (input: {
  cteName?: string
  groups: readonly ReviewServingPostingFilterIntersectionGroup[]
  listModeSql: string
  projectIdSql: string
  reviewConfigHashSql: string
  snapshotIdSql: string
  tableSql?: string
}) => {
  const groups = input.groups.filter((group) => {
    return group.filterValues.length > 0
  })

  if (groups.length === 0) {
    return ''
  }

  const cteName = input.cteName ?? 'posting_filtered_article_ids'
  const tableSql = input.tableSql ?? reviewServingFilterPostingTable
  const groupPredicates = groups.map((group) => {
    return `(${getPostingFilterIntersectionGroupPredicate({alias: 'posting', group})})`
  })

  if (groups.length === 1) {
    return [
      `${cteName} AS (SELECT DISTINCT posting_article.article_id`,
      ' FROM (',
      ' SELECT posting.article_ids',
      ` FROM ${tableSql} posting`,
      ` WHERE posting.project_id = ${input.projectIdSql}`,
      ` AND posting.snapshot_id = ${input.snapshotIdSql}`,
      ` AND posting.review_config_hash = ${input.reviewConfigHashSql}`,
      ` AND posting.list_mode_key = ${input.listModeSql}`,
      ` AND (${groupPredicates.join(' OR ')})`,
      ' ) posting',
      ' CROSS JOIN UNNEST(posting.article_ids) AS posting_article(article_id))',
    ].join('')
  }

  const matchedGroupCases = groups.map((group, index) => {
    return `WHEN ${getPostingFilterIntersectionGroupPredicate({alias: 'posting', group})} THEN ${index}`
  })
  const requiredGroupRows = groups.map((_group, index) => {
    return `(${index})`
  })

  return [
    'matched_posting_rows AS (SELECT posting.article_ids, posting.filter_kind, posting.filter_value,',
    ` CASE ${matchedGroupCases.join(' ')} END AS matched_group_index,`,
    ` SUM(array_length(posting.article_ids)) OVER (PARTITION BY CASE ${matchedGroupCases.join(
      ' ',
    )} END) AS matched_group_article_id_count`,
    ` FROM ${tableSql} posting`,
    ` WHERE posting.project_id = ${input.projectIdSql}`,
    ` AND posting.snapshot_id = ${input.snapshotIdSql}`,
    ` AND posting.review_config_hash = ${input.reviewConfigHashSql}`,
    ` AND posting.list_mode_key = ${input.listModeSql}`,
    ` AND (${groupPredicates.join(' OR ')}))`,
    `, posting_anchor_rows AS (SELECT anchor.article_ids, anchor.matched_group_index`,
    ' FROM matched_posting_rows anchor',
    ' WHERE NOT EXISTS (SELECT 1',
    ' FROM matched_posting_rows smaller_anchor_group',
    ' WHERE smaller_anchor_group.matched_group_article_id_count < anchor.matched_group_article_id_count',
    ' OR (smaller_anchor_group.matched_group_article_id_count = anchor.matched_group_article_id_count',
    ' AND smaller_anchor_group.matched_group_index < anchor.matched_group_index)))',
    ', posting_anchor_group AS (SELECT DISTINCT matched_group_index FROM posting_anchor_rows)',
    ', posting_candidate_article_groups AS (SELECT DISTINCT candidate_article.article_id, candidate.matched_group_index',
    ' FROM matched_posting_rows candidate',
    ' CROSS JOIN posting_anchor_group anchor_group',
    ' CROSS JOIN UNNEST(candidate.article_ids) AS candidate_article(article_id)',
    ' WHERE candidate.matched_group_index <> anchor_group.matched_group_index)',
    `, ${cteName} AS (SELECT DISTINCT anchor_article.article_id`,
    ' FROM posting_anchor_rows anchor',
    ' CROSS JOIN UNNEST(anchor.article_ids) AS anchor_article(article_id)',
    ' WHERE NOT EXISTS (SELECT 1',
    ` FROM (VALUES ${requiredGroupRows.join(', ')}) AS required_posting_group(required_group_index)`,
    ' WHERE required_posting_group.required_group_index <> anchor.matched_group_index',
    ' AND NOT EXISTS (SELECT 1',
    ' FROM posting_candidate_article_groups candidate',
    ' WHERE candidate.matched_group_index = required_posting_group.required_group_index',
    ' AND candidate.article_id = anchor_article.article_id)))',
  ].join('')
}

export const shouldUseDirectReviewArticleServingRead = (contract: ReviewServingReadContract) => {
  return contract.servingTable === reviewServingArticleBaseTable
}

const shouldUseQueueAnchoredUnassessedRowsRead = (contract: ReviewServingReadContract) => {
  return contract.key === 'review.unassessed.rows'
}

const qualifyUnassessedQueueSortSql = (sortSql: string, alias: string) => {
  return sortSql
    .replace(/\bactivity_sort_at\b/gu, `${alias}.activity_sort_at`)
    .replace(/\barticle_id\b/gu, `${alias}.article_id`)
}

export const getReviewServingArticleReadSqlAlias = (contract: ReviewServingReadContract) => {
  return shouldUseDirectReviewArticleServingRead(contract)
    ? reviewServingArticleDirectBaseAlias
    : reviewServingArticleBaseTable
}

export const getReviewServingArticleFilterStateSqlAlias = (contract: ReviewServingReadContract) => {
  return shouldUseDirectReviewArticleServingRead(contract)
    ? reviewServingArticleDirectStateAlias
    : reviewServingArticleBaseTable
}

const getReviewServingArticlePatchWatermarkSql = (listMode: string) => {
  return `${reviewServingArticleDirectStateAlias}.${listMode}_patch_watermark`
}

const getReviewServingExpandedArticlePatchWatermarkSql = () => {
  return [
    'CASE list_mode.list_mode_key',
    ` WHEN 'llm' THEN ${reviewServingArticleDirectStateAlias}.llm_patch_watermark`,
    ` WHEN 'human' THEN ${reviewServingArticleDirectStateAlias}.human_patch_watermark`,
    ` WHEN 'both' THEN ${reviewServingArticleDirectStateAlias}.both_patch_watermark`,
    ` WHEN 'unassessed' THEN ${reviewServingArticleDirectStateAlias}.unassessed_patch_watermark`,
    ' ELSE NULL END',
  ].join('')
}

const getReviewServingArticlePhysicalSelectColumns = (contract: ReviewServingReadContract) => {
  if (!shouldUseDirectReviewArticleServingRead(contract)) {
    return [
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
      return `${reviewServingArticleBaseTable}.${column}`
    })
  }

  const patchWatermarkSql = contract.listMode
    ? getReviewServingArticlePatchWatermarkSql(contract.listMode)
    : getReviewServingExpandedArticlePatchWatermarkSql()
  const listModeKeySql = contract.listMode ? getSqlStringLiteral(contract.listMode) : 'list_mode.list_mode_key'

  return [
    `${reviewServingArticleDirectBaseAlias}.project_id`,
    `${reviewServingArticleDirectBaseAlias}.review_config_hash`,
    `${reviewServingArticleDirectBaseAlias}.snapshot_id`,
    `${reviewServingArticleDirectBaseAlias}.base_generation`,
    `${patchWatermarkSql} AS patch_watermark`,
    `${listModeKeySql} AS list_mode_key`,
    `${reviewServingArticleDirectBaseAlias}.article_id`,
    `${reviewServingArticleDirectBaseAlias}.article_created_at`,
    `${reviewServingArticleDirectBaseAlias}.sort_key`,
    shouldUseQueueAnchoredUnassessedRowsRead(contract)
      ? `${reviewServingUnassessedQueuePageAlias}.activity_sort_at AS activity_sort_at`
      : `${reviewServingArticleDirectBaseAlias}.activity_sort_at`,
  ]
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
  if (shouldUseDirectReviewArticleServingRead(params.contract)) {
    return `${reviewServingArticleDirectBaseAlias}.${params.field}`
  }

  return `${params.contract.servingTable}.${params.field}`
}

const getReviewServingRowsSqlArticlePredicate = (params: {
  articleIdParameter?: string | null
  articleIdsParameter?: string | null
  contract: ReviewServingReadContract
}) => {
  const tableAlias =
    params.contract.servingTable === reviewServingArticleBaseTable
      ? getReviewServingArticleReadSqlAlias(params.contract)
      : params.contract.servingTable

  if (!params.contract.allowedFilters.includes('articleId')) {
    return ''
  }

  if (params.contract.physicalAccessStrategy === 'articleSetLookup') {
    const articleIdsParameter = getRequiredReviewServingRowsSqlParameter(
      params.articleIdsParameter,
      'article ids',
      params.contract,
    )

    return ` AND ${tableAlias}.article_id IN (SELECT unnest(${articleIdsParameter}))`
  }

  if (params.contract.physicalAccessStrategy !== 'keyedLookup') {
    return ''
  }

  const articleIdParameter = getRequiredReviewServingRowsSqlParameter(
    params.articleIdParameter,
    'article id',
    params.contract,
  )

  return ` AND ${tableAlias}.article_id = ${articleIdParameter}`
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
  searchTokenPrefixesParameter?: string | null
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
  const searchPredicate =
    params.searchTokenPrefixParameter || params.searchTokenPrefixesParameter
      ? ` AND ${getReviewServingSearchFilteredArticleIdsPredicate(getReviewServingFilterPostingArticleIdSql())}`
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
    ? ` AND ${getReviewServingSearchFilteredArticleIdsPredicate(`${params.contract.servingTable}.article_id`)}`
    : ''

  return ` AND queue_kind = ${queueKindParameter}${searchPredicate}`
}

const getReviewServingRowsSqlUnassessedQueuePredicate = (params: {
  contract: ReviewServingReadContract
  projectIdParameter: string
  reviewConfigHashParameter: string
  snapshotIdParameter: string
}) => {
  return params.contract.key === 'review.unassessed.rows' && !shouldUseQueueAnchoredUnassessedRowsRead(params.contract)
    ? [
        ` AND EXISTS (SELECT 1 FROM ${reviewServingUnassessedQueueArticleRankTable} ${reviewServingUnassessedQueueAlias}`,
        ` WHERE queue.project_id = ${params.projectIdParameter}`,
        ` AND queue.review_config_hash = ${params.reviewConfigHashParameter}`,
        ` AND queue.snapshot_id = ${params.snapshotIdParameter}`,
        " AND queue.queue_kind = 'unassessed'",
        ` AND queue.article_id = ${getReviewServingArticleReadSqlAlias(params.contract)}.article_id)`,
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
    return ` QUALIFY ${reviewServingListModePrioritySql} = min(${reviewServingListModePrioritySql}) OVER (PARTITION BY ${getReviewServingArticleReadSqlAlias(contract)}.article_id)`
  }

  return ''
}

const getReviewServingRowsSqlSelect = (contract: ReviewServingReadContract) => {
  if (contract.servingTable === reviewServingArticleBaseTable) {
    const articleSelectColumns = [
      ...getReviewServingArticlePhysicalSelectColumns(contract),
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
    return [
      `SELECT ${reviewServingFilterPostingTable}.project_id`,
      `${reviewServingFilterPostingTable}.review_config_hash`,
      `${reviewServingFilterPostingTable}.snapshot_id`,
      `${reviewServingFilterPostingTable}.filter_kind`,
      `${reviewServingFilterPostingTable}.filter_value`,
      `${reviewServingFilterPostingTable}.list_mode_key`,
      `${getReviewServingFilterPostingArticleIdSql()} AS article_id`,
      `${reviewServingArticlePostingSortAlias}.sort_key AS sort_key`,
    ].join(', ')
  }

  if (contract.servingTable === reviewServingTitleSearchTable) {
    return `SELECT ${reviewServingTitleSearchTable}.project_id, ${reviewServingTitleSearchTable}.search_identity, ${reviewServingTitleSearchTable}.project_scope_identity, ${reviewServingTitleSearchTable}.snapshot_id, ${reviewServingTitleSearchTable}.token, unnest(${reviewServingTitleSearchTable}.article_ids) AS article_id`
  }

  if (contract.servingTable === reviewServingFilterFacetTable) {
    return [
      `SELECT ${reviewServingFilterFacetTable}.project_id`,
      `${reviewServingFilterFacetTable}.review_config_hash`,
      `${reviewServingFilterFacetTable}.snapshot_id`,
      `${reviewServingFilterFacetTable}.summary_identity`,
      `${reviewServingFilterFacetTable}.facet_kind`,
      `${reviewServingFilterFacetTable}.facet_key`,
      `${reviewServingFilterFacetTable}.facet_value`,
      `${reviewServingFilterFacetTable}.prompt_id`,
      `${reviewServingFilterFacetTable}.answer_id`,
      `${reviewServingFilterFacetTable}.answer_value`,
      `${reviewServingFilterFacetTable}.summary_definition_version`,
      `CASE WHEN ${reviewServingFilterFacetTable}.availability = 'ready' THEN ${reviewServingFilterFacetTable}.count_value ELSE NULL END AS count_value`,
      `${reviewServingFilterFacetTable}.availability`,
    ].join(', ')
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
  useSearchCandidateArticleIds?: boolean
  withCtesSql?: string | null
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
  useSearchCandidateArticleIds?: boolean
}) => {
  const articleServingSqlAlias = getReviewServingArticleReadSqlAlias(params.contract)
  const selectedImportSnapshotIdParameter =
    params.contract.servingTable === reviewServingArticleBaseTable
      ? (params.selectedImportSnapshotIdParameter ?? '$selectedImportSnapshotId')
      : null
  const articleHydrationJoin =
    params.contract.servingTable === reviewServingArticleBaseTable
      ? [
          ` LEFT JOIN ${reviewServingSelectedImportTable} selected_import`,
          ` ON selected_import.project_id = ${params.projectIdParameter}`,
          ` AND selected_import.project_id = ${articleServingSqlAlias}.project_id`,
          ` AND selected_import.project_scope_identity = ${params.projectScopeIdentityParameter}`,
          ` AND selected_import.selected_import_snapshot_id = ${selectedImportSnapshotIdParameter}`,
          ` AND selected_import.article_id = ${articleServingSqlAlias}.article_id`,
          ` AND NOT selected_import.tombstone`,
          ` LEFT JOIN app.article article`,
          ` ON article.id = ${articleServingSqlAlias}.article_id`,
          ` LEFT JOIN app.review_import_article_hot_field selected_hot`,
          ` ON selected_hot.import_route_id = selected_import.import_route_id`,
          ` AND selected_hot.article_id = ${articleServingSqlAlias}.article_id`,
          ` AND selected_hot.source_record_key = selected_import.source_record_key`,
          ` AND NOT selected_hot.tombstone`,
          ` LEFT JOIN app.article_import_route_source_record selected_source`,
          ` ON selected_source.import_route_id = selected_import.import_route_id`,
          ` AND selected_source.article_id = ${articleServingSqlAlias}.article_id`,
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
          ` CROSS JOIN UNNEST(${reviewServingFilterPostingTable}.article_ids) AS ${reviewServingFilterPostingArticleAlias}(article_id)`,
          ` INNER JOIN ${reviewServingArticleBaseTable} ${reviewServingArticlePostingSortAlias}`,
          ` ON ${reviewServingArticlePostingSortAlias}.project_id = ${params.projectIdParameter}`,
          ` AND ${reviewServingArticlePostingSortAlias}.project_id = ${reviewServingFilterPostingTable}.project_id`,
          ` AND ${reviewServingArticlePostingSortAlias}.review_config_hash = ${params.reviewConfigHashParameter}`,
          ` AND ${reviewServingArticlePostingSortAlias}.review_config_hash = ${reviewServingFilterPostingTable}.review_config_hash`,
          ` AND ${reviewServingArticlePostingSortAlias}.snapshot_id = ${params.snapshotIdParameter}`,
          ` AND ${reviewServingArticlePostingSortAlias}.snapshot_id = ${reviewServingFilterPostingTable}.snapshot_id`,
          ` AND ${reviewServingArticlePostingSortAlias}.article_id = ${getReviewServingFilterPostingArticleIdSql()}`,
        ].join('')
      : ''
  const postingArticleSortScopePredicate =
    params.contract.servingTable === reviewServingFilterPostingTable
      ? [
          ` AND ${reviewServingArticlePostingSortAlias}.project_id = ${params.projectIdParameter}`,
          ` AND ${reviewServingArticlePostingSortAlias}.snapshot_id = ${params.snapshotIdParameter}`,
        ].join('')
      : ''
  const queueArticleFilterJoin =
    params.contract.physicalAccessStrategy === 'queueOrdering'
    && (params.filterPredicatesSql?.includes(`${reviewServingQueueArticleFilterAlias}.`) ?? false)
      ? [
          ` INNER JOIN ${reviewServingArticleBaseTable} ${reviewServingQueueArticleFilterAlias}`,
          ` ON ${reviewServingQueueArticleFilterAlias}.project_id = ${params.projectIdParameter}`,
          ` AND ${reviewServingQueueArticleFilterAlias}.project_id = ${params.contract.servingTable}.project_id`,
          ` AND ${reviewServingQueueArticleFilterAlias}.review_config_hash = ${params.reviewConfigHashParameter}`,
          ` AND ${reviewServingQueueArticleFilterAlias}.review_config_hash = ${params.contract.servingTable}.review_config_hash`,
          ` AND ${reviewServingQueueArticleFilterAlias}.snapshot_id = ${params.snapshotIdParameter}`,
          ` AND ${reviewServingQueueArticleFilterAlias}.snapshot_id = ${params.contract.servingTable}.snapshot_id`,
          ` AND ${reviewServingQueueArticleFilterAlias}.article_id = ${params.contract.servingTable}.article_id`,
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
  const baseSortSql =
    params.contract.servingTable === reviewServingFilterPostingTable
      ? getSortSql(params.contract).replaceAll(
          `${reviewServingArticleBaseTable}.`,
          `${reviewServingArticlePostingSortAlias}.`,
        )
      : shouldUseDirectReviewArticleServingRead(params.contract)
        ? getSortSql(params.contract).replaceAll(
            `${reviewServingArticleBaseTable}.`,
            `${reviewServingArticleDirectBaseAlias}.`,
          )
        : getSortSql(params.contract)
  const sortSql = shouldUseQueueAnchoredUnassessedRowsRead(params.contract)
    ? qualifyUnassessedQueueSortSql(baseSortSql, reviewServingUnassessedQueuePageAlias)
    : baseSortSql

  const projectIdColumn = getReviewServingRowsSqlScopeColumn({contract: params.contract, field: 'project_id'})
  const ctes: string[] = []
  const withCtesSql: unknown = params.withCtesSql

  if (typeof withCtesSql === 'string' && withCtesSql.length > 0) {
    ctes.push(withCtesSql)
  }

  ctes.push(...getReviewServingRowsSqlSearchArticleCtes(params))

  const sourceSql = shouldUseDirectReviewArticleServingRead(params.contract)
    ? shouldUseQueueAnchoredUnassessedRowsRead(params.contract)
      ? [
          `${reviewServingUnassessedQueuePageAlias}`,
          ` INNER JOIN ${reviewServingArticleBaseTable} ${reviewServingArticleDirectBaseAlias}`,
          ` ON ${reviewServingArticleDirectBaseAlias}.project_id = ${params.projectIdParameter}`,
          ` AND ${reviewServingArticleDirectBaseAlias}.project_id = ${reviewServingUnassessedQueuePageAlias}.project_id`,
          ` AND ${reviewServingArticleDirectBaseAlias}.review_config_hash = ${params.reviewConfigHashParameter}`,
          ` AND ${reviewServingArticleDirectBaseAlias}.review_config_hash = ${reviewServingUnassessedQueuePageAlias}.review_config_hash`,
          ` AND ${reviewServingArticleDirectBaseAlias}.snapshot_id = ${params.snapshotIdParameter}`,
          ` AND ${reviewServingArticleDirectBaseAlias}.snapshot_id = ${reviewServingUnassessedQueuePageAlias}.snapshot_id`,
          ` AND ${reviewServingArticleDirectBaseAlias}.article_id = ${reviewServingUnassessedQueuePageAlias}.article_id`,
          ` INNER JOIN ${reviewServingArticleListModeStateTable} ${reviewServingArticleDirectStateAlias}`,
          ` ON ${reviewServingArticleDirectStateAlias}.project_id = ${reviewServingArticleDirectBaseAlias}.project_id`,
          ` AND ${reviewServingArticleDirectStateAlias}.project_id = ${params.projectIdParameter}`,
          ` AND ${reviewServingArticleDirectStateAlias}.review_config_hash = ${reviewServingArticleDirectBaseAlias}.review_config_hash`,
          ` AND ${reviewServingArticleDirectStateAlias}.review_config_hash = ${params.reviewConfigHashParameter}`,
          ` AND ${reviewServingArticleDirectStateAlias}.snapshot_id = ${reviewServingArticleDirectBaseAlias}.snapshot_id`,
          ` AND ${reviewServingArticleDirectStateAlias}.snapshot_id = ${params.snapshotIdParameter}`,
          ` AND ${reviewServingArticleDirectStateAlias}.article_id = ${reviewServingArticleDirectBaseAlias}.article_id`,
        ].join('')
      : [
          `${reviewServingArticleBaseTable} ${reviewServingArticleDirectBaseAlias}`,
          ` INNER JOIN ${reviewServingArticleListModeStateTable} ${reviewServingArticleDirectStateAlias}`,
          ` ON ${reviewServingArticleDirectStateAlias}.project_id = ${reviewServingArticleDirectBaseAlias}.project_id`,
          ` AND ${reviewServingArticleDirectStateAlias}.project_id = ${params.projectIdParameter}`,
          ` AND ${reviewServingArticleDirectStateAlias}.review_config_hash = ${reviewServingArticleDirectBaseAlias}.review_config_hash`,
          ` AND ${reviewServingArticleDirectStateAlias}.review_config_hash = ${params.reviewConfigHashParameter}`,
          ` AND ${reviewServingArticleDirectStateAlias}.snapshot_id = ${reviewServingArticleDirectBaseAlias}.snapshot_id`,
          ` AND ${reviewServingArticleDirectStateAlias}.snapshot_id = ${params.snapshotIdParameter}`,
          ` AND ${reviewServingArticleDirectStateAlias}.article_id = ${reviewServingArticleDirectBaseAlias}.article_id`,
          params.contract.listMode
            ? ''
            : getReviewServingDirectListModeExpansionSql(reviewServingArticleDirectStateAlias),
        ].join('')
    : params.contract.servingTable

  if (shouldUseQueueAnchoredUnassessedRowsRead(params.contract)) {
    const queueCursorPredicate = cursorPredicate
      .replaceAll(
        `${reviewServingArticleDirectBaseAlias}.activity_sort_at`,
        `${reviewServingUnassessedQueueCandidateAlias}.activity_sort_at`,
      )
      .replaceAll(
        `${reviewServingArticleDirectBaseAlias}.article_id`,
        `${reviewServingUnassessedQueueCandidateAlias}.article_id`,
      )
    const queueCandidateSortSql = qualifyUnassessedQueueSortSql(baseSortSql, reviewServingUnassessedQueueCandidateAlias)
    const queueCandidateSql = [
      `${reviewServingUnassessedQueueCandidateAlias} AS (SELECT`,
      ` ${reviewServingUnassessedQueueAlias}.project_id,`,
      ` ${reviewServingUnassessedQueueAlias}.review_config_hash,`,
      ` ${reviewServingUnassessedQueueAlias}.snapshot_id,`,
      ` ${reviewServingUnassessedQueueAlias}.article_id,`,
      ` ${reviewServingUnassessedQueueAlias}.activity_sort_at`,
      ` FROM ${reviewServingUnassessedQueueArticleRankTable} ${reviewServingUnassessedQueueAlias}`,
      ` INNER JOIN ${reviewServingArticleBaseTable} ${reviewServingArticleDirectBaseAlias}`,
      ` ON ${reviewServingArticleDirectBaseAlias}.project_id = ${params.projectIdParameter}`,
      ` AND ${reviewServingArticleDirectBaseAlias}.project_id = ${reviewServingUnassessedQueueAlias}.project_id`,
      ` AND ${reviewServingArticleDirectBaseAlias}.review_config_hash = ${params.reviewConfigHashParameter}`,
      ` AND ${reviewServingArticleDirectBaseAlias}.review_config_hash = ${reviewServingUnassessedQueueAlias}.review_config_hash`,
      ` AND ${reviewServingArticleDirectBaseAlias}.snapshot_id = ${params.snapshotIdParameter}`,
      ` AND ${reviewServingArticleDirectBaseAlias}.snapshot_id = ${reviewServingUnassessedQueueAlias}.snapshot_id`,
      ` AND ${reviewServingArticleDirectBaseAlias}.article_id = ${reviewServingUnassessedQueueAlias}.article_id`,
      ` INNER JOIN ${reviewServingArticleListModeStateTable} ${reviewServingArticleDirectStateAlias}`,
      ` ON ${reviewServingArticleDirectStateAlias}.project_id = ${reviewServingArticleDirectBaseAlias}.project_id`,
      ` AND ${reviewServingArticleDirectStateAlias}.project_id = ${params.projectIdParameter}`,
      ` AND ${reviewServingArticleDirectStateAlias}.review_config_hash = ${reviewServingArticleDirectBaseAlias}.review_config_hash`,
      ` AND ${reviewServingArticleDirectStateAlias}.review_config_hash = ${params.reviewConfigHashParameter}`,
      ` AND ${reviewServingArticleDirectStateAlias}.snapshot_id = ${reviewServingArticleDirectBaseAlias}.snapshot_id`,
      ` AND ${reviewServingArticleDirectStateAlias}.snapshot_id = ${params.snapshotIdParameter}`,
      ` AND ${reviewServingArticleDirectStateAlias}.article_id = ${reviewServingArticleDirectBaseAlias}.article_id`,
      ` WHERE ${reviewServingUnassessedQueueAlias}.project_id = ${params.projectIdParameter}`,
      ` AND ${reviewServingUnassessedQueueAlias}.review_config_hash = ${params.reviewConfigHashParameter}`,
      ` AND ${reviewServingUnassessedQueueAlias}.snapshot_id = ${params.snapshotIdParameter}`,
      ` AND ${reviewServingUnassessedQueueAlias}.queue_kind = 'unassessed'`,
      identityPredicates,
      listModePredicate,
      physicalFilterPredicate,
      `)`,
    ].join('')
    const queuePageSql = [
      `${reviewServingUnassessedQueuePageAlias} AS (SELECT`,
      ` ${reviewServingUnassessedQueueCandidateAlias}.project_id,`,
      ` ${reviewServingUnassessedQueueCandidateAlias}.review_config_hash,`,
      ` ${reviewServingUnassessedQueueCandidateAlias}.snapshot_id,`,
      ` ${reviewServingUnassessedQueueCandidateAlias}.article_id,`,
      ` ${reviewServingUnassessedQueueCandidateAlias}.activity_sort_at`,
      ` FROM ${reviewServingUnassessedQueueCandidateAlias}`,
      ' WHERE TRUE',
      queueCursorPredicate,
      ` ORDER BY ${queueCandidateSortSql} LIMIT ${params.limitParameter})`,
    ].join('')

    ctes.push(queueCandidateSql)
    ctes.push(queuePageSql)
  }
  const outerPhysicalFilterPredicate = shouldUseQueueAnchoredUnassessedRowsRead(params.contract)
    ? ''
    : physicalFilterPredicate
  const outerCursorPredicate = shouldUseQueueAnchoredUnassessedRowsRead(params.contract) ? '' : cursorPredicate
  const cteSql = ctes.length > 0 ? `WITH ${ctes.join(', ')}` : ''

  const rowsSql = [
    `${selectSql} FROM ${sourceSql}${articleHydrationJoin}${judgmentDetailHydrationJoin}${postingArticleSortJoin}${queueArticleFilterJoin} WHERE ${projectIdColumn} = ${params.projectIdParameter}`,
    identityPredicates,
    listModePredicate,
    judgmentPayloadKindPredicate,
    judgmentPlaceholderPredicate,
    countPredicate,
    facetVersionPredicate,
    outerPhysicalFilterPredicate,
    outerCursorPredicate,
    postingArticleSortScopePredicate,
    listModeDedupeQualifier,
    ` ORDER BY ${sortSql} LIMIT ${params.limitParameter}`,
  ].join('')

  return [cteSql, rowsSql].filter(Boolean).join(' ')
}
