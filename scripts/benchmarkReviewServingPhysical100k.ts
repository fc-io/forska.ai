import {existsSync, readFileSync} from 'node:fs'
import {mkdir, unlink, writeFile} from 'node:fs/promises'
import {dirname, join, resolve} from 'node:path'

import {DuckDBInstance} from '@duckdb/node-api'
import {Effect} from 'effect'

import {
  type ReviewServingBenchmarkExecutor,
  type ReviewServingBenchmarkObservation,
  reviewServingBenchmarkOverlapWorkloadDefinition,
  reviewServingBenchmarkPhase6PhysicalRehearsal100kFixture,
  type ReviewServingBenchmarkReleaseContext,
  type ReviewServingBenchmarkRunInput,
  type ReviewServingBenchmarkWorkItem,
  type ReviewServingBenchmarkWorkloadDefinition,
  type ReviewServingBenchmarkWorkloadOperation,
  runReviewServingBenchmarkEffect,
  sampleReviewServingBenchmarkMemoryRssBytes,
} from '../src/server/reviewServing/reviewServingBenchmark.ts'
import {
  namedReviewFastCountDefinitions,
  type NamedReviewFastCountKey,
  type ReviewServingListMode,
  reviewServingListModes,
  type ReviewServingProjectionComponent,
  type ReviewServingSnapshotComponentStates,
} from '../src/server/reviewServing/reviewServingContracts.ts'
import {type ReviewServingManifestRepositoryDatabase} from '../src/server/reviewServing/reviewServingManifestRepository.ts'
import {getReviewServingReadContract} from '../src/server/reviewServing/reviewServingReadContracts.ts'
import {
  readReviewServingRows,
  type ReviewServingReaderDatabase,
  type ReviewServingReaderRequest,
} from '../src/server/reviewServing/reviewServingReader.ts'
import type {DuckdbWorkloadContext} from '../src/server/utils/duckdbService.ts'
import {getConfiguredDuckdbPath} from '../src/server/utils/getDuckdbPath.ts'

export const reviewServingPhase6PhysicalRehearsal100kRunKind = 'phase6PhysicalRehearsal100k' as const

export type ReviewServingPhysical100kBenchmarkArgs = {
  duckdbMemoryLimit: string
  fixturePath: string
  outputDir: string
  projectId?: string
  reviewConfigHash?: string | null
}

export type ReviewServingPhysical100kFixtureDimensions = {
  articleCount: number
  articlePromptOverlapRows: number
  promptCount: number
}

export type ReviewServingPhysical100kFixtureVerification = {
  actual: ReviewServingPhysical100kFixtureDimensions
  expected: ReviewServingPhysical100kFixtureDimensions
  passed: boolean
}

export type ReviewServingPhysical100kFixtureSamples = {
  articleIds: readonly string[]
  filterOptionIdentity: string
  humanFacetSummaryIdentity: string
  postingFilter: {filterKind: string; filterValue: string; listMode: ReviewServingListMode}
  promptCounts: Record<NamedReviewFastCountKey, {filterKey: string; value: number}>
  queueKind: string
  reviewFacetSummaryIdentity: string
  searchTokenPrefix: string
}

export type ReviewServingPhysical100kSnapshotContext = {
  activeSnapshotIdentity: ReviewServingBenchmarkReleaseContext['activeSnapshotIdentity']
  projectId: string
  reviewConfigHash: string | null
  snapshotId: string
}

export type ReviewServingPhysical100kInput = ReviewServingBenchmarkRunInput & {
  readerRequestsByWorkItemKey: ReadonlyMap<string, ReviewServingReaderRequest>
}

export type ReviewServingPhysical100kSampleEvidence = {
  contractKey: string
  executableSql: string
  key: string
  latencyMs: number
  operationKey: string
  rowsScanned: number
  rowsReturned: number
  sql: string
  tempUsageBytes: number
}

const expectedFixtureDimensions = {
  articleCount: reviewServingBenchmarkPhase6PhysicalRehearsal100kFixture.articleCount,
  articlePromptOverlapRows: reviewServingBenchmarkPhase6PhysicalRehearsal100kFixture.articlePromptOverlapRows,
  promptCount: reviewServingBenchmarkPhase6PhysicalRehearsal100kFixture.promptCount,
} as const satisfies ReviewServingPhysical100kFixtureDimensions

const fixtureProjectId = 'phase6-physical-rehearsal-100k-project'
const fixtureSnapshotId = 'phase6-physical-rehearsal-100k-snapshot'
const fixtureReviewConfigHash = 'phase6-physical-rehearsal-100k-review-config'
const fixtureSelectedImportSnapshotId = 'phase6-physical-rehearsal-100k-selected-import'
const fixtureFilterOptionIdentity = 'phase6-physical-rehearsal-filter-options-v1'
const fixtureQueueKind = 'unassessed'
const fixtureComponents = [
  'display',
  'humanStatus',
  'judgmentInputContent',
  'llmStatus',
  'payload',
  'posting',
  'projectScope',
  'queue',
  'search',
  'selectedImport',
  'summary',
] as const satisfies readonly ReviewServingProjectionComponent[]
const fixtureComponentIdentities = fixtureComponents.reduce<Record<ReviewServingProjectionComponent, string>>(
  (identities, component) => {
    return {...identities, [component]: `phase6-physical-rehearsal-100k:${component}:v1`}
  },
  {} as Record<ReviewServingProjectionComponent, string>,
)

const promptScopedCountKeys = [
  'review.llm.assessedByPrompt',
  'review.human.reviewedByPrompt',
  'review.both.conflictByPrompt',
  'review.llm.unassessedByPrompt',
] as const satisfies readonly NamedReviewFastCountKey[]

const parseArgEntries = (argv: readonly string[]) => {
  return argv.reduce<Record<string, string>>((entries, argument) => {
    if (!argument.startsWith('--')) {
      return entries
    }

    const separatorIndex = argument.indexOf('=')
    const key = separatorIndex === -1 ? argument.slice(2) : argument.slice(2, separatorIndex)
    const value = separatorIndex === -1 ? '' : argument.slice(separatorIndex + 1)

    return {...entries, [key]: value}
  }, {})
}

const getRequiredArg = (entries: Record<string, string>, key: string) => {
  const value = entries[key]?.trim()

  if (!value) {
    throw new Error(`Missing --${key}=...`)
  }

  return value
}

const getOptionalNullableArg = (entries: Record<string, string>, key: string) => {
  const value = entries[key]

  if (value === undefined) {
    return undefined
  }

  return value.trim().toLowerCase() === 'null' ? null : value.trim()
}

export const parseReviewServingPhysical100kBenchmarkArgs = (
  argv: readonly string[] = process.argv.slice(2),
): ReviewServingPhysical100kBenchmarkArgs => {
  const entries = parseArgEntries(argv)

  return {
    duckdbMemoryLimit: entries['duckdb-memory-limit']?.trim() || process.env.DUCKDB_MEMORY_LIMIT?.trim() || '6400MiB',
    fixturePath: resolve(getRequiredArg(entries, 'fixture-path')),
    outputDir: resolve(getRequiredArg(entries, 'output-dir')),
    projectId: entries['project-id']?.trim() || undefined,
    reviewConfigHash: getOptionalNullableArg(entries, 'review-config-hash'),
  }
}

const runFixtureMigration = async (args: ReviewServingPhysical100kBenchmarkArgs) => {
  await mkdir(dirname(args.fixturePath), {recursive: true})
  const migrationProcess = globalThis.Bun.spawn(['bun', 'src/db/migrateDuckdb.ts'], {
    cwd: resolve(import.meta.dir, '..'),
    env: {
      ...process.env,
      API_SERVER_PORT: process.env.API_SERVER_PORT ?? '3002',
      DUCKDB_MEMORY_LIMIT: args.duckdbMemoryLimit,
      DUCKDB_PATH: args.fixturePath,
      SERVER_DUCKDB_OWNER_URL: '',
      SERVER_ROLE: 'maintenance-worker',
    },
    stderr: 'pipe',
    stdout: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(migrationProcess.stdout).text(),
    new Response(migrationProcess.stderr).text(),
    migrationProcess.exited,
  ])

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `DuckDB fixture migration failed with exit code ${exitCode}`)
  }
}

const getSqlStringLiteral = (value: string | null) => {
  return value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`
}

const getJsonSqlLiteral = (value: unknown) => {
  return `${getSqlStringLiteral(JSON.stringify(value))}::JSON`
}

const getFixtureComponentState = (): ReviewServingSnapshotComponentStates => {
  return {
    optional: [],
    required: fixtureComponents.map((component) => {
      return {
        baseGeneration: 1,
        component,
        patchWatermark: 0,
        projectionIdentity: fixtureComponentIdentities[component],
      }
    }),
  }
}

const getFixtureIdentity = () => {
  return {
    fixture: 'phase6-physical-rehearsal-100k',
    projectId: fixtureProjectId,
    reviewConfigHash: fixtureReviewConfigHash,
    snapshotId: fixtureSnapshotId,
  }
}

const getFixtureProjectionManifestValuesSql = () => {
  return fixtureComponents
    .map((component) => {
      return [
        getSqlStringLiteral(`phase6-physical-rehearsal-100k:${component}:manifest`),
        getSqlStringLiteral(fixtureProjectId),
        getSqlStringLiteral(component),
        getSqlStringLiteral(fixtureComponentIdentities[component]),
        '1',
        '0',
        '0',
        getJsonSqlLiteral({fixture: 'phase6-physical-rehearsal-100k', source: component, watermark: 100_000}),
        getSqlStringLiteral(`phase6-physical-rehearsal-100k:${component}:digest`),
        getSqlStringLiteral(`phase6-physical-rehearsal-100k:${component}:definition`),
        getSqlStringLiteral(fixtureReviewConfigHash),
        getSqlStringLiteral(`phase6-physical-rehearsal-100k:${component}:prompt-config`),
        getSqlStringLiteral('active'),
      ].join(', ')
    })
    .map((valueSql) => {
      return `(${valueSql})`
    })
    .join(',\n')
}

const getFixtureBulkJobValuesSql = () => {
  return reviewServingBenchmarkOverlapWorkloadDefinition.operations
    .filter((operation) => {
      return operation.contractKey !== 'review.search.substringAsync' && operation.jobFilterSignaturePrefix
    })
    .map((operation) => {
      const filterSignature = `${operation.jobFilterSignaturePrefix}${operation.key}`
      return [
        getSqlStringLiteral(`phase6-physical-rehearsal-100k:${operation.key}`),
        getSqlStringLiteral(operation.contractKey),
        getSqlStringLiteral(fixtureProjectId),
        getSqlStringLiteral(fixtureSnapshotId),
        getSqlStringLiteral(fixtureReviewConfigHash),
        getJsonSqlLiteral(getFixtureIdentity()),
        getSqlStringLiteral(filterSignature),
        getJsonSqlLiteral({filterSignature, operationKey: operation.key, rehearsal: true}),
        '1000',
        getSqlStringLiteral('completed'),
        '100000',
        '100000',
        'current_timestamp',
      ].join(', ')
    })
    .map((valueSql) => {
      return `(${valueSql})`
    })
    .join(',\n')
}

const getFixtureSearchJobValuesSql = () => {
  return reviewServingBenchmarkOverlapWorkloadDefinition.operations
    .filter((operation) => {
      return operation.contractKey === 'review.search.substringAsync' && operation.jobFilterSignaturePrefix
    })
    .map((operation) => {
      const filterSignature = `${operation.jobFilterSignaturePrefix}${operation.key}`
      return [
        getSqlStringLiteral(`phase6-physical-rehearsal-100k:${operation.key}`),
        getSqlStringLiteral(fixtureProjectId),
        getSqlStringLiteral(fixtureComponentIdentities.search),
        getSqlStringLiteral(fixtureComponentIdentities.projectScope),
        getSqlStringLiteral(fixtureReviewConfigHash),
        getSqlStringLiteral(fixtureSnapshotId),
        getSqlStringLiteral('substringAsync'),
        getSqlStringLiteral(`${operation.searchTextPrefix ?? 'overlap '}100k`),
        getSqlStringLiteral(filterSignature),
        getSqlStringLiteral('completed'),
        '100000',
        getSqlStringLiteral('ready'),
        'current_timestamp',
      ].join(', ')
    })
    .map((valueSql) => {
      return `(${valueSql})`
    })
    .join(',\n')
}

const getFixtureCountRowSql = (input: {
  countKind: NamedReviewFastCountKey
  countValue: number
  filterKey: string
  listModeKey: ReviewServingListMode | 'global'
}) => {
  return [
    getSqlStringLiteral(fixtureProjectId),
    getSqlStringLiteral(fixtureReviewConfigHash),
    getSqlStringLiteral(fixtureSnapshotId),
    getSqlStringLiteral(fixtureComponentIdentities.summary),
    getSqlStringLiteral(input.listModeKey),
    getSqlStringLiteral(input.countKind),
    getSqlStringLiteral(namedReviewFastCountDefinitions[input.countKind].summaryDefinitionVersion),
    getSqlStringLiteral(input.filterKey),
    String(input.countValue),
    getSqlStringLiteral('ready'),
  ].join(', ')
}

const getFixtureCountValuesSql = () => {
  const listTotals = reviewServingListModes.flatMap((listModeKey) => {
    return [
      getFixtureCountRowSql({countKind: 'review.list.total', countValue: 100_000, filterKey: 'global', listModeKey}),
      getFixtureCountRowSql({
        countKind: 'review.list.filteredTotal',
        countValue: 100_000,
        filterKey: 'global',
        listModeKey,
      }),
    ]
  })
  const promptCounts = promptScopedCountKeys.flatMap((countKind) => {
    const listModeKey =
      countKind === 'review.both.conflictByPrompt'
        ? 'both'
        : countKind === 'review.human.reviewedByPrompt'
          ? 'human'
          : countKind === 'review.llm.unassessedByPrompt'
            ? 'unassessed'
            : 'llm'

    return Array.from({length: 7}, (_value, promptIndex) => {
      return getFixtureCountRowSql({
        countKind,
        countValue: countKind === 'review.llm.unassessedByPrompt' ? 25_000 : 100_000,
        filterKey: `prompt:prompt-${promptIndex + 1}`,
        listModeKey,
      })
    })
  })
  const queueCounts = Array.from({length: 7}, (_value, promptIndex) => {
    return getFixtureCountRowSql({
      countKind: 'review.queue.unassessedReady',
      countValue: 25_000,
      filterKey: `prompt:prompt-${promptIndex + 1}`,
      listModeKey: 'unassessed',
    })
  })

  return [...listTotals, ...promptCounts, ...queueCounts]
    .map((valueSql) => {
      return `(${valueSql})`
    })
    .join(',\n')
}

const getFixtureFacetValuesSql = () => {
  const facetRows = [
    {
      answerId: null,
      answerValue: null,
      countValue: 50_000,
      facetKey: 'publicationYear',
      facetKind: 'review',
      facetValue: '2024',
      promptId: null,
      summaryDefinitionVersion:
        namedReviewFastCountDefinitions['review.filter.publicationYear'].summaryDefinitionVersion,
      summaryIdentity: 'phase6-physical-rehearsal-100k:review-facets:v1',
    },
    {
      answerId: null,
      answerValue: null,
      countValue: 20_000,
      facetKey: 'duplicateFlag',
      facetKind: 'review',
      facetValue: 'false',
      promptId: null,
      summaryDefinitionVersion: namedReviewFastCountDefinitions['review.filter.duplicateFlag'].summaryDefinitionVersion,
      summaryIdentity: 'phase6-physical-rehearsal-100k:review-facets:v1',
    },
    {
      answerId: null,
      answerValue: null,
      countValue: 20_000,
      facetKey: 'importRoute',
      facetKind: 'review',
      facetValue: 'route-1',
      promptId: null,
      summaryDefinitionVersion: namedReviewFastCountDefinitions['review.filter.importRoute'].summaryDefinitionVersion,
      summaryIdentity: 'phase6-physical-rehearsal-100k:review-facets:v1',
    },
    {
      answerId: 1,
      answerValue: 'yes',
      countValue: 100_000,
      facetKey: 'promptAnswer',
      facetKind: 'review',
      facetValue: 'review:promptAnswer:prompt-1:yes',
      promptId: 'prompt-1',
      summaryDefinitionVersion: namedReviewFastCountDefinitions['review.filter.promptAnswer'].summaryDefinitionVersion,
      summaryIdentity: 'phase6-physical-rehearsal-100k:review-facets:v1',
    },
    {
      answerId: 1,
      answerValue: 'yes',
      countValue: 75_000,
      facetKey: 'promptAnswer',
      facetKind: 'human',
      facetValue: 'human:promptAnswer:prompt-1:yes',
      promptId: 'prompt-1',
      summaryDefinitionVersion:
        namedReviewFastCountDefinitions['review.human.filter.promptAnswer'].summaryDefinitionVersion,
      summaryIdentity: 'phase6-physical-rehearsal-100k:human-facets:v1',
    },
    {
      answerId: null,
      answerValue: null,
      countValue: 75_000,
      facetKey: 'summaryAnswer',
      facetKind: 'human',
      facetValue: 'reviewed',
      promptId: null,
      summaryDefinitionVersion:
        namedReviewFastCountDefinitions['review.human.filter.summaryAnswer'].summaryDefinitionVersion,
      summaryIdentity: 'phase6-physical-rehearsal-100k:human-facets:v1',
    },
  ] as const

  return facetRows
    .map((row) => {
      return [
        getSqlStringLiteral(fixtureProjectId),
        getSqlStringLiteral(fixtureReviewConfigHash),
        getSqlStringLiteral(fixtureSnapshotId),
        getSqlStringLiteral(row.summaryIdentity),
        getSqlStringLiteral(row.facetKind),
        getSqlStringLiteral(row.facetKey),
        getSqlStringLiteral(row.facetValue),
        getSqlStringLiteral(row.promptId),
        row.answerId === null ? 'NULL' : String(row.answerId),
        getSqlStringLiteral(row.answerValue),
        getSqlStringLiteral(row.summaryDefinitionVersion),
        String(row.countValue),
        getSqlStringLiteral('ready'),
      ].join(', ')
    })
    .map((valueSql) => {
      return `(${valueSql})`
    })
    .join(',\n')
}

const getFixtureFilterOptionValuesSql = () => {
  const optionRows = [
    {
      answerId: null,
      countValue: 50_000,
      facetKey: 'publicationYear',
      facetValue: '2024',
      filterKind: 'publicationYear',
      numericMax: 2024,
      numericMin: 2024,
      optionValueKey: 'publicationYear:2024',
      promptId: null,
    },
    {
      answerId: null,
      countValue: 20_000,
      facetKey: 'importRoute',
      facetValue: 'route-1',
      filterKind: 'importRoute',
      numericMax: null,
      numericMin: null,
      optionValueKey: 'importRoute:route-1',
      promptId: null,
    },
    {
      answerId: 1,
      countValue: 100_000,
      facetKey: 'promptAnswer',
      facetValue: 'yes',
      filterKind: 'promptAnswer',
      numericMax: null,
      numericMin: null,
      optionValueKey: 'promptAnswer:prompt-1:yes',
      promptId: 'prompt-1',
    },
  ] as const

  return optionRows
    .map((row) => {
      return [
        getSqlStringLiteral(fixtureProjectId),
        getSqlStringLiteral(fixtureReviewConfigHash),
        getSqlStringLiteral(fixtureSnapshotId),
        getSqlStringLiteral(fixtureComponentIdentities.search),
        getSqlStringLiteral(fixtureFilterOptionIdentity),
        getSqlStringLiteral(row.optionValueKey),
        getSqlStringLiteral(row.filterKind),
        getSqlStringLiteral(row.facetKey),
        getSqlStringLiteral(row.facetValue),
        getSqlStringLiteral(row.promptId),
        row.answerId === null ? 'NULL' : String(row.answerId),
        row.numericMin === null ? 'NULL' : String(row.numericMin),
        row.numericMax === null ? 'NULL' : String(row.numericMax),
        getJsonSqlLiteral({fixture: 'phase6-physical-rehearsal-100k', optionValueKey: row.optionValueKey}),
        String(row.countValue),
      ].join(', ')
    })
    .map((valueSql) => {
      return `(${valueSql})`
    })
    .join(',\n')
}

const getFixtureSeedSqlStatements = () => {
  const snapshotScopePredicate = [
    `project_id = ${getSqlStringLiteral(fixtureProjectId)}`,
    `snapshot_id = ${getSqlStringLiteral(fixtureSnapshotId)}`,
    `review_config_hash = ${getSqlStringLiteral(fixtureReviewConfigHash)}`,
  ].join(' AND ')
  const promptRangeSql = '(SELECT range AS prompt_num FROM range(1, 8))'
  const articleRangeSql = '(SELECT range AS article_num FROM range(1, 100001))'
  const listModeSql = "(VALUES ('llm'), ('human'), ('both'), ('unassessed')) AS list_modes(list_mode_key)"

  return [
    `DELETE FROM app.review_bulk_operation_job WHERE project_id = ${getSqlStringLiteral(fixtureProjectId)}`,
    `DELETE FROM app.review_search_job WHERE project_id = ${getSqlStringLiteral(fixtureProjectId)}`,
    `DELETE FROM app.review_serving_snapshot_manifest WHERE project_id = ${getSqlStringLiteral(fixtureProjectId)}`,
    `DELETE FROM app.review_selected_import_snapshot WHERE project_id = ${getSqlStringLiteral(fixtureProjectId)}`,
    `DELETE FROM app.review_projection_identity_manifest WHERE project_id = ${getSqlStringLiteral(fixtureProjectId)}`,
    `DELETE FROM mart.review_title_search_serving_v4 WHERE project_id = ${getSqlStringLiteral(fixtureProjectId)}`,
    `DELETE FROM mart.review_article_serving_v4 WHERE ${snapshotScopePredicate}`,
    `DELETE FROM mart.review_article_serving_payload_v4 WHERE project_id = ${getSqlStringLiteral(
      fixtureProjectId,
    )} AND snapshot_id = ${getSqlStringLiteral(fixtureSnapshotId)}`,
    `DELETE FROM mart.review_article_judgment_detail_serving_v4 WHERE ${snapshotScopePredicate}`,
    `DELETE FROM mart.review_article_filter_posting_serving_v4 WHERE ${snapshotScopePredicate}`,
    `DELETE FROM mart.review_article_count_serving_v4 WHERE ${snapshotScopePredicate}`,
    `DELETE FROM mart.review_filter_facet_serving_v4 WHERE ${snapshotScopePredicate}`,
    `DELETE FROM mart.review_filter_option_serving_v4 WHERE ${snapshotScopePredicate}`,
    `DELETE FROM mart.review_unassessed_queue_serving_v4 WHERE ${snapshotScopePredicate}`,
    `
      INSERT INTO app.review_projection_identity_manifest (
        manifest_id,
        project_id,
        projection_component,
        projection_identity,
        base_generation,
        patch_watermark,
        input_watermark,
        input_watermarks_json,
        input_digest,
        definition_version,
        review_config_hash,
        prompt_config_hash,
        status
      )
      VALUES ${getFixtureProjectionManifestValuesSql()}
    `,
    `
      INSERT INTO app.review_selected_import_snapshot (
        selected_import_snapshot_id,
        project_id,
        project_scope_identity,
        source_delta_high_water,
        cursor_json,
        status,
        owner,
        started_at,
        completed_at
      )
      VALUES (
        ${getSqlStringLiteral(fixtureSelectedImportSnapshotId)},
        ${getSqlStringLiteral(fixtureProjectId)},
        ${getSqlStringLiteral(fixtureComponentIdentities.projectScope)},
        100000,
        ${getJsonSqlLiteral({articleCount: 100_000, fixture: 'phase6-physical-rehearsal-100k'})},
        ${getSqlStringLiteral('completed')},
        ${getSqlStringLiteral('phase6-physical-rehearsal-100k')},
        current_timestamp,
        current_timestamp
      )
    `,
    `
      INSERT INTO app.review_serving_snapshot_manifest (
        project_id,
        snapshot_id,
        snapshot_status,
        review_config_hash,
        composed_identity_json,
        component_state_json,
        required_components_json,
        optional_components_json,
        source_watermarks_json,
        validation_result_json,
        selected_import_snapshot_id,
        activated_at
      )
      VALUES (
        ${getSqlStringLiteral(fixtureProjectId)},
        ${getSqlStringLiteral(fixtureSnapshotId)},
        ${getSqlStringLiteral('active')},
        ${getSqlStringLiteral(fixtureReviewConfigHash)},
        ${getJsonSqlLiteral(getFixtureIdentity())},
        ${getJsonSqlLiteral(getFixtureComponentState())},
        ${getJsonSqlLiteral(getFixtureComponentState().required)},
        ${getJsonSqlLiteral(getFixtureComponentState().optional)},
        ${getJsonSqlLiteral({articleHighWater: 100_000, promptHighWater: 7})},
        ${getJsonSqlLiteral({fixture: 'phase6-physical-rehearsal-100k', status: 'valid'})},
        ${getSqlStringLiteral(fixtureSelectedImportSnapshotId)},
        current_timestamp
      )
    `,
    `
      INSERT INTO mart.review_article_serving_payload_v4 (
        project_id,
        display_identity,
        payload_identity,
        snapshot_id,
        article_id,
        article_created_at,
        source_metadata,
        abstract_text,
        full_text_preview,
        payload_bytes
      )
      SELECT
        ${getSqlStringLiteral(fixtureProjectId)},
        ${getSqlStringLiteral(fixtureComponentIdentities.display)},
        ${getSqlStringLiteral(fixtureComponentIdentities.payload)},
        ${getSqlStringLiteral(fixtureSnapshotId)},
        'article-' || lpad(CAST(article_num AS VARCHAR), 6, '0'),
        TIMESTAMPTZ '2026-01-01 00:00:00+00' + article_num * INTERVAL 1 SECOND,
        json_object('fixture', 'phase6-physical-rehearsal-100k', 'articleNumber', article_num),
        'Phase 6 100k rehearsal abstract ' || CAST(article_num AS VARCHAR),
        'Phase 6 100k rehearsal full text preview ' || CAST(article_num AS VARCHAR),
        512
      FROM ${articleRangeSql}
    `,
    `
      INSERT INTO mart.review_article_serving_v4 (
        project_id,
        review_config_hash,
        snapshot_id,
        base_generation,
        patch_watermark,
        display_identity,
        project_scope_identity,
        selected_import_identity,
        llm_status_identity,
        human_status_identity,
        posting_identity,
        summary_identity,
        payload_identity,
        list_mode_key,
        article_id,
        article_created_at,
        article_updated_at,
        sort_key,
        activity_sort_at,
        article_title,
        article_external_id,
        doi,
        journal_title,
        url,
        selected_import_route_id,
        selected_rank_key,
        publication_year,
        duplicate_flag,
        conflict_flag,
        llm_status_key,
        human_status_key,
        llm_judged_prompt_count,
        enabled_prompt_count,
        human_answered_prompt_count,
        review_opened,
        review_sections_completed
      )
      SELECT
        ${getSqlStringLiteral(fixtureProjectId)},
        ${getSqlStringLiteral(fixtureReviewConfigHash)},
        ${getSqlStringLiteral(fixtureSnapshotId)},
        1,
        0,
        ${getSqlStringLiteral(fixtureComponentIdentities.display)},
        ${getSqlStringLiteral(fixtureComponentIdentities.projectScope)},
        ${getSqlStringLiteral(fixtureComponentIdentities.selectedImport)},
        ${getSqlStringLiteral(fixtureComponentIdentities.llmStatus)},
        ${getSqlStringLiteral(fixtureComponentIdentities.humanStatus)},
        ${getSqlStringLiteral(fixtureComponentIdentities.posting)},
        ${getSqlStringLiteral(fixtureComponentIdentities.summary)},
        ${getSqlStringLiteral(fixtureComponentIdentities.payload)},
        list_mode_key,
        'article-' || lpad(CAST(article_num AS VARCHAR), 6, '0'),
        TIMESTAMPTZ '2026-01-01 00:00:00+00' + article_num * INTERVAL 1 SECOND,
        TIMESTAMPTZ '2026-01-01 00:00:00+00' + article_num * INTERVAL 1 SECOND,
        TIMESTAMPTZ '2026-01-01 00:00:00+00' + article_num * INTERVAL 1 SECOND,
        TIMESTAMPTZ '2026-01-01 00:00:00+00' + article_num * INTERVAL 1 SECOND,
        'Phase 6 Rehearsal Article ' || lpad(CAST(article_num AS VARCHAR), 6, '0'),
        'phase6-' || CAST(article_num AS VARCHAR),
        '10.0000/phase6.' || CAST(article_num AS VARCHAR),
        'Phase 6 Rehearsal Journal',
        'https://example.invalid/phase6/' || CAST(article_num AS VARCHAR),
        'route-' || CAST(article_num % 5 AS VARCHAR),
        lpad(CAST(article_num AS VARCHAR), 12, '0'),
        2020 + CAST(article_num % 6 AS INTEGER),
        article_num % 17 = 0,
        article_num % 23 = 0,
        CASE WHEN list_mode_key = 'unassessed' THEN 'unanswered' ELSE 'answered' END,
        CASE WHEN list_mode_key IN ('human', 'both') THEN 'reviewed' ELSE 'pending' END,
        CASE WHEN list_mode_key = 'unassessed' THEN 0 ELSE 7 END,
        7,
        CASE WHEN list_mode_key IN ('human', 'both') THEN 7 ELSE 0 END,
        list_mode_key IN ('human', 'both'),
        CASE WHEN list_mode_key IN ('human', 'both') THEN 7 ELSE 0 END
      FROM ${articleRangeSql}, ${listModeSql}
    `,
    `
      INSERT INTO mart.review_article_judgment_detail_serving_v4 (
        project_id,
        review_config_hash,
        snapshot_id,
        list_mode_key,
        payload_kind,
        article_id,
        prompt_id,
        prompt_order,
        judgment_id,
        model_id,
        answered_original,
        answered_original_as_array,
        judgment_payload_json,
        placeholder_kind
      )
      SELECT
        ${getSqlStringLiteral(fixtureProjectId)},
        ${getSqlStringLiteral(fixtureReviewConfigHash)},
        ${getSqlStringLiteral(fixtureSnapshotId)},
        list_mode_key,
        payload_kind,
        'article-' || lpad(CAST(article_num AS VARCHAR), 6, '0'),
        'prompt-' || CAST(prompt_num AS VARCHAR),
        prompt_num,
        'judgment-' || CAST(article_num AS VARCHAR) || '-' || CAST(prompt_num AS VARCHAR) || '-' || payload_kind,
        'model-phase6',
        CASE WHEN (article_num + prompt_num) % 3 = 0 THEN 'maybe' WHEN (article_num + prompt_num) % 2 = 0 THEN 'yes' ELSE 'no' END,
        [CASE WHEN (article_num + prompt_num) % 3 = 0 THEN 'maybe' WHEN (article_num + prompt_num) % 2 = 0 THEN 'yes' ELSE 'no' END]::VARCHAR[],
        json_object(
          'fixture', 'phase6-physical-rehearsal-100k',
          'articleNumber', article_num,
          'promptNumber', prompt_num,
          'payloadKind', payload_kind
        ),
        NULL
      FROM ${articleRangeSql}, ${promptRangeSql}, (VALUES
        ('llm', 'llm'),
        ('human', 'human'),
        ('both', 'llm'),
        ('both', 'human')
      ) AS detail_modes(list_mode_key, payload_kind)
    `,
    `
      INSERT INTO mart.review_article_filter_posting_serving_v4 (
        project_id,
        review_config_hash,
        snapshot_id,
        posting_identity,
        filter_kind,
        filter_value,
        list_mode_key,
        sort_key,
        article_id
      )
      SELECT
        ${getSqlStringLiteral(fixtureProjectId)},
        ${getSqlStringLiteral(fixtureReviewConfigHash)},
        ${getSqlStringLiteral(fixtureSnapshotId)},
        ${getSqlStringLiteral(fixtureComponentIdentities.posting)},
        'promptAnswer',
        CASE
          WHEN list_mode_key = 'human' THEN 'human:promptAnswer:prompt-1:yes'
          ELSE 'review:promptAnswer:prompt-1:yes'
        END,
        list_mode_key,
        TIMESTAMPTZ '2026-01-01 00:00:00+00' + article_num * INTERVAL 1 SECOND,
        'article-' || lpad(CAST(article_num AS VARCHAR), 6, '0')
      FROM ${articleRangeSql}, ${listModeSql}
    `,
    `
      INSERT INTO mart.review_article_count_serving_v4 (
        project_id,
        review_config_hash,
        snapshot_id,
        summary_identity,
        list_mode_key,
        count_kind,
        summary_definition_version,
        filter_key,
        count_value,
        availability
      )
      VALUES ${getFixtureCountValuesSql()}
    `,
    `
      INSERT INTO mart.review_filter_facet_serving_v4 (
        project_id,
        review_config_hash,
        snapshot_id,
        summary_identity,
        facet_kind,
        facet_key,
        facet_value,
        prompt_id,
        answer_id,
        answer_value,
        summary_definition_version,
        count_value,
        availability
      )
      VALUES ${getFixtureFacetValuesSql()}
    `,
    `
      INSERT INTO mart.review_filter_option_serving_v4 (
        project_id,
        review_config_hash,
        snapshot_id,
        search_identity,
        filter_option_identity,
        option_value_key,
        filter_kind,
        facet_key,
        facet_value,
        prompt_id,
        answer_id,
        numeric_min,
        numeric_max,
        option_payload_json,
        count_value
      )
      VALUES ${getFixtureFilterOptionValuesSql()}
    `,
    `
      INSERT INTO mart.review_title_search_serving_v4 (
        project_id,
        search_identity,
        project_scope_identity,
        snapshot_id,
        token,
        article_id,
        title_prefix,
        activity_sort_at
      )
      SELECT
        ${getSqlStringLiteral(fixtureProjectId)},
        ${getSqlStringLiteral(fixtureComponentIdentities.search)},
        ${getSqlStringLiteral(fixtureComponentIdentities.projectScope)},
        ${getSqlStringLiteral(fixtureSnapshotId)},
        token,
        'article-' || lpad(CAST(article_num AS VARCHAR), 6, '0'),
        token,
        TIMESTAMPTZ '2026-01-01 00:00:00+00' + article_num * INTERVAL 1 SECOND
      FROM ${articleRangeSql}, (VALUES ('phase6'), ('rehearsal'), ('review'), ('overlap')) AS tokens(token)
    `,
    `
      INSERT INTO mart.review_unassessed_queue_serving_v4 (
        project_id,
        review_config_hash,
        snapshot_id,
        queue_identity,
        queue_kind,
        priority_bucket,
        activity_sort_at,
        article_id,
        prompt_id
      )
      SELECT
        ${getSqlStringLiteral(fixtureProjectId)},
        ${getSqlStringLiteral(fixtureReviewConfigHash)},
        ${getSqlStringLiteral(fixtureSnapshotId)},
        ${getSqlStringLiteral(fixtureComponentIdentities.queue)},
        ${getSqlStringLiteral(fixtureQueueKind)},
        CAST(article_num % 10 AS INTEGER),
        TIMESTAMPTZ '2026-01-01 00:00:00+00' + article_num * INTERVAL 1 SECOND,
        'article-' || lpad(CAST(article_num AS VARCHAR), 6, '0'),
        'prompt-' || CAST(1 + article_num % 7 AS VARCHAR)
      FROM ${articleRangeSql}
    `,
    `
      INSERT INTO app.review_bulk_operation_job (
        job_id,
        job_kind,
        project_id,
        snapshot_id,
        review_config_hash,
        composed_identity_json,
        filter_signature,
        criteria_json,
        batch_size,
        status,
        processed_count,
        total_estimate,
        completed_at
      )
      VALUES ${getFixtureBulkJobValuesSql()}
    `,
    `
      INSERT INTO app.review_search_job (
        job_id,
        project_id,
        search_identity,
        project_scope_identity,
        review_config_hash,
        snapshot_id,
        search_mode,
        search_text,
        filter_signature,
        status,
        result_count,
        result_count_availability,
        completed_at
      )
      VALUES ${getFixtureSearchJobValuesSql()}
    `,
  ]
}

const getReviewConfigPredicate = (reviewConfigHash: string | null | undefined, tableAlias?: string) => {
  if (reviewConfigHash === undefined) {
    return ''
  }

  const column = tableAlias ? `${tableAlias}.review_config_hash` : 'review_config_hash'

  return `AND ${column} IS NOT DISTINCT FROM ${getSqlStringLiteral(reviewConfigHash)}`
}

const getSnapshotScopePredicate = (input: ReviewServingPhysical100kSnapshotContext, tableAlias?: string) => {
  const column = (name: string) => {
    return tableAlias ? `${tableAlias}.${name}` : name
  }

  return [
    `${column('project_id')} = ${getSqlStringLiteral(input.projectId)}`,
    `${column('snapshot_id')} = ${getSqlStringLiteral(input.snapshotId)}`,
    `${column('review_config_hash')} IS NOT DISTINCT FROM ${getSqlStringLiteral(input.reviewConfigHash)}`,
  ].join(' AND ')
}

const getSearchScopePredicate = (input: ReviewServingPhysical100kSnapshotContext, tableAlias?: string) => {
  const column = (name: string) => {
    return tableAlias ? `${tableAlias}.${name}` : name
  }

  return [
    `${column('project_id')} = ${getSqlStringLiteral(input.projectId)}`,
    `${column('snapshot_id')} = ${getSqlStringLiteral(input.snapshotId)}`,
    `${column('search_identity')} = ${getSqlStringLiteral(input.activeSnapshotIdentity.searchIdentity)}`,
    `${column('project_scope_identity')} IS NOT DISTINCT FROM ${getSqlStringLiteral(
      input.activeSnapshotIdentity.manifestIdentity,
    )}`,
  ].join(' AND ')
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const parseMaybeJson = (value: unknown): unknown => {
  if (typeof value !== 'string') {
    return value
  }

  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

const getUnknownArray = (value: unknown): readonly unknown[] => {
  return Array.isArray(value) ? (value as readonly unknown[]) : []
}

const getComponentStates = (componentStateJson: unknown) => {
  const parsed = parseMaybeJson(componentStateJson)
  const state = isRecord(parsed) ? parsed : {}
  const required = getUnknownArray(state.required)
  const optional = getUnknownArray(state.optional)

  return [...required, ...optional].filter(isRecord)
}

const getComponentIdentity = (componentStateJson: unknown, component: ReviewServingProjectionComponent) => {
  const entry = getComponentStates(componentStateJson).find((candidate) => {
    return candidate.component === component
  })
  const identity = entry?.projectionIdentity

  return typeof identity === 'string' && identity.trim().length > 0 ? identity : null
}

const getRequiredComponentIdentity = (componentStateJson: unknown, component: ReviewServingProjectionComponent) => {
  const identity = getComponentIdentity(componentStateJson, component)

  if (!identity) {
    throw new Error(`Physical review-serving fixture is missing ${component} component identity`)
  }

  return identity
}

const toNumber = (value: unknown) => {
  return typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string' ? Number(value) : 0
}

const toText = (value: unknown) => {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

const getFirstRow = async <T>(database: ReviewServingReaderDatabase, statement: string, label: string) => {
  const rows = await database.queryJson<T>(statement)
  const row = rows[0]

  if (row === undefined) {
    throw new Error(`Physical review-serving fixture is missing ${label}`)
  }

  return row
}

type ActiveSnapshotRow = {
  componentStateJson: unknown
  projectId: string
  reviewConfigHash: string | null
  snapshotId: string
}

const getActiveSnapshotContext = async (
  args: Pick<ReviewServingPhysical100kBenchmarkArgs, 'projectId' | 'reviewConfigHash'>,
  database: ReviewServingReaderDatabase,
): Promise<ReviewServingPhysical100kSnapshotContext> => {
  const projectPredicate = args.projectId ? `AND project_id = ${getSqlStringLiteral(args.projectId)}` : ''
  const reviewConfigPredicate = getReviewConfigPredicate(args.reviewConfigHash)
  const row = await getFirstRow<ActiveSnapshotRow>(
    database,
    `
      SELECT
        project_id AS projectId,
        snapshot_id AS snapshotId,
        review_config_hash AS reviewConfigHash,
        component_state_json AS componentStateJson
      FROM app.review_serving_snapshot_manifest
      WHERE snapshot_status = 'active'
        ${projectPredicate}
        ${reviewConfigPredicate}
      ORDER BY activated_at DESC NULLS LAST, updated_at DESC
      LIMIT 1
    `,
    'an active review-serving snapshot manifest',
  )
  const componentStateJson = row.componentStateJson
  const projectScopeIdentity = getRequiredComponentIdentity(componentStateJson, 'projectScope')
  const summaryIdentity = getRequiredComponentIdentity(componentStateJson, 'summary')

  return {
    activeSnapshotIdentity: {
      countIdentity: summaryIdentity,
      manifestIdentity: projectScopeIdentity,
      projectId: row.projectId,
      reviewConfigHash: row.reviewConfigHash ?? 'null-review-config',
      searchIdentity: getRequiredComponentIdentity(componentStateJson, 'search'),
      snapshotId: row.snapshotId,
    },
    projectId: row.projectId,
    reviewConfigHash: row.reviewConfigHash,
    snapshotId: row.snapshotId,
  }
}

export const getReviewServingPhysical100kFixtureVerification = (
  actual: ReviewServingPhysical100kFixtureDimensions,
): ReviewServingPhysical100kFixtureVerification => {
  return {
    actual: {
      articleCount: actual.articleCount,
      articlePromptOverlapRows: actual.articlePromptOverlapRows,
      promptCount: actual.promptCount,
    },
    expected: expectedFixtureDimensions,
    passed:
      actual.articleCount === expectedFixtureDimensions.articleCount
      && actual.articlePromptOverlapRows === expectedFixtureDimensions.articlePromptOverlapRows
      && actual.promptCount === expectedFixtureDimensions.promptCount,
  }
}

const assertReviewServingPhysical100kFixtureVerification = (
  verification: ReviewServingPhysical100kFixtureVerification,
) => {
  if (!verification.passed) {
    throw new Error(
      `Physical review-serving fixture dimensions mismatch: expected ${JSON.stringify(
        verification.expected,
      )}, got ${JSON.stringify(verification.actual)}`,
    )
  }
}

const getFixtureDimensions = async (
  context: ReviewServingPhysical100kSnapshotContext,
  database: ReviewServingReaderDatabase,
): Promise<ReviewServingPhysical100kFixtureDimensions> => {
  const row = await getFirstRow<{articleCount: number; articlePromptOverlapRows: number; promptCount: number}>(
    database,
    `
      WITH scoped_articles AS (
        SELECT DISTINCT article_id
        FROM mart.review_article_serving_v4
        WHERE ${getSnapshotScopePredicate(context)}
      ),
      scoped_article_prompt_pairs AS (
        SELECT DISTINCT article_id, prompt_id
        FROM mart.review_article_judgment_detail_serving_v4
        WHERE ${getSnapshotScopePredicate(context)}
          AND prompt_id IS NOT NULL
      )
      SELECT
        CAST((SELECT COUNT(*) FROM scoped_articles) AS BIGINT) AS articleCount,
        CAST((SELECT COUNT(DISTINCT prompt_id) FROM scoped_article_prompt_pairs) AS BIGINT) AS promptCount,
        CAST((SELECT COUNT(*) FROM scoped_article_prompt_pairs) AS BIGINT) AS articlePromptOverlapRows
    `,
    '100k review-serving fixture dimensions',
  )

  return {
    articleCount: toNumber(row.articleCount),
    articlePromptOverlapRows: toNumber(row.articlePromptOverlapRows),
    promptCount: toNumber(row.promptCount),
  }
}

const getArticleIds = async (
  context: ReviewServingPhysical100kSnapshotContext,
  database: ReviewServingReaderDatabase,
) => {
  const rows = await database.queryJson<{articleId: string}>(`
    SELECT DISTINCT article_id AS articleId
    FROM mart.review_article_serving_v4
    WHERE ${getSnapshotScopePredicate(context)}
    ORDER BY article_id
    LIMIT 100
  `)
  const articleIds = rows
    .map((row) => {
      return row.articleId
    })
    .filter((articleId) => {
      return typeof articleId === 'string' && articleId.length > 0
    })

  if (articleIds.length === 0) {
    throw new Error('Physical review-serving fixture is missing article rows')
  }

  return articleIds
}

const getSearchTokenPrefix = async (
  context: ReviewServingPhysical100kSnapshotContext,
  database: ReviewServingReaderDatabase,
) => {
  const row = await getFirstRow<{token: string}>(
    database,
    `
      SELECT token
      FROM mart.review_title_search_serving_v4
      WHERE ${getSearchScopePredicate(context)}
        AND length(token) >= 2
      ORDER BY token, article_id
      LIMIT 1
    `,
    'a title-search token prefix row',
  )

  return row.token.slice(0, Math.min(4, row.token.length))
}

const getPromptCounts = async (
  context: ReviewServingPhysical100kSnapshotContext,
  database: ReviewServingReaderDatabase,
) => {
  const rows = await database.queryJson<{
    countKind: NamedReviewFastCountKey
    countValue: number | null
    filterKey: string
  }>(`
    SELECT
      count_kind AS countKind,
      filter_key AS filterKey,
      CAST(count_value AS DOUBLE) AS countValue
    FROM mart.review_article_count_serving_v4
    WHERE ${getSnapshotScopePredicate(context)}
      AND availability = 'ready'
      AND filter_key LIKE 'prompt:%'
      AND count_kind IN (${promptScopedCountKeys.map(getSqlStringLiteral).join(', ')})
    ORDER BY count_kind, count_value DESC NULLS LAST, filter_key
  `)
  const counts = promptScopedCountKeys.reduce<Partial<ReviewServingPhysical100kFixtureSamples['promptCounts']>>(
    (entries, countKey) => {
      const row = rows.find((candidate) => {
        return candidate.countKind === countKey
      })

      return row ? {...entries, [countKey]: {filterKey: row.filterKey, value: toNumber(row.countValue)}} : entries
    },
    {},
  )
  const missingCountKeys = promptScopedCountKeys.filter((countKey) => {
    return counts[countKey] === undefined
  })

  if (missingCountKeys.length > 0) {
    throw new Error(`Physical review-serving fixture is missing ready prompt counts: ${missingCountKeys.join(', ')}`)
  }

  return counts as ReviewServingPhysical100kFixtureSamples['promptCounts']
}

const getPostingFilter = async (
  context: ReviewServingPhysical100kSnapshotContext,
  database: ReviewServingReaderDatabase,
): Promise<ReviewServingPhysical100kFixtureSamples['postingFilter']> => {
  const row = await getFirstRow<{filterKind: string; filterValue: string; listModeKey: string}>(
    database,
    `
      SELECT
        filter_kind AS filterKind,
        filter_value AS filterValue,
        list_mode_key AS listModeKey
      FROM mart.review_article_filter_posting_serving_v4
      WHERE ${getSnapshotScopePredicate(context)}
      ORDER BY sort_key DESC NULLS LAST, article_id
      LIMIT 1
    `,
    'a filter posting row',
  )
  const listMode = (reviewServingListModes as readonly string[]).includes(row.listModeKey)
    ? (row.listModeKey as ReviewServingListMode)
    : 'llm'

  return {filterKind: row.filterKind, filterValue: row.filterValue, listMode}
}

const getFacetSummaryIdentity = async (
  context: ReviewServingPhysical100kSnapshotContext,
  database: ReviewServingReaderDatabase,
  facetKind: 'human' | 'review',
) => {
  const row = await getFirstRow<{summaryIdentity: string}>(
    database,
    `
      SELECT summary_identity AS summaryIdentity
      FROM mart.review_filter_facet_serving_v4
      WHERE ${getSnapshotScopePredicate(context)}
        AND availability = 'ready'
        AND facet_kind = ${getSqlStringLiteral(facetKind)}
      ORDER BY count_value DESC NULLS LAST, facet_key, facet_value
      LIMIT 1
    `,
    `${facetKind} facet summary identity`,
  )

  return row.summaryIdentity
}

const getFilterOptionIdentity = async (
  context: ReviewServingPhysical100kSnapshotContext,
  database: ReviewServingReaderDatabase,
) => {
  const row = await getFirstRow<{filterOptionIdentity: string}>(
    database,
    `
      SELECT filter_option_identity AS filterOptionIdentity
      FROM mart.review_filter_option_serving_v4
      WHERE ${getSnapshotScopePredicate(context)}
        AND search_identity = ${getSqlStringLiteral(context.activeSnapshotIdentity.searchIdentity)}
      ORDER BY count_value DESC NULLS LAST, filter_kind, facet_key, option_value_key
      LIMIT 1
    `,
    'a filter option identity',
  )

  return row.filterOptionIdentity
}

const getQueueKind = async (
  context: ReviewServingPhysical100kSnapshotContext,
  database: ReviewServingReaderDatabase,
) => {
  const rows = await database.queryJson<{queueKind: string}>(`
    SELECT queue_kind AS queueKind
    FROM mart.review_unassessed_queue_serving_v4
    WHERE ${getSnapshotScopePredicate(context)}
    ORDER BY priority_bucket DESC NULLS LAST, activity_sort_at DESC NULLS LAST
    LIMIT 1
  `)

  return toText(rows[0]?.queueKind) ?? 'unassessed'
}

const getFixtureSamples = async (
  context: ReviewServingPhysical100kSnapshotContext,
  database: ReviewServingReaderDatabase,
): Promise<ReviewServingPhysical100kFixtureSamples> => {
  const [
    articleIds,
    filterOptionIdentity,
    humanFacetSummaryIdentity,
    postingFilter,
    promptCounts,
    queueKind,
    reviewFacetSummaryIdentity,
    searchTokenPrefix,
  ] = await Promise.all([
    getArticleIds(context, database),
    getFilterOptionIdentity(context, database),
    getFacetSummaryIdentity(context, database, 'human'),
    getPostingFilter(context, database),
    getPromptCounts(context, database),
    getQueueKind(context, database),
    getFacetSummaryIdentity(context, database, 'review'),
    getSearchTokenPrefix(context, database),
  ])

  return {
    articleIds,
    filterOptionIdentity,
    humanFacetSummaryIdentity,
    postingFilter,
    promptCounts,
    queueKind,
    reviewFacetSummaryIdentity,
    searchTokenPrefix,
  }
}

export const getReviewServingPhase6PhysicalRehearsal100kWorkloadDefinition =
  (): ReviewServingBenchmarkWorkloadDefinition => {
    return {
      ...reviewServingBenchmarkOverlapWorkloadDefinition,
      fixtureKind: reviewServingBenchmarkPhase6PhysicalRehearsal100kFixture.kind,
      key: 'reviewServing.phase6PhysicalRehearsal100k.v1',
      operations: reviewServingBenchmarkOverlapWorkloadDefinition.operations.map((operation) => {
        return {
          ...operation,
          maxRowsScannedPerRequest: Number.MAX_SAFE_INTEGER,
          minimumDistinctRequestSlices: operation.minimumDistinctRequestSlices === undefined ? undefined : 1,
          requestCount: 1,
          targetRowsReturnedPerRequest: getPhysical100kTargetRowsReturnedPerRequest(operation),
        }
      }),
    }
  }

const physical100kArticleSetSampleSize = 2
const physical100kReviewFacetRows = 4
const physical100kHumanFacetRows = 2
const physical100kFilterOptionRows = 3

const getPhysical100kTargetRowsReturnedPerRequest = (operation: ReviewServingBenchmarkWorkloadOperation) => {
  const articleSetJudgmentRows =
    physical100kArticleSetSampleSize * reviewServingBenchmarkPhase6PhysicalRehearsal100kFixture.promptCount

  if (operation.key.endsWith('RowsByArticleSet')) {
    return Math.min(operation.targetRowsReturnedPerRequest, physical100kArticleSetSampleSize)
  }

  if (operation.key.endsWith('ListJudgmentPayloadRows') || operation.key === 'bothListHumanJudgmentPayloadRows') {
    return Math.min(operation.targetRowsReturnedPerRequest, articleSetJudgmentRows)
  }

  if (operation.key === 'overlapFacetRefresh') {
    return Math.min(operation.targetRowsReturnedPerRequest, physical100kReviewFacetRows)
  }

  if (operation.key === 'humanOverlapFacetRefresh') {
    return Math.min(operation.targetRowsReturnedPerRequest, physical100kHumanFacetRows)
  }

  if (operation.key === 'overlapFilterOptions' || operation.key === 'humanOverlapFilterOptions') {
    return Math.min(operation.targetRowsReturnedPerRequest, physical100kFilterOptionRows)
  }

  return operation.targetRowsReturnedPerRequest
}

const getNumericValuesFromUnknown = (value: unknown): number[] => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? [value] : []
  }

  if (typeof value === 'string') {
    return [...value.matchAll(/([0-9][0-9,]*)\s+rows?\b/giu)].map((match) => {
      return Number((match[1] ?? '').replaceAll(',', ''))
    })
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      return getNumericValuesFromUnknown(entry)
    })
  }

  if (value && typeof value === 'object') {
    return Object.values(value).flatMap((entry) => {
      return getNumericValuesFromUnknown(entry)
    })
  }

  return []
}

const getRowsScannedFromExplainAnalyze = async (
  database: ReviewServingReaderDatabase,
  executableSql: string,
): Promise<number> => {
  try {
    const rows = await database.queryJson<Record<string, unknown>>(`EXPLAIN ANALYZE ${executableSql}`)
    const rowCounts = rows.flatMap((row) => {
      return getNumericValuesFromUnknown(row)
    })

    return rowCounts.length > 0 ? Math.max(...rowCounts) : -1
  } catch (_error) {
    return -1
  }
}

const getTempUsageBytes = async (database: ReviewServingReaderDatabase): Promise<number> => {
  try {
    const rows = await database.queryJson<{tempUsageBytes: number | null}>(
      'SELECT COALESCE(SUM(size), 0)::BIGINT AS tempUsageBytes FROM duckdb_temporary_files()',
    )
    const tempUsageBytes = rows[0]?.tempUsageBytes

    if (typeof tempUsageBytes === 'bigint') {
      return Number(tempUsageBytes)
    }

    return typeof tempUsageBytes === 'number' && Number.isFinite(tempUsageBytes) ? tempUsageBytes : -1
  } catch (_error) {
    return -1
  }
}

const getEstimatedResultBytes = (operation: ReviewServingBenchmarkWorkloadOperation) => {
  const contract = getReviewServingReadContract(operation.contractKey)
  const maxEstimatedResultBytes = contract?.maxEstimatedResultBytes ?? 500_000

  return Math.min(maxEstimatedResultBytes, Math.max(1_000, operation.pageSize * 512))
}

const getBaseReaderRequest = (
  operation: ReviewServingBenchmarkWorkloadOperation,
  context: ReviewServingPhysical100kSnapshotContext,
): ReviewServingReaderRequest => {
  return {
    contractKey: operation.contractKey,
    estimatedResultBytes: getEstimatedResultBytes(operation),
    estimatedResultRows: operation.pageSize,
    limit: operation.pageSize,
    projectId: context.projectId,
    reviewConfigHash: context.reviewConfigHash,
    snapshotId: context.snapshotId,
    ...(operation.searchMode === 'tokenPrefix'
      ? {
          searchMode: 'tokenPrefix' as const,
          searchState: {availability: 'ready' as const, snapshotId: context.snapshotId},
        }
      : {}),
    ...(operation.searchMode === 'substringAsync' ? {searchMode: 'substringAsync' as const} : {}),
  }
}

const getBaseWorkItem = (input: {
  context: ReviewServingPhysical100kSnapshotContext
  key: string
  operation: ReviewServingBenchmarkWorkloadOperation
  request: ReviewServingReaderRequest
  workItem: Partial<ReviewServingBenchmarkWorkItem>
}): ReviewServingBenchmarkWorkItem => {
  const request = input.request

  return {
    activeSnapshotIdentity: input.context.activeSnapshotIdentity,
    admissionRequest: {
      contractKey: input.operation.contractKey,
      countFilterKey: input.operation.countFilterKeyPrefix ? (request.countFilterKey ?? undefined) : undefined,
      countState: request.countState ?? undefined,
      estimatedResultBytes: request.estimatedResultBytes,
      estimatedResultRows: request.estimatedResultRows,
      namedCountKey: request.namedCountKey ?? undefined,
      pageSize: input.operation.pageSize,
      projectId: input.context.projectId,
      searchMode: request.searchMode,
      searchState: request.searchState,
      snapshotFreshness: input.operation.searchMode === 'substringAsync' ? 'unavailable' : 'ready',
      snapshotId: input.context.snapshotId,
      workloadClass: input.operation.workloadClass,
    },
    key: input.key,
    observation: {latencyMs: 0, memoryRssBytes: 0, queueDepth: 0, rowsReturned: 0, rowsScanned: 0, tempUsageBytes: 0},
    operationKey: input.operation.key,
    ...input.workItem,
  }
}

const getPromptCountState = (input: {
  context: ReviewServingPhysical100kSnapshotContext
  countKey: NamedReviewFastCountKey
  samples: ReviewServingPhysical100kFixtureSamples
}) => {
  const count = input.samples.promptCounts[input.countKey]

  return {
    availability: 'ready' as const,
    filterKey: count.filterKey,
    key: input.countKey,
    snapshotId: input.context.snapshotId,
    value: count.value,
  }
}

const getReaderRequestForOperation = (
  operation: ReviewServingBenchmarkWorkloadOperation,
  context: ReviewServingPhysical100kSnapshotContext,
  samples: ReviewServingPhysical100kFixtureSamples,
) => {
  const request = getBaseReaderRequest(operation, context)
  const contract = getReviewServingReadContract(operation.contractKey)
  const articleSetRequest = {
    ...request,
    articleIds: samples.articleIds,
    estimatedHydratedPayloadBytes: samples.articleIds.length * 10_000,
    listMode: contract?.listMode ?? undefined,
  }
  const promptCountState = operation.namedCountKey
    ? getPromptCountState({context, countKey: operation.namedCountKey, samples})
    : null

  if (operation.key === 'filteredOverlapRows') {
    return {
      ...request,
      filterKind: samples.postingFilter.filterKind,
      filterValue: samples.postingFilter.filterValue,
      listMode: samples.postingFilter.listMode,
      searchTokenPrefix: samples.searchTokenPrefix,
      searchTokenPrefixes: [samples.searchTokenPrefix],
    }
  }

  if (operation.key === 'detailJudgmentPayloadRows') {
    return {...request, articleId: samples.articleIds[0]}
  }

  if (operation.key === 'overlapFacetRefresh') {
    return {...request, countFilterKey: samples.reviewFacetSummaryIdentity}
  }

  if (operation.key === 'humanOverlapFacetRefresh') {
    return {...request, countFilterKey: samples.humanFacetSummaryIdentity}
  }

  if (operation.key === 'overlapFilterOptions' || operation.key === 'humanOverlapFilterOptions') {
    return {
      ...request,
      filterOptionIdentity: samples.filterOptionIdentity,
      searchTokenPrefix: samples.searchTokenPrefix,
      searchTokenPrefixes: [samples.searchTokenPrefix],
    }
  }

  if (
    operation.key.endsWith('RowsByArticleSet')
    || operation.key.endsWith('ListJudgmentPayloadRows')
    || operation.key === 'bothListHumanJudgmentPayloadRows'
  ) {
    return articleSetRequest
  }

  if (promptCountState) {
    return {
      ...request,
      countFilterKey: promptCountState.filterKey,
      countState: promptCountState,
      namedCountKey: promptCountState.key,
    }
  }

  if (operation.key === 'unassessedOverlapQueue') {
    return {...request, queueKind: samples.queueKind}
  }

  if (operation.key === 'titlePrefixOverlapSearch') {
    return {...request, searchTokenPrefix: samples.searchTokenPrefix, searchTokenPrefixes: [samples.searchTokenPrefix]}
  }

  if (operation.jobFilterSignaturePrefix) {
    return {
      ...request,
      jobFilterSignature: `${operation.jobFilterSignaturePrefix}${operation.key}`,
      ...(operation.searchTextPrefix ? {searchText: `${operation.searchTextPrefix}100k`} : {}),
    }
  }

  return request
}

const getWorkItemForRequest = (
  operation: ReviewServingBenchmarkWorkloadOperation,
  context: ReviewServingPhysical100kSnapshotContext,
  request: ReviewServingReaderRequest,
  samples: ReviewServingPhysical100kFixtureSamples,
) => {
  const key = `physical-100k-${operation.key}`
  const filterSignature =
    request.countFilterKey
    ?? (request.articleId ? `article:${request.articleId}` : null)
    ?? (request.articleIds ? `article-set:${request.articleIds.length}` : null)
    ?? (request.filterKind && request.filterValue ? `${request.filterKind}:${request.filterValue}` : null)
    ?? (request.filterOptionIdentity ? `filter-option:${request.filterOptionIdentity}` : null)
    ?? (request.queueKind ? `queue:${request.queueKind}` : null)
    ?? (operation.key.includes('Checkpoint') ? 'active-manifest' : null)

  return getBaseWorkItem({
    context,
    key,
    operation,
    request,
    workItem: {
      cursor: operation.requestSliceFields?.includes('cursor') ? 'start' : undefined,
      filterSignature: filterSignature ?? undefined,
      jobFilterSignature: request.jobFilterSignature ?? undefined,
      jobKind: operation.jobKind,
      listMode: request.listMode ?? undefined,
      queueKind: request.queueKind ?? undefined,
      requestSlice: {
        ...(operation.requestSliceFields?.includes('cursor') ? {cursor: 'start'} : {}),
        ...(operation.requestSliceFields?.includes('filter') && filterSignature ? {filter: filterSignature} : {}),
        ...(operation.requestSliceFields?.includes('jobFilterSignature') && request.jobFilterSignature
          ? {jobFilterSignature: request.jobFilterSignature}
          : {}),
        ...(operation.requestSliceFields?.includes('listMode') && request.listMode ? {listMode: request.listMode} : {}),
        ...(operation.requestSliceFields?.includes('projectId') ? {projectId: context.projectId} : {}),
        ...(operation.requestSliceFields?.includes('queueKind') && request.queueKind
          ? {queueKind: request.queueKind}
          : {}),
        ...(operation.requestSliceFields?.includes('searchText') && request.searchText
          ? {searchText: request.searchText}
          : {}),
        ...(operation.requestSliceFields?.includes('searchTokenPrefix')
          ? {searchTokenPrefix: request.searchTokenPrefix ?? samples.searchTokenPrefix}
          : {}),
        ...(operation.requestSliceFields?.includes('snapshotId') ? {snapshotId: context.snapshotId} : {}),
      },
      searchText: request.searchText ?? undefined,
      searchTokenPrefix: request.searchTokenPrefix ?? undefined,
    },
  })
}

export const getReviewServingPhysical100kBenchmarkInput = (
  context: ReviewServingPhysical100kSnapshotContext,
  samples: ReviewServingPhysical100kFixtureSamples,
): ReviewServingPhysical100kInput => {
  const workload = getReviewServingPhase6PhysicalRehearsal100kWorkloadDefinition()
  const entries = workload.operations.map((operation) => {
    const request = getReaderRequestForOperation(operation, context, samples)
    const workItem = getWorkItemForRequest(operation, context, request, samples)

    return {request, workItem}
  })
  const readerRequestsByWorkItemKey = new Map(
    entries.map((entry) => {
      return [entry.workItem.key, entry.request] as const
    }),
  )

  return {
    fixture: reviewServingBenchmarkPhase6PhysicalRehearsal100kFixture,
    readerRequestsByWorkItemKey,
    releaseContext: {
      activeSnapshotIdentity: context.activeSnapshotIdentity,
      benchmarkRunKind: reviewServingPhase6PhysicalRehearsal100kRunKind,
      duckdbMemoryLimit: '6400MiB',
      tempDirGrowthBytes: 0,
    },
    workload,
    workItems: entries.map((entry) => {
      return entry.workItem
    }),
  }
}

const createPhysicalBenchmarkExecutor = (input: {
  database: ReviewServingReaderDatabase
  manifestDatabase: ReviewServingManifestRepositoryDatabase
  readerRequestsByWorkItemKey: ReadonlyMap<string, ReviewServingReaderRequest>
  sampleEvidence: ReviewServingPhysical100kSampleEvidence[]
}): ReviewServingBenchmarkExecutor => {
  return (workItem) => {
    return Effect.promise(async (): Promise<ReviewServingBenchmarkObservation> => {
      const request = input.readerRequestsByWorkItemKey.get(workItem.key)

      if (!request) {
        throw new Error(`Missing physical reader request for ${workItem.key}`)
      }

      const startedAtMs = performance.now()
      const result = await readReviewServingRows<Record<string, unknown>>(request, {
        database: input.database,
        diagnosticsDatabase: input.manifestDatabase,
        manifestDatabase: input.manifestDatabase,
      })
      const latencyMs = Number((performance.now() - startedAtMs).toFixed(2))

      if (result.status !== 'accepted') {
        throw new Error(
          `Physical review-serving read rejected for ${workItem.key}: ${result.reason} ${JSON.stringify(
            result.diagnostics,
          )}`,
        )
      }

      const [rowsScanned, tempUsageBytes] = await Promise.all([
        getRowsScannedFromExplainAnalyze(input.database, result.executableSql),
        getTempUsageBytes(input.database),
      ])

      input.sampleEvidence.push({
        contractKey: request.contractKey,
        executableSql: result.executableSql,
        key: workItem.key,
        latencyMs,
        operationKey: workItem.operationKey,
        rowsScanned,
        rowsReturned: result.rows.length,
        sql: result.sql,
        tempUsageBytes,
      })

      return {
        latencyMs,
        memoryRssBytes: sampleReviewServingBenchmarkMemoryRssBytes(),
        queueDepth: 0,
        rowsReturned: result.rows.length,
        rowsScanned,
        tempUsageBytes,
      }
    })
  }
}

const getEvidenceFileName = (generatedAt: string) => {
  return `review-serving-phase6-physical-rehearsal-100k-${generatedAt.replaceAll(/[:.]/gu, '-')}.json`
}

const getDuckdbPathFileValue = (envValues: NodeJS.ProcessEnv) => {
  const duckdbPathFile = envValues.DUCKDB_PATH_FILE?.trim()

  return duckdbPathFile && existsSync(duckdbPathFile) ? readFileSync(duckdbPathFile, 'utf8').trim() : null
}

const getLiveDuckdbPath = (envValues: NodeJS.ProcessEnv = process.env) => {
  const duckdbPathFileValue = getDuckdbPathFileValue(envValues)

  return getConfiguredDuckdbPath({envValues: {...envValues, DUCKDB_PATH: duckdbPathFileValue ?? envValues.DUCKDB_PATH}})
}

export const assertFixturePathDoesNotTargetLiveDuckdb = (
  fixturePath: string,
  envValues: NodeJS.ProcessEnv = process.env,
) => {
  const liveDuckdbPath = getLiveDuckdbPath(envValues)

  if (liveDuckdbPath !== ':memory:' && resolve(liveDuckdbPath) === resolve(fixturePath)) {
    throw new Error('Refusing to benchmark the live DuckDB path; pass a separate physical fixture copy via --fixture-path')
  }
}

const createDuckdbWriteRuntime = async (args: ReviewServingPhysical100kBenchmarkArgs) => {
  const duckdbInstance = await DuckDBInstance.create(args.fixturePath, {memory_limit: args.duckdbMemoryLimit})
  const connection = await duckdbInstance.connect()

  return {
    close: () => {
      connection.closeSync()
      duckdbInstance.closeSync()
    },
    connection,
  }
}

const runFixtureSeedStatements = async (
  connection: {run: (statement: string) => Promise<unknown>},
  statements: readonly string[],
): Promise<void> => {
  const [statement, ...remainingStatements] = statements

  if (!statement) {
    return
  }

  await connection.run(statement)

  return runFixtureSeedStatements(connection, remainingStatements)
}

const buildReviewServingPhysical100kFixture = async (args: ReviewServingPhysical100kBenchmarkArgs) => {
  const fixtureExistedBeforeBuild = existsSync(args.fixturePath)
  let shouldRemoveFailedFixture = false

  console.log(`Building Phase 6 physical 100k fixture at ${args.fixturePath}`)
  await runFixtureMigration(args)
  const runtime = await createDuckdbWriteRuntime(args)

  try {
    await runtime.connection.run('BEGIN TRANSACTION')
    await runFixtureSeedStatements(runtime.connection, getFixtureSeedSqlStatements())
    await runtime.connection.run('COMMIT')
    await runtime.connection.run('CHECKPOINT')
  } catch (error) {
    try {
      await runtime.connection.run('ROLLBACK')
    } catch {
      // Best effort rollback after a failed fixture seed.
    }

    shouldRemoveFailedFixture = !fixtureExistedBeforeBuild
    throw error
  } finally {
    runtime.close()
    if (shouldRemoveFailedFixture) {
      await unlink(args.fixturePath).catch(() => {
        return undefined
      })
    }
  }
}

const ensureReviewServingPhysical100kFixture = async (args: ReviewServingPhysical100kBenchmarkArgs) => {
  assertFixturePathDoesNotTargetLiveDuckdb(args.fixturePath)

  if (!existsSync(args.fixturePath)) {
    await buildReviewServingPhysical100kFixture(args)
  }
}

const createDuckdbReadOnlyRuntime = async (args: ReviewServingPhysical100kBenchmarkArgs) => {
  const duckdbInstance = await DuckDBInstance.create(args.fixturePath, {
    access_mode: 'READ_ONLY',
    memory_limit: args.duckdbMemoryLimit,
  })
  const connection = await duckdbInstance.connect()
  const database: ReviewServingReaderDatabase & ReviewServingManifestRepositoryDatabase = {
    queryJson: async <T>(statement: string, _workloadContext?: DuckdbWorkloadContext): Promise<T[]> => {
      const reader = await connection.runAndReadAll(statement)

      return reader.getRowObjectsJson() as T[]
    },
    run: async () => {
      throw new Error('Physical 100k benchmark runtime is read-only')
    },
    transaction: async (operation) => {
      return operation(database)
    },
  }

  return {
    close: () => {
      connection.closeSync()
      duckdbInstance.closeSync()
    },
    database,
  }
}

export const runReviewServingPhysical100kBenchmark = async (args: ReviewServingPhysical100kBenchmarkArgs) => {
  await ensureReviewServingPhysical100kFixture(args)
  const runtime = await createDuckdbReadOnlyRuntime(args)

  try {
    const generatedAt = new Date().toISOString()
    const context = await getActiveSnapshotContext(args, runtime.database)
    const fixtureDimensions = await getFixtureDimensions(context, runtime.database)
    const fixtureVerification = getReviewServingPhysical100kFixtureVerification(fixtureDimensions)
    assertReviewServingPhysical100kFixtureVerification(fixtureVerification)
    const samples = await getFixtureSamples(context, runtime.database)
    const benchmarkInput = getReviewServingPhysical100kBenchmarkInput(context, samples)
    const sampleEvidence: ReviewServingPhysical100kSampleEvidence[] = []
    const result = await Effect.runPromise(
      runReviewServingBenchmarkEffect({
        ...benchmarkInput,
        executor: createPhysicalBenchmarkExecutor({
          database: runtime.database,
          manifestDatabase: runtime.database,
          readerRequestsByWorkItemKey: benchmarkInput.readerRequestsByWorkItemKey,
          sampleEvidence,
        }),
        releaseContext: {
          ...(benchmarkInput.releaseContext as ReviewServingBenchmarkReleaseContext),
          duckdbMemoryLimit: args.duckdbMemoryLimit,
        },
      }),
    )
    const outputPath = join(args.outputDir, getEvidenceFileName(generatedAt))
    const evidence = {
      benchmarkRunKind: reviewServingPhase6PhysicalRehearsal100kRunKind,
      fixture: result.fixture,
      fixturePath: args.fixturePath,
      fixtureVerification,
      generatedAt,
      isReleaseScaleDuckDbGate: false,
      metrics: result.metrics,
      notReleaseGateReason: '100k physical rehearsal only; does not claim the true 10M releaseScaleDuckDb gate.',
      releaseReport: result.releaseReport,
      sampleEvidence,
      schemaVersion: 1,
      workload: result.workload,
    }

    await mkdir(args.outputDir, {recursive: true})
    await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')

    return {evidence, outputPath}
  } finally {
    runtime.close()
  }
}

if (import.meta.main) {
  const result = await runReviewServingPhysical100kBenchmark(parseReviewServingPhysical100kBenchmarkArgs())

  console.log(
    JSON.stringify(
      {
        benchmarkRunKind: result.evidence.benchmarkRunKind,
        fixtureVerification: result.evidence.fixtureVerification,
        metrics: result.evidence.metrics,
        outputPath: result.outputPath,
      },
      null,
      2,
    ),
  )
}
