import {appendLlmJudgmentReviewServingDeltas} from '../../reviewServing/llmJudgmentReviewServingDeltaService.ts'
import type {JudgmentInsertRow} from '../../services/appDatabaseService.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getSqlLiteral, getTimestampLiteral} from '../../services/appQueryHelpers.ts'
import {getComparisonProjectServingInvalidationService} from '../../services/comparisonProjectServingInvalidationService.ts'
import {getProjectMartDirtyRefreshStateService} from '../../services/projectMartDirtyRefreshStateService.ts'
import {getProjectVisibleJudgmentScopeSql} from '../../services/projectVisibleJudgmentRule.ts'
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
type StoredJudgmentIdentityRow = {
  articleId: string
  id: string
  modelId: string
  promptId: string
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}
type VisibleJudgmentDeltaRow = {
  articleId: string
  judgmentId: string
  modelId: string
  projectId: string
  promptId: string
  sourceMutationKey: string
  sourcePartition: string
  sourceUpdatedAt: Date | string
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}

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

const getJudgmentIdentityKey = (
  row: Pick<
    StoredJudgmentIdentityRow,
    'articleId' | 'modelId' | 'promptId' | 'useAbstract' | 'useFulltext' | 'useFulltextNoImages' | 'useTitle'
  >,
) => {
  return [
    row.articleId,
    row.promptId,
    row.modelId,
    row.useTitle,
    row.useAbstract,
    row.useFulltext,
    row.useFulltextNoImages,
  ].join('|')
}

const getStoredJudgmentIdsByIdentity = async (runner: DirtyWorkRunner, entries: JudgmentJobSqliteOutboxEntry[]) => {
  const rows = await runner.queryJson<StoredJudgmentIdentityRow>(`
    SELECT
      id,
      article_id AS articleId,
      model_id AS modelId,
      prompt_id AS promptId,
      use_title AS useTitle,
      use_abstract AS useAbstract,
      use_fulltext AS useFulltext,
      use_fulltext_no_images AS useFulltextNoImages
    FROM app.judgment
    WHERE ${entries
      .map((entry) => {
        return `(
          article_id = ${getSqlLiteral(entry.articleId)}
          AND prompt_id = ${getSqlLiteral(entry.promptId)}
          AND model_id = ${getSqlLiteral(entry.modelId)}
          AND use_title = ${getSqlLiteral(entry.useTitle)}
          AND use_abstract = ${getSqlLiteral(entry.useAbstract)}
          AND use_fulltext = ${getSqlLiteral(entry.useFulltext)}
          AND use_fulltext_no_images = ${getSqlLiteral(entry.useFulltextNoImages)}
          AND delete_generation = 0
        )`
      })
      .join(' OR ')}
  `)

  return new Map(
    rows.map((row) => {
      return [getJudgmentIdentityKey(row), row.id]
    }),
  )
}

const getVisibleJudgmentDeltaRows = async (
  runner: DirtyWorkRunner,
  entries: Array<{entry: JudgmentJobSqliteOutboxEntry; judgmentId: string}>,
) => {
  if (entries.length === 0) {
    return []
  }

  return runner.queryJson<VisibleJudgmentDeltaRow>(`
    WITH imported_judgment (
      article_id,
      prompt_id,
      model_id,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images,
      judgment_id,
      source_updated_at,
      source_mutation_key,
      source_partition
    ) AS (
      VALUES ${entries
        .map(({entry, judgmentId}) => {
          return `(
            ${getSqlLiteral(entry.articleId)},
            ${getSqlLiteral(entry.promptId)},
            ${getSqlLiteral(entry.modelId)},
            ${getSqlLiteral(entry.useTitle)},
            ${getSqlLiteral(entry.useAbstract)},
            ${getSqlLiteral(entry.useFulltext)},
            ${getSqlLiteral(entry.useFulltextNoImages)},
            ${getSqlLiteral(judgmentId)},
            ${getTimestampLiteral(entry.updatedAt)},
            ${getSqlLiteral(`sqliteOutboxImport|${entry.jobId}|${entry.outboxSeq}|${entry.judgmentId}`)},
            ${getSqlLiteral(`judgmentSqliteOutboxImport:${entry.jobId}`)}
          )`
        })
        .join(', ')}
    )
    SELECT DISTINCT
      imported_judgment.article_id AS articleId,
      imported_judgment.prompt_id AS promptId,
      imported_judgment.model_id AS modelId,
      imported_judgment.use_title AS useTitle,
      imported_judgment.use_abstract AS useAbstract,
      imported_judgment.use_fulltext AS useFulltext,
      imported_judgment.use_fulltext_no_images AS useFulltextNoImages,
      imported_judgment.judgment_id AS judgmentId,
      imported_judgment.source_updated_at AS sourceUpdatedAt,
      imported_judgment.source_mutation_key AS sourceMutationKey,
      imported_judgment.source_partition AS sourcePartition,
      project.id AS projectId
    FROM imported_judgment
    INNER JOIN (
      SELECT project_id, article_id
      FROM app.project_article
      UNION
      SELECT pir.project_id, air.article_id
      FROM app.project_import_route pir
      INNER JOIN app.article_import_route air
        ON air.import_route_id = pir.import_route_id
    ) project_scope
      ON project_scope.article_id = imported_judgment.article_id
    INNER JOIN app.project project
      ON project.id = project_scope.project_id
     AND NOT project.archived
    INNER JOIN app.project_prompt project_prompt
      ON ${getProjectVisibleJudgmentScopeSql({
        judgmentAlias: 'imported_judgment',
        projectAlias: 'project',
        projectPromptAlias: 'project_prompt',
        projectScopeAlias: 'project_scope',
      })}
  `)
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
  const insertedJudgmentIds = new Set(
    rows.map((row) => {
      return row.id
    }),
  )

  const storedJudgmentIdsByIdentity = await getStoredJudgmentIdsByIdentity(runner, entries)

  const deltaRows = await getVisibleJudgmentDeltaRows(
    runner,
    entries
      .map((entry) => {
        const judgmentId = insertedJudgmentIds.has(entry.judgmentId)
          ? entry.judgmentId
          : storedJudgmentIdsByIdentity.get(getJudgmentIdentityKey(entry))

        return judgmentId ? {entry, judgmentId} : null
      })
      .filter((entry): entry is {entry: JudgmentJobSqliteOutboxEntry; judgmentId: string} => {
        return entry !== null
      }),
  )

  await appendLlmJudgmentReviewServingDeltas(
    runner,
    deltaRows.map((row) => {
      return {
        articleId: row.articleId,
        changeKind: 'judgment.llm.created' as const,
        judgmentId: row.judgmentId,
        modelId: row.modelId,
        projectId: row.projectId,
        promptId: row.promptId,
        sourceMutationKey: row.sourceMutationKey,
        sourceOperation: 'insert' as const,
        sourcePartition: row.sourcePartition,
        sourceUpdatedAt: row.sourceUpdatedAt,
        useAbstract: row.useAbstract,
        useFulltext: row.useFulltext,
        useFulltextNoImages: row.useFulltextNoImages,
        useTitle: row.useTitle,
      }
    }),
  )

  return insertedJudgmentIds
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

const getDirtyProjectsForInsertedEntries = (
  entries: JudgmentJobSqliteOutboxEntry[],
  insertedJudgmentIds: Set<string>,
) => {
  return getInsertedEntries(entries, insertedJudgmentIds).reduce((projects, entry) => {
    if (entry.projectId === null) {
      return projects
    }

    const existingArticleIds = projects.get(entry.projectId) ?? []
    projects.set(entry.projectId, Array.from(new Set([...existingArticleIds, entry.articleId])))

    return projects
  }, new Map<string, string[]>())
}

const markProjectMartRefreshStateForInsertedEntries = async ({
  insertedJudgmentIds,
  entries,
  now,
  requestedBy,
  runner,
}: {
  insertedJudgmentIds: Set<string>
  entries: JudgmentJobSqliteOutboxEntry[]
  now: Date
  requestedBy: string | null | undefined
  runner: DirtyWorkRunner
}) => {
  const dirtyProjects = Array.from(getDirtyProjectsForInsertedEntries(entries, insertedJudgmentIds).entries()).map(
    ([projectId, articleIds]) => {
      return {articleIds, projectId}
    },
  )

  await getProjectMartDirtyRefreshStateService().markProjectsDirtyAtomically({
    now,
    projects: dirtyProjects,
    requestedBy,
    runner,
    reason: 'judgment_sqlite_outbox_import',
  })
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
  requestedBy,
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

    await markComparisonServingStaleForInsertedEntries(runner, unmarkedImportableEntries, insertedJudgmentIds)
    await markProjectMartRefreshStateForInsertedEntries({
      entries: unmarkedImportableEntries,
      insertedJudgmentIds,
      now: currentNow,
      requestedBy,
      runner,
    })
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
