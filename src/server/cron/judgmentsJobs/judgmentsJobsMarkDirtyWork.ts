import type {JudgmentInsertRow} from '../../services/appDatabaseService.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getSqlLiteral, getTimestampLiteral} from '../../services/appQueryHelpers.ts'
import {getComparisonProjectServingInvalidationService} from '../../services/comparisonProjectServingInvalidationService.ts'
import {getProjectMartDirtyRefreshStateService} from '../../services/projectMartDirtyRefreshStateService.ts'
import type {JudgmentJobSqliteOutboxEntry} from './judgmentJobSqliteService.ts'

type DirtyWorkRunner = {queryJson: <T>(statement: string) => Promise<T[]>; run: (statement: string) => Promise<void>}
type JudgmentOutboxDiscardedEntry = {entry: JudgmentJobSqliteOutboxEntry; errorMessage: string}
type JudgmentOutboxImportMarkerInput = {
  entry: JudgmentJobSqliteOutboxEntry
  errorMessage: string | null
  importStatus: 'discarded' | 'imported'
}
type JudgmentOutboxImportMarkerRow = {jobId: string; outboxSeq: number}
type JudgmentOutboxImportRow = {jobId: string; outboxSeq: number}

export type JudgmentSqliteOutboxDirtyWorkResult = {
  discardedRows: Array<JudgmentOutboxImportRow & {errorMessage: string}>
  duplicateRows: JudgmentOutboxImportRow[]
  importedRows: JudgmentOutboxImportRow[]
  importableRows: JudgmentOutboxImportRow[]
}

type CommitJudgmentSqliteOutboxImportDirtyWorkParams = {
  discardedEntries: JudgmentOutboxDiscardedEntry[]
  importableEntries: JudgmentJobSqliteOutboxEntry[]
  now?: Date
  requestedBy?: string | null
}

const getOutboxRowKey = (row: {jobId: string; outboxSeq: number}) => {
  return `${row.jobId}|${row.outboxSeq}`
}

const getOutboxImportMarkerPredicate = (entry: JudgmentJobSqliteOutboxEntry) => {
  return `(job_id = ${getSqlLiteral(entry.jobId)} AND outbox_seq = ${entry.outboxSeq})`
}

const getOutboxImportMarkerKeys = async (runner: DirtyWorkRunner, entries: JudgmentJobSqliteOutboxEntry[]) => {
  if (entries.length === 0) {
    return new Set<string>()
  }

  const rows = await runner.queryJson<JudgmentOutboxImportMarkerRow>(`
    SELECT
      job_id AS jobId,
      CAST(outbox_seq AS INTEGER) AS outboxSeq
    FROM app.judgment_job_sqlite_outbox_import
    WHERE ${entries.map(getOutboxImportMarkerPredicate).join(' OR ')}
  `)

  return new Set(rows.map(getOutboxRowKey))
}

const getUnmarkedEntries = (entries: JudgmentJobSqliteOutboxEntry[], markerKeys: Set<string>) => {
  return entries.filter((entry) => {
    return !markerKeys.has(getOutboxRowKey(entry))
  })
}

const getMarkedEntries = (entries: JudgmentJobSqliteOutboxEntry[], markerKeys: Set<string>) => {
  return entries.filter((entry) => {
    return markerKeys.has(getOutboxRowKey(entry))
  })
}

const getJsonSql = (value: unknown) => {
  const jsonText = value === undefined ? null : JSON.stringify(value)
  return jsonText === null ? 'NULL::JSON' : `${getSqlLiteral(jsonText)}::JSON`
}

const getStringArraySql = (value: string[]) => {
  return `(${getJsonSql(value)})::VARCHAR[]`
}

const getJudgmentInsertRows = (entries: JudgmentJobSqliteOutboxEntry[]): JudgmentInsertRow[] => {
  return entries.map((entry) => {
    return {
      answeredOriginal: entry.answeredOriginal,
      answeredOriginalAsArray: entry.answeredOriginalAsArray,
      articleId: entry.articleId,
      chunkingStrategy: entry.chunkingStrategy,
      confidenceOriginal: entry.confidenceOriginal,
      createdAt: entry.createdAt,
      explanation: entry.explanation,
      id: entry.judgmentId,
      isAnswered: entry.isAnswered ?? true,
      modelId: entry.modelId,
      projectId: entry.projectId,
      promptId: entry.promptId,
      quotes: entry.quotes,
      snapshotProjectId: entry.snapshotProjectId,
      snapshotProjectModelName: entry.snapshotProjectModelName,
      updatedAt: entry.updatedAt,
      useAbstract: entry.useAbstract,
      useFulltext: entry.useFulltext,
      useFulltextNoImages: entry.useFulltextNoImages,
      useTitle: entry.useTitle,
    }
  })
}

const getJudgmentInsertValueSql = (row: JudgmentInsertRow) => {
  return `(
    ${getSqlLiteral(row.id)},
    ${getSqlLiteral(row.articleId)},
    ${getSqlLiteral(row.modelId)},
    ${getSqlLiteral(row.promptId)},
    ${getSqlLiteral(row.projectId)},
    ${getSqlLiteral(row.isAnswered)},
    ${getSqlLiteral(row.answeredOriginal)},
    ${getStringArraySql(row.answeredOriginalAsArray)},
    ${getSqlLiteral(row.confidenceOriginal)},
    ${getSqlLiteral(row.explanation)},
    ${getJsonSql(row.quotes)},
    ${getSqlLiteral(row.useTitle)},
    ${getSqlLiteral(row.useAbstract)},
    ${getSqlLiteral(row.useFulltext)},
    ${getSqlLiteral(row.useFulltextNoImages)},
    ${getSqlLiteral(row.chunkingStrategy)},
    ${getSqlLiteral(row.snapshotProjectId)},
    ${getSqlLiteral(row.snapshotProjectModelName)},
    ${getTimestampLiteral(row.createdAt)},
    ${getTimestampLiteral(row.updatedAt)}
  )`
}

const insertJudgments = async (runner: DirtyWorkRunner, entries: JudgmentJobSqliteOutboxEntry[]) => {
  if (entries.length === 0) {
    return new Set<string>()
  }

  const rows = await runner.queryJson<{id: string}>(`
    INSERT INTO app.judgment (
      id,
      article_id,
      model_id,
      prompt_id,
      project_id,
      is_answered,
      answered_original,
      answered_original_as_array,
      confidence_original,
      explanation,
      quotes,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images,
      chunking_strategy,
      snapshot_project_id,
      snapshot_project_model_name,
      created_at,
      updated_at
    ) VALUES ${getJudgmentInsertRows(entries).map(getJudgmentInsertValueSql).join(', ')}
    ON CONFLICT(article_id, prompt_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, delete_generation) DO NOTHING
    RETURNING id
  `)

  return new Set(
    rows.map((row) => {
      return row.id
    }),
  )
}

const getUniqueArticleIds = (entries: JudgmentJobSqliteOutboxEntry[]) => {
  return Array.from(
    new Set(
      entries.map((entry) => {
        return entry.articleId
      }),
    ),
  )
}

const markRefreshStateDirtyForEntries = async (
  runner: DirtyWorkRunner,
  entries: JudgmentJobSqliteOutboxEntry[],
  requestedBy?: string | null,
) => {
  const articleIds = getUniqueArticleIds(entries)

  if (articleIds.length > 0) {
    await getProjectMartDirtyRefreshStateService().markArticleProjectsDirtyAtomically({
      articleIds,
      reason: 'sqliteJudgmentOutboxImport',
      requestedBy: requestedBy ?? null,
      runner,
    })
  }
}

const getInsertedEntries = (entries: JudgmentJobSqliteOutboxEntry[], insertedJudgmentIds: Set<string>) => {
  return entries.filter((entry) => {
    return insertedJudgmentIds.has(entry.judgmentId)
  })
}

const markComparisonServingStaleForInsertedEntries = async (
  runner: DirtyWorkRunner,
  entries: JudgmentJobSqliteOutboxEntry[],
  insertedJudgmentIds: Set<string>,
) => {
  const insertedEntries = getInsertedEntries(entries, insertedJudgmentIds)

  await getComparisonProjectServingInvalidationService().markComparisonProjectsServingStaleForLlmJudgments(
    insertedEntries.map((entry) => {
      return {
        articleId: entry.articleId,
        modelId: entry.modelId,
        promptId: entry.promptId,
        useAbstract: entry.useAbstract,
        useFulltext: entry.useFulltext,
        useFulltextNoImages: entry.useFulltextNoImages,
        useTitle: entry.useTitle,
      }
    }),
    {runner},
  )
}

const getOutboxImportMarkerValueSql = (
  {entry, errorMessage, importStatus}: JudgmentOutboxImportMarkerInput,
  now: Date,
) => {
  return `(
    ${getSqlLiteral(entry.jobId)},
    ${entry.outboxSeq},
    ${getSqlLiteral(entry.queuePromptId)},
    ${getSqlLiteral(entry.judgmentId)},
    ${getSqlLiteral(entry.articleId)},
    ${getSqlLiteral(entry.promptId)},
    ${getSqlLiteral(entry.modelId)},
    ${getSqlLiteral(entry.projectId)},
    ${getSqlLiteral(importStatus)},
    ${getSqlLiteral(errorMessage)},
    ${getTimestampLiteral(now)},
    ${getTimestampLiteral(now)}
  )`
}

const insertOutboxImportMarkers = async (
  runner: DirtyWorkRunner,
  markerInputs: JudgmentOutboxImportMarkerInput[],
  now: Date,
) => {
  if (markerInputs.length > 0) {
    await runner.run(`
      INSERT INTO app.judgment_job_sqlite_outbox_import (
        job_id,
        outbox_seq,
        queue_prompt_id,
        judgment_id,
        article_id,
        prompt_id,
        model_id,
        project_id,
        import_status,
        error_message,
        imported_at,
        updated_at
      ) VALUES ${markerInputs
        .map((input) => {
          return getOutboxImportMarkerValueSql(input, now)
        })
        .join(', ')}
      ON CONFLICT(job_id, outbox_seq) DO NOTHING
    `)
  }
}

const getOutboxImportRows = (entries: JudgmentJobSqliteOutboxEntry[]): JudgmentOutboxImportRow[] => {
  return entries.map((entry) => {
    return {jobId: entry.jobId, outboxSeq: entry.outboxSeq}
  })
}

const getDiscardedOutboxImportRows = (
  discardedEntries: JudgmentOutboxDiscardedEntry[],
): Array<JudgmentOutboxImportRow & {errorMessage: string}> => {
  return discardedEntries.map(({entry, errorMessage}) => {
    return {errorMessage, jobId: entry.jobId, outboxSeq: entry.outboxSeq}
  })
}

const getDuplicateRows = ({
  insertedJudgmentIds,
  markedImportableEntries,
  unmarkedImportableEntries,
}: {
  insertedJudgmentIds: Set<string>
  markedImportableEntries: JudgmentJobSqliteOutboxEntry[]
  unmarkedImportableEntries: JudgmentJobSqliteOutboxEntry[]
}) => {
  return getOutboxImportRows([
    ...markedImportableEntries,
    ...unmarkedImportableEntries.filter((entry) => {
      return !insertedJudgmentIds.has(entry.judgmentId)
    }),
  ])
}

const getImportedRows = (
  entries: JudgmentJobSqliteOutboxEntry[],
  insertedJudgmentIds: Set<string>,
): JudgmentOutboxImportRow[] => {
  return getOutboxImportRows(
    entries.filter((entry) => {
      return insertedJudgmentIds.has(entry.judgmentId)
    }),
  )
}

const getOutboxImportMarkerInputs = ({
  discardedEntries,
  importableEntries,
}: {
  discardedEntries: JudgmentOutboxDiscardedEntry[]
  importableEntries: JudgmentJobSqliteOutboxEntry[]
}) => {
  return [
    ...importableEntries.map((entry) => {
      return {entry, errorMessage: null, importStatus: 'imported' as const}
    }),
    ...discardedEntries.map(({entry, errorMessage}) => {
      return {entry, errorMessage, importStatus: 'discarded' as const}
    }),
  ]
}

export const commitJudgmentSqliteOutboxImportDirtyWork = async ({
  discardedEntries,
  importableEntries,
  now,
  requestedBy = null,
}: CommitJudgmentSqliteOutboxImportDirtyWorkParams): Promise<JudgmentSqliteOutboxDirtyWorkResult> => {
  return getAppDatabaseService().transaction(async (runner) => {
    const currentNow = now ?? new Date()
    const allEntries = [
      ...importableEntries,
      ...discardedEntries.map(({entry}) => {
        return entry
      }),
    ]
    const markerKeys = await getOutboxImportMarkerKeys(runner, allEntries)
    const unmarkedImportableEntries = getUnmarkedEntries(importableEntries, markerKeys)
    const markedImportableEntries = getMarkedEntries(importableEntries, markerKeys)
    const unmarkedDiscardedEntries = discardedEntries.filter(({entry}) => {
      return !markerKeys.has(getOutboxRowKey(entry))
    })
    const insertedJudgmentIds = await insertJudgments(runner, unmarkedImportableEntries)

    await markRefreshStateDirtyForEntries(runner, unmarkedImportableEntries, requestedBy)
    await markComparisonServingStaleForInsertedEntries(runner, unmarkedImportableEntries, insertedJudgmentIds)
    await insertOutboxImportMarkers(
      runner,
      getOutboxImportMarkerInputs({
        discardedEntries: unmarkedDiscardedEntries,
        importableEntries: unmarkedImportableEntries,
      }),
      currentNow,
    )

    return {
      discardedRows: getDiscardedOutboxImportRows(discardedEntries),
      duplicateRows: getDuplicateRows({insertedJudgmentIds, markedImportableEntries, unmarkedImportableEntries}),
      importedRows: getImportedRows(unmarkedImportableEntries, insertedJudgmentIds),
      importableRows: getOutboxImportRows(importableEntries),
    }
  }) as Promise<JudgmentSqliteOutboxDirtyWorkResult>
}
