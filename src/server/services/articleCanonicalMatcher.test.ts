import {existsSync, unlinkSync} from 'node:fs'

import {expect, test} from 'bun:test'

import {type CanonicalArticleMatcherTx, matchCanonicalArticlesWithTx} from './articleCanonicalMatcher.ts'

const removeFileIfExists = (filePath: string) => {
  if (existsSync(filePath)) {
    unlinkSync(filePath)
  }
}

const getStdoutJson = <T>(stdout: Uint8Array): T => {
  const stdoutLines = Buffer.from(stdout)
    .toString()
    .split('\n')
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line.length > 0
    })

  return JSON.parse(stdoutLines.at(-1) ?? '{}') as T
}

test('matchCanonicalArticlesWithTx reuses existing identifiers and collapses duplicate batch identifiers', async () => {
  const duckdbPath = `/tmp/forska-article-canonical-matcher-${Date.now()}.duckdb`
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const [{migrateDuckdb}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}, {getAppDatabaseService}, {matchCanonicalArticlesWithTx}] = await Promise.all([
          import('./src/db/migrateDuckdb.ts'),
          import('./src/server/utils/duckdbService.ts'),
          import('./src/server/utils/serverRuntimeRole.ts'),
          import('./src/server/services/appDatabaseService.ts'),
          import('./src/server/services/articleCanonicalMatcher.ts'),
        ])

        resetDuckdbServiceForTests()
        resetServerRuntimeRoleForTests()
        await migrateDuckdb()

        const database = getAppDatabaseService()

        await database.run("INSERT INTO app.article (id, article_title, article_id) VALUES ('existing-article', 'Existing title', NULL)")
        await database.run("INSERT INTO app.article_identifier (id, article_id, kind, normalized_value, source) VALUES ('existing-doi', 'existing-article', 'doi', '10.1000/existing', 'test')")

        const candidates = [
          {
            articleTitle: 'Existing update candidate',
            candidateId: 'candidate-existing',
            importRoute: 'structured-file:matcher',
            sourceKind: 'structured_file',
            sourceRecordKey: 'source-existing',
            strongIdentifiers: [
              {kind: 'doi', normalizedValue: '10.1000/existing', source: 'test'},
              {kind: 'pmid', normalizedValue: '555', source: 'test'},
            ],
          },
          {
            articleTitle: 'Created duplicate title',
            candidateId: 'candidate-new-a',
            importRoute: 'structured-file:matcher',
            sourceKind: 'structured_file',
            sourceRecordKey: 'source-new-a',
            strongIdentifiers: [{kind: 'doi', normalizedValue: '10.1000/new', source: 'test'}],
          },
          {
            articleTitle: 'Created duplicate title',
            candidateId: 'candidate-new-b',
            importRoute: 'structured-file:matcher',
            sourceKind: 'structured_file',
            sourceRecordKey: 'source-new-b',
            strongIdentifiers: [{kind: 'doi', normalizedValue: '10.1000/new', source: 'test'}],
          },
          {
            articleTitle: 'No identifier title',
            candidateId: 'candidate-unresolved',
            importRoute: 'structured-file:matcher',
            sourceKind: 'structured_file',
            sourceRecordKey: 'source-unresolved',
            strongIdentifiers: [],
          },
        ]

        const matchResult = await database.transaction(async (tx) => {
          return await matchCanonicalArticlesWithTx(tx, candidates)
        })
        const articleRows = await database.queryJson(
          "SELECT id, article_id AS legacyArticleId, article_title AS articleTitle FROM app.article ORDER BY id ASC"
        )
        const identifierRows = await database.queryJson(
          "SELECT article_id AS articleId, kind, normalized_value AS normalizedValue FROM app.article_identifier ORDER BY kind ASC, normalized_value ASC, article_id ASC"
        )
        const [quarantineCountRow] = await database.queryJson(
          "SELECT COUNT(*)::INTEGER AS count FROM app.article_canonical_match_quarantine"
        )

        console.log(JSON.stringify({articleRows, identifierRows, matchResult, quarantineCountRow}))
        await database.close()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '39991',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '39992',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'Failed to match canonical articles')
    }

    const parsed = getStdoutJson<{
      articleRows: Array<{articleTitle: string; id: string; legacyArticleId: string | null}>
      identifierRows: Array<{articleId: string; kind: string; normalizedValue: string}>
      matchResult: {
        instrumentation: {strongIdentifierLookupStatements: string[]}
        outcomes: Array<{articleId?: string; candidateId: string; reason?: string; status: string}>
      }
      quarantineCountRow: {count: number}
    }>(result.stdout)
    const outcomeByCandidateId = new Map(
      parsed.matchResult.outcomes.map((outcome) => {
        return [outcome.candidateId, outcome]
      }),
    )
    const newA = outcomeByCandidateId.get('candidate-new-a')
    const newB = outcomeByCandidateId.get('candidate-new-b')

    expect(outcomeByCandidateId.get('candidate-existing')).toMatchObject({
      articleId: 'existing-article',
      status: 'reuse',
    })
    expect(newA?.status).toBe('create')
    expect(newB?.status).toBe('create')
    expect(newA?.articleId).toBe(newB?.articleId)
    expect(outcomeByCandidateId.get('candidate-unresolved')).toMatchObject({
      reason: 'no-strong-identifiers',
      status: 'unresolved',
    })
    expect(parsed.articleRows).toHaveLength(2)
    expect(
      parsed.articleRows.every((row) => {
        return row.legacyArticleId === null
      }),
    ).toBe(true)
    expect(parsed.identifierRows).toEqual([
      {articleId: 'existing-article', kind: 'doi', normalizedValue: '10.1000/existing'},
      {articleId: newA?.articleId ?? '', kind: 'doi', normalizedValue: '10.1000/new'},
      {articleId: 'existing-article', kind: 'pmid', normalizedValue: '555'},
    ])
    expect(parsed.quarantineCountRow.count).toBe(0)
    expect(parsed.matchResult.instrumentation.strongIdentifierLookupStatements).toHaveLength(2)
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('matchCanonicalArticlesWithTx leaves conflicting existing strong identifiers unresolved and records quarantine', async () => {
  const duckdbPath = `/tmp/forska-article-canonical-matcher-conflict-${Date.now()}.duckdb`
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const [{migrateDuckdb}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}, {getAppDatabaseService}, {matchCanonicalArticlesWithTx}] = await Promise.all([
          import('./src/db/migrateDuckdb.ts'),
          import('./src/server/utils/duckdbService.ts'),
          import('./src/server/utils/serverRuntimeRole.ts'),
          import('./src/server/services/appDatabaseService.ts'),
          import('./src/server/services/articleCanonicalMatcher.ts'),
        ])

        resetDuckdbServiceForTests()
        resetServerRuntimeRoleForTests()
        await migrateDuckdb()

        const database = getAppDatabaseService()

        await database.run("INSERT INTO app.article (id, article_title, article_id) VALUES ('article-a', 'Article A', NULL), ('article-b', 'Article B', NULL)")
        await database.run("INSERT INTO app.article_identifier (id, article_id, kind, normalized_value, source) VALUES ('doi-a', 'article-a', 'doi', '10.1000/conflict', 'test'), ('pmid-b', 'article-b', 'pmid', '777', 'test')")

        const matchResult = await database.transaction(async (tx) => {
          return await matchCanonicalArticlesWithTx(tx, [
            {
              articleTitle: 'Conflicted article',
              candidateId: 'candidate-conflict',
              importRoute: 'structured-file:matcher',
              sourceKind: 'structured_file',
              sourceRecordKey: 'source-conflict',
              strongIdentifiers: [
                {kind: 'doi', normalizedValue: '10.1000/conflict', source: 'test'},
                {kind: 'pmid', normalizedValue: '777', source: 'test'},
              ],
            },
          ])
        })
        const articleRows = await database.queryJson("SELECT id FROM app.article ORDER BY id ASC")
        const quarantineRows = await database.queryJson(
          "SELECT kind, normalized_value AS normalizedValue, reason, source_record_key AS sourceRecordKey, winning_article_id AS winningArticleId FROM app.article_canonical_match_quarantine ORDER BY kind ASC"
        )

        console.log(JSON.stringify({articleRows, matchResult, quarantineRows}))
        await database.close()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '39991',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '39992',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.toString() || result.stdout.toString() || 'Failed to verify canonical match conflict handling',
      )
    }

    const parsed = getStdoutJson<{
      articleRows: Array<{id: string}>
      matchResult: {
        instrumentation: {strongIdentifierLookupStatements: string[]}
        outcomes: Array<{candidateId: string; reason?: string; status: string}>
      }
      quarantineRows: Array<{
        kind: string
        normalizedValue: string
        reason: string
        sourceRecordKey: string
        winningArticleId: string
      }>
    }>(result.stdout)
    const lookupStatements = parsed.matchResult.instrumentation.strongIdentifierLookupStatements

    expect(parsed.articleRows).toEqual([{id: 'article-a'}, {id: 'article-b'}])
    expect(parsed.matchResult.outcomes).toEqual([
      {
        candidateId: 'candidate-conflict',
        identifiers: [
          {evidence: [], kind: 'doi', normalizedValue: '10.1000/conflict', source: 'test'},
          {evidence: [], kind: 'pmid', normalizedValue: '777', source: 'test'},
        ],
        metadata: {candidateIds: ['candidate-conflict'], matchedArticleIds: ['article-a', 'article-b']},
        reason: 'conflicting-existing-strong-identifiers',
        status: 'unresolved',
      },
    ])
    expect(parsed.quarantineRows).toEqual([
      {
        kind: 'doi',
        normalizedValue: '10.1000/conflict',
        reason: 'conflicting-existing-strong-identifiers',
        sourceRecordKey: 'source-conflict',
        winningArticleId: 'article-a',
      },
      {
        kind: 'pmid',
        normalizedValue: '777',
        reason: 'conflicting-existing-strong-identifiers',
        sourceRecordKey: 'source-conflict',
        winningArticleId: 'article-b',
      },
    ])
    expect(
      lookupStatements.every((statement) => {
        return statement.includes('FROM app.article_identifier')
      }),
    ).toBe(true)
    expect(
      lookupStatements.some((statement) => {
        return statement.includes('FROM app.article ')
      }),
    ).toBe(false)
    expect(
      lookupStatements.some((statement) => {
        return statement.includes('original_data')
      }),
    ).toBe(false)
    expect(
      lookupStatements.some((statement) => {
        return statement.includes('source_metadata')
      }),
    ).toBe(false)
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('matchCanonicalArticlesWithTx reuses existing source-record matches for unidentified candidates', async () => {
  const duckdbPath = `/tmp/forska-article-canonical-matcher-unidentified-${Date.now()}.duckdb`
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const [{migrateDuckdb}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}, {getAppDatabaseService}, {matchCanonicalArticlesWithTx}] = await Promise.all([
          import('./src/db/migrateDuckdb.ts'),
          import('./src/server/utils/duckdbService.ts'),
          import('./src/server/utils/serverRuntimeRole.ts'),
          import('./src/server/services/appDatabaseService.ts'),
          import('./src/server/services/articleCanonicalMatcher.ts'),
        ])

        resetDuckdbServiceForTests()
        resetServerRuntimeRoleForTests()
        await migrateDuckdb()

        const database = getAppDatabaseService()

        await database.run("INSERT INTO app.import_route (id, route, name) VALUES ('route-unidentified', 'covidence:unidentified', 'Covidence unidentified')")
        await database.run("INSERT INTO app.article (id, article_title, article_id) VALUES ('existing-unidentified-article', 'Existing unidentified title', NULL)")
        await database.run("INSERT INTO app.article_import_route_source_record (id, article_id, import_route_id, external_article_id, source_record_key, source_record_hash) VALUES ('source-record-unidentified', 'existing-unidentified-article', 'route-unidentified', 'covidence:unidentified:1', 'covidence:1', 'hash-1')")

        const matchResult = await database.transaction(async (tx) => {
          return await matchCanonicalArticlesWithTx(tx, [
            {
              allowUnidentifiedCreate: true,
              articleTitle: 'Reimported unidentified title',
              candidateId: 'candidate-unidentified',
              importRoute: 'covidence:unidentified',
              sourceKind: 'covidence',
              sourceRecordKey: 'covidence:1',
              strongIdentifiers: [],
            },
          ])
        })
        const articleRows = await database.queryJson("SELECT id FROM app.article ORDER BY id ASC")

        console.log(JSON.stringify({articleRows, matchResult}))
        await database.close()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '39991',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '39992',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.toString() || result.stdout.toString() || 'Failed to verify unidentified canonical reuse',
      )
    }

    const parsed = getStdoutJson<{
      articleRows: Array<{id: string}>
      matchResult: {outcomes: Array<{articleId?: string; candidateId: string; status: string}>}
    }>(result.stdout)

    expect(parsed.articleRows).toEqual([{id: 'existing-unidentified-article'}])
    expect(parsed.matchResult.outcomes).toEqual([
      {
        articleId: 'existing-unidentified-article',
        candidateId: 'candidate-unidentified',
        identifiers: [],
        status: 'reuse',
      },
    ])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('matchCanonicalArticlesWithTx re-reads winning identifiers after insert conflicts', async () => {
  const runStatements: string[] = []
  const lookupStatements: string[] = []
  const tx = {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      lookupStatements.push(statement)

      return lookupStatements.length === 1
        ? []
        : ([{articleId: 'winning-article', kind: 'doi', normalizedValue: '10.1000/race'}] as T[])
    },
    run: async (statement: string) => {
      runStatements.push(statement)
    },
  } satisfies CanonicalArticleMatcherTx

  const result = await matchCanonicalArticlesWithTx(tx, [
    {
      articleTitle: 'Race article',
      candidateId: 'candidate-race',
      sourceKind: 'structured_file',
      sourceRecordKey: 'source-race',
      strongIdentifiers: [{kind: 'doi', normalizedValue: '10.1000/race', source: 'test'}],
    },
  ])

  const outcome = result.outcomes[0]

  expect(outcome).toMatchObject({
    candidateId: 'candidate-race',
    identifiers: [{evidence: [], kind: 'doi', normalizedValue: '10.1000/race', source: 'test'}],
    reason: 'identifier-insert-conflict',
    status: 'unresolved',
  })

  if (outcome?.status === 'unresolved') {
    const metadata = outcome.metadata as {
      conflicts: Array<{
        groupId: string
        identifier: {evidence: unknown[]; kind: string; normalizedValue: string; source: string}
        requestedArticleId: string
        winningArticleId: string
      }>
      requestedArticleId: string
    }

    expect(typeof metadata.requestedArticleId).toBe('string')
    expect(metadata.conflicts).toEqual([
      {
        groupId: 'candidate-race',
        identifier: {evidence: [], kind: 'doi', normalizedValue: '10.1000/race', source: 'test'},
        requestedArticleId: metadata.requestedArticleId,
        winningArticleId: 'winning-article',
      },
    ])
  }
  expect(result.instrumentation.identifierConflictRereadStatements).toHaveLength(1)
  expect(
    runStatements.some((statement) => {
      return statement.includes('INSERT INTO app.article_canonical_match_quarantine')
    }),
  ).toBe(true)
})

test('matchCanonicalArticlesWithTx keeps conflicted created articles with child references', async () => {
  const duckdbPath = `/tmp/forska-article-canonical-matcher-referenced-conflict-${Date.now()}.duckdb`
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const [{migrateDuckdb}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}, {getAppDatabaseService}, {matchCanonicalArticlesWithTx}] = await Promise.all([
          import('./src/db/migrateDuckdb.ts'),
          import('./src/server/utils/duckdbService.ts'),
          import('./src/server/utils/serverRuntimeRole.ts'),
          import('./src/server/services/appDatabaseService.ts'),
          import('./src/server/services/articleCanonicalMatcher.ts'),
        ])

        resetDuckdbServiceForTests()
        resetServerRuntimeRoleForTests()
        await migrateDuckdb()

        const database = getAppDatabaseService()

        const matchResult = await database.transaction(async (tx) => {
          let injected = false
          const wrappedTx = {
            queryJson: tx.queryJson.bind(tx),
            run: async (statement) => {
              await tx.run(statement)

              if (!injected && statement.includes('INSERT INTO app.article (')) {
                injected = true

                const [createdArticle] = await tx.queryJson(
                  "SELECT id FROM app.article WHERE article_title = 'Race cleanup article' LIMIT 1"
                )

                await tx.run("INSERT INTO app.article (id, article_title, article_id) VALUES ('winning-article', 'Winning article', NULL)")
                await tx.run("INSERT INTO app.article_identifier (id, article_id, kind, normalized_value, source) VALUES ('winning-identifier', 'winning-article', 'doi', '10.1000/race-cleanup', 'test')")
                await tx.run("INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled) VALUES ('cleanup-model', 'provider-connection-1', 'Cleanup Model', 'cleanup-model', 'Cleanup Model', 'manual', TRUE)")
                await tx.run("INSERT INTO app.project (id, name, model_id) VALUES ('cleanup-project', 'Cleanup Project', 'cleanup-model')")
                await tx.run("INSERT INTO app.project_article (id, project_id, article_id) VALUES ('cleanup-project-article', 'cleanup-project', '" + createdArticle.id + "')")
              }
            },
          }

          return await matchCanonicalArticlesWithTx(wrappedTx, [
            {
              articleTitle: 'Race cleanup article',
              candidateId: 'candidate-race-cleanup',
              sourceKind: 'covidence',
              sourceRecordKey: 'source-race-cleanup',
              strongIdentifiers: [{kind: 'doi', normalizedValue: '10.1000/race-cleanup', source: 'test'}],
            },
          ])
        })
        const articleRows = await database.queryJson(
          "SELECT id, article_title AS articleTitle FROM app.article ORDER BY article_title ASC"
        )
        const identifierRows = await database.queryJson(
          "SELECT article_id AS articleId, kind, normalized_value AS normalizedValue FROM app.article_identifier ORDER BY article_id ASC"
        )
        const projectArticleRows = await database.queryJson(
          "SELECT article_id AS articleId FROM app.project_article ORDER BY article_id ASC"
        )
        const quarantineRows = await database.queryJson(
          "SELECT requested_article_id AS requestedArticleId, winning_article_id AS winningArticleId, reason FROM app.article_canonical_match_quarantine ORDER BY requested_article_id ASC"
        )

        console.log(JSON.stringify({articleRows, identifierRows, matchResult, projectArticleRows, quarantineRows}))
        await database.close()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '39991',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '39992',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.toString() || result.stdout.toString() || 'Failed to verify referenced conflict cleanup',
      )
    }

    const parsed = getStdoutJson<{
      articleRows: Array<{articleTitle: string; id: string}>
      identifierRows: Array<{articleId: string; kind: string; normalizedValue: string}>
      matchResult: {
        outcomes: Array<{candidateId: string; metadata?: {requestedArticleId: string}; reason?: string; status: string}>
      }
      projectArticleRows: Array<{articleId: string}>
      quarantineRows: Array<{reason: string; requestedArticleId: string; winningArticleId: string}>
    }>(result.stdout)
    const outcome = parsed.matchResult.outcomes[0]
    const referencedArticleId = parsed.projectArticleRows[0]?.articleId

    expect(outcome).toMatchObject({
      candidateId: 'candidate-race-cleanup',
      reason: 'identifier-insert-conflict',
      status: 'unresolved',
    })
    expect(outcome?.metadata?.requestedArticleId).toBe(referencedArticleId)
    expect(parsed.articleRows).toEqual([
      {articleTitle: 'Race cleanup article', id: referencedArticleId ?? ''},
      {articleTitle: 'Winning article', id: 'winning-article'},
    ])
    expect(parsed.identifierRows).toEqual([
      {articleId: 'winning-article', kind: 'doi', normalizedValue: '10.1000/race-cleanup'},
    ])
    expect(parsed.quarantineRows).toEqual([
      {
        reason: 'identifier-insert-conflict',
        requestedArticleId: referencedArticleId ?? '',
        winningArticleId: 'winning-article',
      },
    ])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('matchCanonicalArticlesWithTx returns unresolved outcomes for oversized batches without writes', async () => {
  const tx = {
    queryJson: async <T>(): Promise<T[]> => {
      return []
    },
    run: async () => {},
  } satisfies CanonicalArticleMatcherTx
  const result = await matchCanonicalArticlesWithTx(
    tx,
    [
      {articleTitle: 'A', candidateId: 'a', strongIdentifiers: [{kind: 'doi', normalizedValue: '10.1000/a'}]},
      {articleTitle: 'B', candidateId: 'b', strongIdentifiers: [{kind: 'doi', normalizedValue: '10.1000/b'}]},
    ],
    {maxBatchSize: 1},
  )

  expect(result.outcomes).toEqual([
    {
      candidateId: 'a',
      identifiers: [{evidence: [], kind: 'doi', normalizedValue: '10.1000/a', source: null}],
      metadata: {batchSize: 2, maxBatchSize: 1},
      reason: 'batch-too-large',
      status: 'unresolved',
    },
    {
      candidateId: 'b',
      identifiers: [{evidence: [], kind: 'doi', normalizedValue: '10.1000/b', source: null}],
      metadata: {batchSize: 2, maxBatchSize: 1},
      reason: 'batch-too-large',
      status: 'unresolved',
    },
  ])
})
