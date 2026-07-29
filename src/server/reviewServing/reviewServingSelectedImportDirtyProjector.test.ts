import {DuckDBInstance} from '@duckdb/node-api'
import {expect, test} from 'bun:test'

import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  checkReviewServingSelectedImportDirtyBudget,
  projectReviewServingSelectedImportDirty,
  resetReviewServingSelectedImportDirtyArticleRange,
  type ReviewServingSelectedImportDirtyProjectorDatabase,
} from './reviewServingSelectedImportDirtyProjector.ts'

const createSelectedImportDirtyDatabase = (input?: {
  budgetRow?: {dirtyRows: number; dirtyWatermarks: number}
  dirtyRows?: readonly Record<string, unknown>[]
  snapshotRows?: readonly Record<string, unknown>[]
}) => {
  const statements: string[] = []
  const database: ReviewServingSelectedImportDirtyProjectorDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM app.review_source_change_outbox')) {
        return [] as T[]
      }

      if (statement.includes('COUNT(DISTINCT patch_watermark)')) {
        return [input?.budgetRow ?? {dirtyRows: 0, dirtyWatermarks: 0}] as T[]
      }

      if (statement.includes('FROM app.review_serving_snapshot_manifest')) {
        return (input?.snapshotRows ?? []) as T[]
      }

      return (input?.dirtyRows ?? []) as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
    transaction: async (operation) => {
      return operation(database)
    },
  }

  return {database, statements}
}

const createDuckdbSelectedImportDirtyDatabase = async (): Promise<{
  close: () => void
  database: ReviewServingSelectedImportDirtyProjectorDatabase
}> => {
  const duckdbInstance = await DuckDBInstance.create(':memory:')
  const connection = await duckdbInstance.connect()
  const database: ReviewServingSelectedImportDirtyProjectorDatabase = {
    queryJson: async <T>(statement: string) => {
      const reader = await connection.runAndReadAll(statement)

      return reader.getRowObjectsJson() as T[]
    },
    run: async (statement: string) => {
      await connection.run(statement)
    },
    transaction: async (operation) => {
      await connection.run('BEGIN')

      try {
        const result = await operation(database)
        await connection.run('COMMIT')

        return result
      } catch (error) {
        await connection.run('ROLLBACK')
        throw error
      }
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

const selectedImportClaim = (input?: Partial<ReviewServingDirtyWorkClaim>): ReviewServingDirtyWorkClaim => {
  return {
    articleId: 'article-1',
    dirtyKind: 'importRoute.article.rankFields.updated',
    dirtyRangeEnd: null,
    dirtyRangeStart: null,
    dirtyWorkId: 'dirty-work-1',
    firstSourceHighWaterMark: 7,
    latestDeltaId: 'delta-1',
    latestSourceHighWaterMark: 9,
    projectId: 'project-1',
    projectionComponent: 'selectedImport',
    projectionIdentity: 'selectedImport:identity-1',
    scopeId: 'project-1:article-1',
    scopeKind: 'article',
    sourcePartition: 'import-run-article',
    status: 'running',
    ...input,
  }
}

const projectDirtyInput = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return {
    baseGeneration: 3,
    claims,
    definitionVersion: 'selected-import-v4-test',
    projectId: 'project-1',
    projectScopeIdentity: 'projectScope:identity-1',
    projectionIdentity: 'selectedImport:identity-1',
    selectedImportSnapshotId: 'selected-import-snapshot-1',
  }
}

const getInsertTargetSql = (statement: string, table = 'mart.review_selected_article_import_current_v4') => {
  return statement.slice(
    statement.indexOf(`INSERT INTO ${table} (`),
    statement.indexOf('\n    )', statement.indexOf(`INSERT INTO ${table} (`)),
  )
}

const expectSelectedImportStagingInsertOmitsDisplayCopyColumns = (statement: string) => {
  const insertTargetSql = getInsertTargetSql(statement, 'mart.review_selected_article_import_staging_v4')

  expect(insertTargetSql).not.toContain('publication_year')
  expect(insertTargetSql).not.toContain('article_title')
  expect(insertTargetSql).not.toContain('journal_title')
  expect(insertTargetSql).not.toContain('external_id')
}

const expectSelectedImportStagingInsertOmitsSelectedBaseFlagColumns = (statement: string) => {
  const insertTargetSql = getInsertTargetSql(statement, 'mart.review_selected_article_import_staging_v4')

  expect(insertTargetSql).not.toContain('duplicate_flag')
  expect(insertTargetSql).not.toContain('conflict_flag')
}

const expectNoCompatibilityServingViewRead = (statement: string) => {
  expect(statement).not.toContain('FROM mart.review_article_serving_v4')
  expect(statement).not.toContain('JOIN mart.review_article_serving_v4')
}

test('selected-import dirty routine updates only claimed articles', async () => {
  const {database, statements} = createSelectedImportDirtyDatabase({
    dirtyRows: [
      {
        articleId: 'article-1',
        articleTitle: 'Selected Import Title',
        conflictFlag: false,
        duplicateFlag: true,
        externalId: 'selected-external-1',
        importRouteId: 'import-route-1',
        journalTitle: 'Selected Journal',
        publicationYear: 2026,
        selectedRankKey: '0001:article-1',
        selectedRankNumeric: 1,
        sourceRecordKey: 'source-record-1',
        selectedSourceUrl: 'https://selected.example/article-1',
        scopeTombstone: false,
        tombstone: false,
      },
    ],
  })

  const result = await projectReviewServingSelectedImportDirty(projectDirtyInput([selectedImportClaim()]), database)
  const selectStatement = statements.find((statement) => {
    return statement.includes('WITH dirty_article(article_id)')
  })
  const joined = statements.join('\n')
  const stagingInsertStatement = statements.find((statement) => {
    return statement.includes('INSERT INTO mart.review_selected_article_import_staging_v4')
  })
  const currentUpdateStatement = statements.find((statement) => {
    return statement.includes('UPDATE mart.review_selected_article_import_current_v4 published')
  })
  const currentInsertStatement = statements.find((statement) => {
    return statement.includes('INSERT INTO mart.review_selected_article_import_current_v4')
  })
  const markPublishedStatement = statements.find((statement) => {
    return statement.includes('SET published_at = COALESCE(published_at, current_timestamp)')
  })

  expect(result).toEqual({dirtyRowCount: 1, dirtyWatermark: 9})
  expect(selectStatement).toContain("VALUES ('article-1')")
  expect(selectStatement).toContain('SELECT DISTINCT')
  expect(selectStatement).toContain('FROM dirty_article dirty')
  expect(selectStatement).toContain('LEFT JOIN mart.project_scope_article scope')
  expect(selectStatement).toContain('INNER JOIN app.review_import_article_hot_field hot')
  expect(selectStatement).toContain('LEFT JOIN app.article_import_route current_link')
  expect(selectStatement).toContain('ROW_NUMBER() OVER')
  expect(selectStatement).toContain('PARTITION BY candidate.article_id')
  expect(selectStatement).toContain('hot.article_title')
  expect(selectStatement).toContain('hot.external_id')
  expect(selectStatement).toContain('winner.source_record_key AS sourceRecordKey')
  expect(selectStatement).toContain('LEFT JOIN app.article_import_route_source_record selected_source')
  expect(selectStatement).toContain("json_extract_string(selected_source.raw_payload, '$.covidence.citation.url')")
  expect(selectStatement).toContain("WHEN current_link.id IS NOT NULL THEN concat('0:', hot.selected_rank_key)")
  expect(joined).not.toContain('mart.review_selected_import_patch_v4')
  expect(joined).toContain('DELETE FROM mart.review_article_serving_base_v4 serving')
  expect(joined).toContain('DELETE FROM mart.review_article_serving_list_mode_state_v4 state')
  expect(joined).toContain('INSERT INTO mart.review_article_serving_base_v4')
  expect(joined).toContain('INSERT INTO mart.review_article_serving_list_mode_state_v4')
  expect(joined).toContain('TRUE AS has_llm_list_mode')
  expect(joined).toContain('TRUE AS has_human_list_mode')
  expect(joined).toContain('TRUE AS has_both_list_mode')
  expect(joined).toContain('TRUE AS has_unassessed_list_mode')
  expect(joined).toContain('UPDATE mart.review_article_serving_list_mode_state_v4 state')
  expect(joined).toContain('has_llm_list_mode = TRUE')
  expect(joined).not.toContain('ON CONFLICT(project_id, review_config_hash, snapshot_id, article_id)')
  expect(joined).not.toContain('EXCLUDED.')
  expect(joined).not.toContain('list_mode_keys')
  expect(joined).toContain('INSERT INTO mart.review_selected_article_import_staging_v4')
  expect(joined).toContain(
    'selectedImportDirty:project-1:projectScope:identity-1:selected-import-snapshot-1:article-1:9',
  )
  expect(joined).toContain("'selected-import-dirty'")
  expect(joined).toContain('UPDATE mart.review_selected_article_import_current_v4 published')
  expect(joined).toContain('INSERT INTO mart.review_selected_article_import_current_v4')
  expect(joined).toContain('FROM mart.review_selected_article_import_staging_v4 staged')
  expect(joined).toContain("list_contains(['article-1']::VARCHAR[], staged.article_id)")
  expect(joined).toContain("list_contains(['article-1']::VARCHAR[], article_id)")
  expect(joined).toContain('SET published_at = COALESCE(published_at, current_timestamp)')
  expect(joined).toContain('INSERT INTO app.review_selected_article_import_v4')
  expectSelectedImportStagingInsertOmitsDisplayCopyColumns(stagingInsertStatement ?? '')
  expectSelectedImportStagingInsertOmitsSelectedBaseFlagColumns(stagingInsertStatement ?? '')
  expect(currentUpdateStatement).toContain('source_delta_high_water DESC')
  expect(currentUpdateStatement).toContain('selected_import_updated_at DESC')
  expect(currentUpdateStatement).toContain('tombstone ASC')
  expect(currentInsertStatement).toContain('published_winner AS')
  expect(currentInsertStatement).toContain('source_delta_high_water DESC')
  expect(markPublishedStatement).toContain("selected_import_snapshot_id = 'selected-import-snapshot-1'")
  expect(
    statements.findIndex((statement) => {
      return statement.includes('INSERT INTO mart.review_selected_article_import_staging_v4')
    }),
  ).toBeLessThan(
    statements.findIndex((statement) => {
      return statement.includes('UPDATE mart.review_selected_article_import_current_v4')
    }),
  )
  expect(joined).toContain('source_record_key')
  expect(joined).toContain('changed_raw(article_id, import_route_id, selected_rank_key')
  expect(joined).toContain('PARTITION BY raw.article_id')
  expect(joined).toContain('serving_template_raw AS')
  expect(joined).toContain('serving_template AS')
  expect(joined).toContain('PARTITION BY raw.project_id, raw.review_config_hash, raw.snapshot_id')
  expect(joined).toContain('FROM mart.review_article_serving_base_v4 existing')
  expect(joined).toContain('INNER JOIN mart.review_article_serving_list_mode_state_v4 existing_state')
  expect(joined).toContain('existing_state.has_llm_list_mode IS TRUE')
  expect(joined).toContain('existing_state.has_human_list_mode IS TRUE')
  expect(joined).toContain('existing_state.has_both_list_mode IS TRUE')
  expect(joined).toContain('existing_state.has_unassessed_list_mode IS TRUE')
  expect(joined).toContain('existing.article_id = changed.article_id')
  expectNoCompatibilityServingViewRead(joined)
  expect(joined).not.toContain('changed.import_route_id AS selected_import_route_id')
  expect(joined).not.toContain('serving.selected_import_route_id')
  expect(joined).not.toContain('serving.duplicate_flag')
  expect(joined).not.toContain('serving.conflict_flag')
  expect(joined).not.toContain('changed.duplicate_flag')
  expect(joined).not.toContain('changed.conflict_flag')
  expect(joined).not.toContain('changed.publication_year')
  expect(joined).not.toContain('serving.publication_year')
  expect(joined).not.toContain('COALESCE(changed.article_title, article.article_title) AS article_title')
  expect(joined).not.toContain('COALESCE(changed.external_id, article.article_id) AS article_external_id')
  expect(joined).not.toContain('COALESCE(changed.selected_source_url, article.url) AS url')
  expect(joined).not.toContain('changed.journal_title')
})

test('selected-import projector advances watermark for the max source partition', async () => {
  const {database, statements} = createSelectedImportDirtyDatabase({dirtyRows: []})

  await projectReviewServingSelectedImportDirty(
    projectDirtyInput([
      selectedImportClaim({
        dirtyWorkId: 'dirty-work-import',
        firstSourceHighWaterMark: 7,
        latestSourceHighWaterMark: 7,
        sourcePartition: 'importRunArticle',
      }),
      selectedImportClaim({
        articleId: null,
        dirtyWorkId: 'dirty-work-review',
        firstSourceHighWaterMark: 9,
        latestSourceHighWaterMark: 9,
        scopeId: 'project-1',
        scopeKind: 'project',
        sourcePartition: 'reviewChange',
      }),
    ]),
    database,
  )
  const watermarkStatement = statements.find((statement) => {
    return (
      statement.includes('INSERT INTO app.review_serving_projector_watermark') && statement.includes('WHERE NOT EXISTS')
    )
  })

  expect(watermarkStatement).toContain("'reviewChange'")
  expect(watermarkStatement).toContain('9')
})

test('selected-import no-ack snapshot passes do not publish shared manifests or watermarks', async () => {
  const {database, statements} = createSelectedImportDirtyDatabase({dirtyRows: []})

  await projectReviewServingSelectedImportDirty(
    {...projectDirtyInput([selectedImportClaim()]), acknowledgeClaims: false},
    database,
  )

  const joined = statements.join('\n')

  expect(joined).not.toContain('INSERT INTO app.review_projection_identity_manifest')
  expect(joined).not.toContain('INSERT INTO app.review_serving_dirty_work_ack')
  expect(joined).not.toContain('INSERT INTO app.review_serving_projector_watermark')
})

test('selected-import projector keeps explicit manifest watermarks separate from dirty watermarks', async () => {
  const {database, statements} = createSelectedImportDirtyDatabase({
    dirtyRows: [
      {
        articleId: 'article-1',
        articleTitle: 'Selected Import Title',
        conflictFlag: false,
        duplicateFlag: false,
        externalId: 'selected-external-1',
        importRouteId: 'import-route-1',
        journalTitle: null,
        publicationYear: null,
        selectedRankKey: '0001:article-1',
        selectedRankNumeric: 1,
        sourceRecordKey: 'source-record-1',
        selectedSourceUrl: null,
        scopeTombstone: false,
        tombstone: false,
      },
    ],
  })

  const result = await projectReviewServingSelectedImportDirty(
    {
      ...projectDirtyInput([
        selectedImportClaim({
          firstSourceHighWaterMark: 7,
          latestSourceHighWaterMark: 7,
          sourcePartition: 'importRunArticle',
        }),
      ]),
      manifestInputWatermarks: {importRunArticle: 7, reviewChange: 9},
    },
    database,
  )
  const manifestStatement = statements.find((statement) => {
    return (
      statement.includes('INSERT INTO app.review_projection_identity_manifest')
      || statement.includes('UPDATE app.review_projection_identity_manifest')
    )
  })

  expect(result).toEqual({dirtyRowCount: 1, dirtyWatermark: 7})
  expect(statements.join('\n')).not.toContain('mart.review_selected_import_patch_v4')
  expect(manifestStatement).toContain('\'{"importRunArticle":7,"reviewChange":9}\'::JSON')
})

test('selected-import tombstones replay idempotently with the same dirty watermark and article key', async () => {
  const {database, statements} = createSelectedImportDirtyDatabase({
    dirtyRows: [
      {
        articleId: 'article-1',
        articleTitle: null,
        conflictFlag: null,
        duplicateFlag: null,
        externalId: null,
        importRouteId: null,
        journalTitle: null,
        publicationYear: null,
        selectedRankKey: null,
        selectedRankNumeric: null,
        sourceRecordKey: null,
        selectedSourceUrl: null,
        scopeTombstone: false,
        tombstone: true,
      },
    ],
  })

  await projectReviewServingSelectedImportDirty(projectDirtyInput([selectedImportClaim()]), database)
  await projectReviewServingSelectedImportDirty(projectDirtyInput([selectedImportClaim()]), database)

  expect(statements.join('\n')).not.toContain('mart.review_selected_import_patch_v4')
  expect(statements.join('\n')).toContain(
    'selectedImportDirty:project-1:projectScope:identity-1:selected-import-snapshot-1:article-1:9',
  )
  expect(
    statements.filter((statement) => {
      return statement.includes('UPDATE mart.review_selected_article_import_current_v4 published')
    }),
  ).toHaveLength(2)
  expect(
    statements.filter((statement) => {
      return statement.includes('INSERT INTO mart.review_selected_article_import_current_v4')
    }),
  ).toHaveLength(2)
})

test('selected-import tombstones clear selected columns without deleting curated scoped articles', async () => {
  const {database, statements} = createSelectedImportDirtyDatabase({
    dirtyRows: [
      {
        articleId: 'article-1',
        articleTitle: null,
        conflictFlag: null,
        duplicateFlag: null,
        externalId: null,
        importRouteId: null,
        journalTitle: null,
        publicationYear: null,
        selectedRankKey: null,
        selectedRankNumeric: null,
        sourceRecordKey: null,
        selectedSourceUrl: null,
        scopeTombstone: false,
        tombstone: true,
      },
    ],
  })

  await projectReviewServingSelectedImportDirty(projectDirtyInput([selectedImportClaim()]), database)
  const joined = statements.join('\n')

  expect(joined).toContain('changed.scope_tombstone = TRUE')
  expect(joined).toContain('changed.scope_tombstone = FALSE')
  expect(joined).not.toContain('changed.import_route_id AS selected_import_route_id')
  expect(joined).toContain('NULL')
  expect(joined).toContain('TRUE')
  expect(joined).toContain('INSERT INTO mart.review_selected_article_import_staging_v4')
  expect(joined).toContain('UPDATE mart.review_selected_article_import_current_v4 published')
  expect(joined).toContain('winner.tombstone')
})

test('selected-import scope tombstones stage and publish current tombstone rows', async () => {
  const {database, statements} = createSelectedImportDirtyDatabase({
    dirtyRows: [
      {
        articleId: 'article-1',
        articleTitle: 'Out of Scope Title',
        conflictFlag: false,
        duplicateFlag: false,
        externalId: 'selected-external-1',
        importRouteId: 'import-route-1',
        journalTitle: 'Selected Journal',
        publicationYear: 2026,
        selectedRankKey: '0001:article-1',
        selectedRankNumeric: 1,
        sourceRecordKey: 'source-record-1',
        selectedSourceUrl: 'https://selected.example/article-1',
        scopeTombstone: true,
        tombstone: false,
      },
    ],
  })

  await projectReviewServingSelectedImportDirty(projectDirtyInput([selectedImportClaim()]), database)

  const stagingInsertStatement = statements.find((statement) => {
    return statement.includes('INSERT INTO mart.review_selected_article_import_staging_v4')
  })
  const joined = statements.join('\n')

  expect(stagingInsertStatement).toContain(
    'selectedImportDirty:project-1:projectScope:identity-1:selected-import-snapshot-1:article-1:9',
  )
  expect(stagingInsertStatement).toContain('NULL')
  expect(stagingInsertStatement).toContain('TRUE')
  expect(joined).toContain('UPDATE mart.review_selected_article_import_current_v4 published')
  expect(joined).toContain('INSERT INTO mart.review_selected_article_import_current_v4')
  expect(joined).toContain('winner.tombstone')
  expect(joined).toContain("list_contains(['article-1']::VARCHAR[], staged.article_id)")
})

test('selected-import dirty staged publish executes in DuckDB and refreshes stale compatibility rows', async () => {
  const {close, database} = await createDuckdbSelectedImportDirtyDatabase()

  try {
    await database.run('CREATE SCHEMA app')
    await database.run('CREATE SCHEMA mart')
    await database.run(`
      CREATE TABLE mart.project_scope_article (
        project_id VARCHAR NOT NULL,
        article_id VARCHAR NOT NULL,
        in_curated_scope BOOLEAN NOT NULL,
        in_route_scope BOOLEAN NOT NULL
      )
    `)
    await database.run(`
      CREATE TABLE app.project_import_route (
        project_id VARCHAR NOT NULL,
        import_route_id VARCHAR NOT NULL
      )
    `)
    await database.run(`
      CREATE TABLE app.review_import_article_hot_field (
        import_route_id VARCHAR NOT NULL,
        article_id VARCHAR NOT NULL,
        source_record_key VARCHAR NOT NULL,
        selected_rank_key VARCHAR,
        selected_rank_numeric DOUBLE,
        publication_year INTEGER,
        article_title VARCHAR,
        journal_title VARCHAR,
        external_id VARCHAR,
        duplicate_flag BOOLEAN,
        conflict_flag BOOLEAN,
        tombstone BOOLEAN NOT NULL
      )
    `)
    await database.run(`
      CREATE TABLE app.article_import_route (
        id VARCHAR NOT NULL,
        import_route_id VARCHAR NOT NULL,
        article_id VARCHAR NOT NULL,
        source_record_key VARCHAR NOT NULL
      )
    `)
    await database.run(`
      CREATE TABLE app.article_import_route_source_record (
        import_route_id VARCHAR NOT NULL,
        article_id VARCHAR NOT NULL,
        source_record_key VARCHAR NOT NULL,
        raw_payload JSON,
        quarantined_at TIMESTAMPTZ
      )
    `)
    await database.run(`
      CREATE TABLE app.article (
        id VARCHAR NOT NULL,
        article_created_at TIMESTAMPTZ,
        article_updated_at TIMESTAMPTZ,
        article_title VARCHAR,
        url VARCHAR
      )
    `)
    await database.run(`
      CREATE TABLE app.review_serving_snapshot_manifest (
        project_id VARCHAR NOT NULL,
        snapshot_id VARCHAR NOT NULL,
        selected_import_snapshot_id VARCHAR NOT NULL,
        review_config_hash VARCHAR,
        component_state_json JSON,
        snapshot_status VARCHAR NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `)
    await database.run(`
      CREATE TABLE mart.review_article_serving_base_v4 (
        project_id VARCHAR NOT NULL,
        review_config_hash VARCHAR NOT NULL,
        snapshot_id VARCHAR NOT NULL,
        base_generation BIGINT NOT NULL,
        patch_watermark BIGINT NOT NULL,
        article_id VARCHAR NOT NULL,
        article_created_at TIMESTAMPTZ,
        sort_key TIMESTAMPTZ,
        activity_sort_at TIMESTAMPTZ
      )
    `)
    await database.run(`
      CREATE TABLE mart.review_article_serving_list_mode_state_v4 (
        project_id VARCHAR NOT NULL,
        review_config_hash VARCHAR NOT NULL,
        snapshot_id VARCHAR NOT NULL,
        article_id VARCHAR NOT NULL,
        has_llm_list_mode BOOLEAN NOT NULL,
        has_human_list_mode BOOLEAN NOT NULL,
        has_both_list_mode BOOLEAN NOT NULL,
        has_unassessed_list_mode BOOLEAN NOT NULL,
        llm_patch_watermark BIGINT,
        human_patch_watermark BIGINT,
        both_patch_watermark BIGINT,
        unassessed_patch_watermark BIGINT
      )
    `)
    await database.run(`
      CREATE TABLE mart.review_selected_article_import_staging_v4 (
        staging_row_id VARCHAR NOT NULL,
        project_id VARCHAR NOT NULL,
        project_scope_identity VARCHAR NOT NULL,
        selected_import_snapshot_id VARCHAR NOT NULL,
        article_id VARCHAR NOT NULL,
        import_route_id VARCHAR,
        source_record_key VARCHAR,
        selected_rank_key VARCHAR,
        selected_rank_numeric DOUBLE,
        tombstone BOOLEAN NOT NULL,
        selected_import_updated_at TIMESTAMPTZ NOT NULL,
        projection_identity VARCHAR NOT NULL,
        source_delta_high_water BIGINT NOT NULL,
        source_partition VARCHAR NOT NULL,
        publish_scope_key VARCHAR NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        published_at TIMESTAMPTZ
      )
    `)
    await database.run(`
      CREATE TABLE mart.review_selected_article_import_current_v4 (
        project_id VARCHAR NOT NULL,
        project_scope_identity VARCHAR NOT NULL,
        selected_import_snapshot_id VARCHAR NOT NULL,
        article_id VARCHAR NOT NULL,
        import_route_id VARCHAR,
        source_record_key VARCHAR,
        selected_rank_key VARCHAR,
        selected_rank_numeric DOUBLE,
        tombstone BOOLEAN NOT NULL,
        selected_import_updated_at TIMESTAMPTZ NOT NULL
      )
    `)
    await database.run(`
      CREATE TABLE app.review_selected_article_import_v4 (
        project_id VARCHAR NOT NULL,
        project_scope_identity VARCHAR NOT NULL,
        selected_import_snapshot_id VARCHAR NOT NULL,
        article_id VARCHAR NOT NULL,
        import_route_id VARCHAR,
        source_record_key VARCHAR,
        selected_rank_key VARCHAR,
        selected_rank_numeric DOUBLE,
        tombstone BOOLEAN NOT NULL,
        selected_import_updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY(project_id, project_scope_identity, selected_import_snapshot_id, article_id)
      )
    `)
    await database.run(`
      INSERT INTO app.review_serving_snapshot_manifest
      VALUES (
        'project-1',
        'snapshot-1',
        'selected-import-snapshot-1',
        'review-config-1',
        '{"required":[{"component":"selectedImport","projectionIdentity":"selectedImport:identity-1","baseGeneration":"3"}]}'::JSON,
        'candidate',
        TIMESTAMPTZ '2026-07-24T09:00:00Z'
      )
    `)
    await database.run("INSERT INTO mart.project_scope_article VALUES ('project-1', 'article-1', TRUE, FALSE)")
    await database.run("INSERT INTO mart.project_scope_article VALUES ('project-1', 'article-2', TRUE, FALSE)")
    await database.run("INSERT INTO app.project_import_route VALUES ('project-1', 'import-route-1')")
    await database.run(`
      INSERT INTO app.review_import_article_hot_field
      VALUES (
        'import-route-1',
        'article-1',
        'source-new',
        'rank-new',
        1,
        2026,
        'New Title',
        'New Journal',
        'external-new',
        FALSE,
        FALSE,
        FALSE
      )
    `)
    await database.run(
      "INSERT INTO app.article_import_route VALUES ('current-link-1', 'import-route-1', 'article-1', 'source-new')",
    )
    await database.run(`
      INSERT INTO app.article_import_route_source_record
      VALUES ('import-route-1', 'article-1', 'source-new', '{"covidence":{"citation":{"url":"https://selected.example/article-1"}}}'::JSON, NULL)
    `)
    await database.run(`
      INSERT INTO app.article
      VALUES ('article-1', TIMESTAMPTZ '2026-07-24T07:00:00Z', TIMESTAMPTZ '2026-07-24T08:00:00Z', 'Article 1', 'https://article-1.example')
    `)
    await database.run(`
      INSERT INTO mart.review_selected_article_import_current_v4
      VALUES ('project-1', 'projectScope:identity-1', 'selected-import-snapshot-1', 'article-1', 'route-old', 'source-old', 'rank-old', 5, FALSE, TIMESTAMPTZ '2026-07-24T08:00:00Z')
    `)
    await database.run(`
      INSERT INTO mart.review_selected_article_import_current_v4
      VALUES ('project-1', 'projectScope:identity-1', 'selected-import-snapshot-1', 'article-2', 'route-unchanged', 'source-unchanged', 'rank-unchanged', 2, FALSE, TIMESTAMPTZ '2026-07-24T08:00:00Z')
    `)
    await database.run(`
      INSERT INTO app.review_selected_article_import_v4
      VALUES ('project-1', 'projectScope:identity-1', 'selected-import-snapshot-1', 'article-1', 'route-old', 'source-old', 'rank-old', 5, FALSE, TIMESTAMPTZ '2026-07-24T08:00:00Z')
    `)
    await database.run(`
      INSERT INTO app.review_selected_article_import_v4
      VALUES ('project-1', 'projectScope:identity-1', 'selected-import-snapshot-1', 'article-2', 'route-unchanged', 'source-unchanged', 'rank-unchanged', 2, FALSE, TIMESTAMPTZ '2026-07-24T08:00:00Z')
    `)
    const projectorDatabase: ReviewServingSelectedImportDirtyProjectorDatabase = {
      ...database,
      run: async (statement) => {
        if (
          statement.includes('review_article_serving_base_v4')
          || statement.includes('review_article_serving_list_mode_state_v4')
        ) {
          return
        }

        await database.run(statement)
      },
      transaction: async (operation) => {
        await database.run('BEGIN')

        try {
          const result = await operation(projectorDatabase)
          await database.run('COMMIT')

          return result
        } catch (error) {
          await database.run('ROLLBACK')
          throw error
        }
      },
    }

    await projectReviewServingSelectedImportDirty(
      {...projectDirtyInput([selectedImportClaim()]), acknowledgeClaims: false},
      projectorDatabase,
    )
    await projectReviewServingSelectedImportDirty(
      {...projectDirtyInput([selectedImportClaim()]), acknowledgeClaims: false},
      projectorDatabase,
    )

    const currentRows = await database.queryJson<{
      articleId: string
      importRouteId: string | null
      selectedRankKey: string | null
      sourceRecordKey: string | null
      tombstone: boolean
    }>(`
      SELECT
        article_id AS articleId,
        import_route_id AS importRouteId,
        source_record_key AS sourceRecordKey,
        selected_rank_key AS selectedRankKey,
        tombstone
      FROM mart.review_selected_article_import_current_v4
      ORDER BY article_id
    `)
    const compatibilityRows = await database.queryJson<{
      articleId: string
      importRouteId: string | null
      selectedRankKey: string | null
      sourceRecordKey: string | null
    }>(`
      SELECT
        article_id AS articleId,
        import_route_id AS importRouteId,
        source_record_key AS sourceRecordKey,
        selected_rank_key AS selectedRankKey
      FROM app.review_selected_article_import_v4
      ORDER BY article_id
    `)
    const stagingRows = await database.queryJson<{publishedCount: number; rowCount: number}>(`
      SELECT
        COUNT(*)::INTEGER AS rowCount,
        COUNT(published_at)::INTEGER AS publishedCount
      FROM mart.review_selected_article_import_staging_v4
    `)

    expect(currentRows).toEqual([
      {
        articleId: 'article-1',
        importRouteId: 'import-route-1',
        selectedRankKey: 'rank-new',
        sourceRecordKey: 'source-new',
        tombstone: false,
      },
      {
        articleId: 'article-2',
        importRouteId: 'route-unchanged',
        selectedRankKey: 'rank-unchanged',
        sourceRecordKey: 'source-unchanged',
        tombstone: false,
      },
    ])
    expect(compatibilityRows).toEqual([
      {
        articleId: 'article-1',
        importRouteId: 'import-route-1',
        selectedRankKey: 'rank-new',
        sourceRecordKey: 'source-new',
      },
      {
        articleId: 'article-2',
        importRouteId: 'route-unchanged',
        selectedRankKey: 'rank-unchanged',
        sourceRecordKey: 'source-unchanged',
      },
    ])
    expect(stagingRows).toEqual([{publishedCount: 1, rowCount: 1}])
  } finally {
    close()
  }
})

test('project-scoped selected-import rebuilds include previous serving articles for scope tombstones', async () => {
  const {database, statements} = createSelectedImportDirtyDatabase({dirtyRows: []})

  await projectReviewServingSelectedImportDirty(
    projectDirtyInput([
      selectedImportClaim({
        articleId: null,
        dirtyKind: 'project.reviewConfig.updated',
        scopeId: 'project-1',
        scopeKind: 'project',
      }),
    ]),
    database,
  )
  const selectStatement = statements.find((statement) => {
    return statement.includes('WITH dirty_article(article_id)')
  })

  expect(selectStatement).toContain('FROM mart.project_scope_article scope')
  expect(selectStatement).toContain('UNION')
  expect(selectStatement).toContain('FROM mart.review_article_serving_base_v4 serving')
  expect(selectStatement).toContain('INNER JOIN mart.review_article_serving_list_mode_state_v4 state')
  expect(selectStatement).toContain('state.has_llm_list_mode IS TRUE')
  expect(selectStatement).toContain('state.has_human_list_mode IS TRUE')
  expect(selectStatement).toContain('state.has_both_list_mode IS TRUE')
  expect(selectStatement).toContain('state.has_unassessed_list_mode IS TRUE')
  expect(selectStatement).toContain(
    "json_extract_string(snapshot.composed_identity_json, '$.selectedImport.projectionIdentity') = 'selectedImport:identity-1'",
  )
  expect(selectStatement).not.toContain("serving.selected_import_identity = 'selectedImport:identity-1'")
  expect(selectStatement).toContain("snapshot.selected_import_snapshot_id = 'selected-import-snapshot-1'")
  expectNoCompatibilityServingViewRead(selectStatement ?? '')
})

test('selected-import dirty projection promotes manifest and watermark atomically without unrelated component base generations', async () => {
  const {database, statements} = createSelectedImportDirtyDatabase({dirtyRows: []})

  await projectReviewServingSelectedImportDirty(projectDirtyInput([selectedImportClaim()]), database)

  const joined = statements.join('\n')

  expect(joined).toContain('INSERT INTO app.review_projection_identity_manifest')
  expect(joined).toContain("'selectedImport'")
  expect(joined).toContain('INSERT INTO app.review_serving_dirty_work_ack')
  expect(joined).toContain('INSERT INTO app.review_serving_projector_watermark')
  expect(joined).toContain('WHERE NOT EXISTS')
  expect(joined).not.toContain("'display'")
  expect(joined).not.toContain("'projectScope'")
})

test('selected-import serving insert can seed rows from snapshot templates without existing serving rows', async () => {
  const {database, statements} = createSelectedImportDirtyDatabase({
    dirtyRows: [
      {
        articleId: 'article-1',
        articleTitle: 'Selected Import Title',
        conflictFlag: false,
        duplicateFlag: false,
        externalId: 'selected-external-1',
        importRouteId: 'import-route-1',
        journalTitle: 'Selected Journal',
        publicationYear: 2026,
        selectedRankKey: '0001:article-1',
        selectedRankNumeric: 1,
        sourceRecordKey: 'source-record-1',
        selectedSourceUrl: 'https://selected.example/article-1',
        scopeTombstone: false,
        tombstone: false,
      },
    ],
    snapshotRows: [
      {
        componentStateJson: JSON.stringify({
          optional: [],
          required: [
            {baseGeneration: '3', component: 'display', patchWatermark: '1', projectionIdentity: 'display:identity-1'},
            {
              baseGeneration: '3',
              component: 'projectScope',
              patchWatermark: '1',
              projectionIdentity: 'projectScope:identity-1',
            },
            {
              baseGeneration: '3',
              component: 'selectedImport',
              patchWatermark: '1',
              projectionIdentity: 'selectedImport:identity-1',
            },
            {
              baseGeneration: '3',
              component: 'llmStatus',
              patchWatermark: '1',
              projectionIdentity: 'llmStatus:identity-1',
            },
            {
              baseGeneration: '3',
              component: 'humanStatus',
              patchWatermark: '1',
              projectionIdentity: 'humanStatus:identity-1',
            },
            {baseGeneration: '3', component: 'posting', patchWatermark: '1', projectionIdentity: 'posting:identity-1'},
            {baseGeneration: '3', component: 'summary', patchWatermark: '1', projectionIdentity: 'summary:identity-1'},
            {baseGeneration: '3', component: 'payload', patchWatermark: '1', projectionIdentity: 'payload:identity-1'},
          ],
        }),
        reviewConfigHash: 'review-config-1',
        snapshotId: 'snapshot-1',
      },
    ],
  })

  await projectReviewServingSelectedImportDirty(projectDirtyInput([selectedImportClaim()]), database)

  const servingInsert = statements.find((statement) => {
    return statement.includes('INSERT INTO mart.review_article_serving_base_v4')
  })

  expect(servingInsert).not.toContain('source_metadata')
  expect(servingInsert).toContain('review-config-1')
  expect(servingInsert).toContain('snapshot-1')
  expect(servingInsert).toContain(
    "json_extract_string(snapshot.composed_identity_json, '$.selectedImport.projectionIdentity') = 'selectedImport:identity-1'",
  )
  expect(servingInsert).not.toContain('llmStatus:identity-1')
})

test('selected-import dirty budget is a no-op without legacy runtime patch reads', async () => {
  const {database, statements} = createSelectedImportDirtyDatabase({budgetRow: {dirtyRows: 51, dirtyWatermarks: 3}})

  const result = await checkReviewServingSelectedImportDirtyBudget(
    {
      maxDirtyRows: 50,
      maxDirtyWatermarks: 10,
      projectId: 'project-1',
      projectScopeIdentity: 'projectScope:identity-1',
      selectedImportSnapshotId: 'selected-import-snapshot-1',
    },
    database,
  )

  expect(result).toEqual({dirtyRows: 0, dirtyWatermarks: 0, shouldCompact: false})
  expect(statements.join('\n')).not.toContain('mart.review_selected_import_patch_v4')
})

test('selected-import dirty article-range reset is a no-op without legacy patch rows', async () => {
  const {database, statements} = createSelectedImportDirtyDatabase()

  await resetReviewServingSelectedImportDirtyArticleRange(
    {
      chunkEndArticleId: 'article-099',
      chunkStartArticleId: 'article-050',
      projectId: 'project-1',
      projectScopeIdentity: 'projectScope:identity-1',
      selectedImportSnapshotId: 'selected-import-snapshot-1',
    },
    database,
  )
  const joined = statements.join('\n')

  expect(joined).not.toContain('mart.review_selected_import_patch_v4')
})

test('project-scoped selected-import rebuilds all project scope articles', async () => {
  const {database, statements} = createSelectedImportDirtyDatabase({dirtyRows: []})

  await projectReviewServingSelectedImportDirty(
    projectDirtyInput([
      selectedImportClaim({
        articleId: null,
        dirtyKind: 'project.reviewConfig.updated',
        scopeId: 'project-1',
        scopeKind: 'project',
      }),
    ]),
    database,
  )
  const selectStatement = statements.find((statement) => {
    return statement.includes('WITH dirty_article(article_id)')
  })

  expect(selectStatement).toContain('FROM mart.project_scope_article scope')
  expect(selectStatement).toContain("scope.project_id = 'project-1'")
  expect(selectStatement).not.toContain("VALUES ('project-1')")
})
