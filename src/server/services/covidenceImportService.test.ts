import {createHash} from 'node:crypto'
import {existsSync, unlinkSync} from 'node:fs'
import path from 'node:path'

import {afterEach, expect, test} from 'bun:test'

import {
  analyzeCovidencePackageFiles,
  buildCovidencePackageConfig,
  buildCovidencePromptDefinition,
  deleteCovidencePackageFiles,
  getCovidencePackageConfig,
  getCovidencePackageCursor,
  getCovidencePackageFileContent,
  mergeCovidenceReferenceRows,
  parseCovidenceCsvReferenceRows,
  parseCovidenceReferenceRows,
  storeCovidencePackageFiles,
} from './covidenceImportService.ts'

const datasourceIdsToDelete = new Set<string>()
const getCovidenceFallbackHash = (value: string) => {
  return createHash('sha256').update(value).digest('hex')
}

afterEach(() => {
  Array.from(datasourceIdsToDelete).map((datasourceId) => {
    deleteCovidencePackageFiles(datasourceId)
    return datasourceId
  })
  datasourceIdsToDelete.clear()
})

test('Covidence package config round-trips with one format for both modes', () => {
  const titleAbstractConfig = buildCovidencePackageConfig({
    files: [
      {
        assetPath: 'assets/covidence_imports/ds-1/all-all.csv',
        fileRole: 'all',
        format: 'csv',
        sourceFileName: 'all.csv',
      },
      {
        assetPath: 'assets/covidence_imports/ds-1/irrelevant-irrelevant.csv',
        fileRole: 'irrelevant',
        format: 'csv',
        sourceFileName: 'irrelevant.csv',
      },
      {
        assetPath: 'assets/covidence_imports/ds-1/full_text-full_text.ris',
        fileRole: 'full_text',
        format: 'ris',
        sourceFileName: 'full_text.ris',
      },
    ],
    mode: 'title_abstract',
  })
  const fullTextConfig = buildCovidencePackageConfig({
    files: [
      {
        assetPath: 'assets/covidence_imports/ds-2/all-all.csv',
        fileRole: 'all',
        format: 'csv',
        sourceFileName: 'all.csv',
      },
      {
        assetPath: 'assets/covidence_imports/ds-2/irrelevant-irrelevant.csv',
        fileRole: 'irrelevant',
        format: 'csv',
        sourceFileName: 'irrelevant.csv',
      },
      {
        assetPath: 'assets/covidence_imports/ds-2/full_text-full_text.ris',
        fileRole: 'full_text',
        format: 'ris',
        sourceFileName: 'full_text.ris',
      },
      {
        assetPath: 'assets/covidence_imports/ds-2/excluded-excluded.csv',
        fileRole: 'excluded',
        format: 'csv',
        sourceFileName: 'excluded.csv',
      },
      {
        assetPath: 'assets/covidence_imports/ds-2/included-included.csv',
        fileRole: 'included',
        format: 'csv',
        sourceFileName: 'included.csv',
      },
    ],
    mode: 'full_text',
  })

  expect(getCovidencePackageConfig(getCovidencePackageCursor(titleAbstractConfig))).toEqual(titleAbstractConfig)
  expect(getCovidencePackageConfig(getCovidencePackageCursor(fullTextConfig))).toEqual(fullTextConfig)
  expect(
    getCovidencePackageConfig(
      JSON.stringify({
        files: [
          {
            assetPath: 'assets/covidence_imports/ds-3/excluded.csv',
            fileRole: 'excluded',
            format: 'csv',
            sourceFileName: 'excluded.csv',
          },
        ],
        kind: 'covidence_import',
        mode: 'title_abstract',
        version: 1,
      }),
    ),
  ).toBeNull()
})

test('storeCovidencePackageFiles saves package files beneath the datasource folder and reads them back', async () => {
  const datasourceId = `covidence-test-${Date.now()}`
  datasourceIdsToDelete.add(datasourceId)
  const storedFiles = await storeCovidencePackageFiles({
    datasourceId,
    files: [
      {file: new File(['alpha,beta\n1,2\n'], 'all references.csv', {type: 'text/csv'}), fileRole: 'all'},
      {
        file: new File(['TY  - JOUR\nTI  - Example\nER  - \n'], 'full text.ris', {
          type: 'application/x-research-info-systems',
        }),
        fileRole: 'full_text',
      },
      {file: new File(['alpha,beta\n3,4\n'], 'irrelevant.csv', {type: 'text/csv'}), fileRole: 'irrelevant'},
    ],
  })

  expect(storedFiles).toHaveLength(3)
  expect(
    storedFiles.map((file) => {
      return file.assetPath
    }),
  ).toEqual([
    `assets/covidence_imports/${datasourceId}/all-all-references.csv`,
    `assets/covidence_imports/${datasourceId}/full_text-full-text.ris`,
    `assets/covidence_imports/${datasourceId}/irrelevant-irrelevant.csv`,
  ])
  expect(
    storedFiles.map((file) => {
      return file.format
    }),
  ).toEqual(['csv', 'ris', 'csv'])
  const firstStoredFile = storedFiles[0]
  const secondStoredFile = storedFiles[1]

  if (!firstStoredFile || !secondStoredFile) {
    throw new Error('Expected stored Covidence files')
  }

  expect(getCovidencePackageFileContent(firstStoredFile.assetPath)).toContain('alpha,beta')
  expect(getCovidencePackageFileContent(secondStoredFile.assetPath)).toContain('TY  - JOUR')
  expect(() => {
    getCovidencePackageFileContent(`assets/covidence_imports/${datasourceId}/../escape.csv`)
  }).toThrow('Invalid Covidence package asset path')
})

test('deleteCovidencePackageFiles removes the datasource package folder', async () => {
  const datasourceId = `covidence-test-delete-${Date.now()}`
  const storedFiles = await storeCovidencePackageFiles({
    datasourceId,
    files: [
      {file: new File(['alpha,beta\n1,2\n'], 'all.csv', {type: 'text/csv'}), fileRole: 'all'},
      {file: new File(['alpha,beta\n3,4\n'], 'irrelevant.csv', {type: 'text/csv'}), fileRole: 'irrelevant'},
      {
        file: new File(['TY  - JOUR\nTI  - Example\nER  - \n'], 'full_text.ris', {
          type: 'application/x-research-info-systems',
        }),
        fileRole: 'full_text',
      },
    ],
  })

  deleteCovidencePackageFiles(datasourceId)

  const firstStoredFile = storedFiles[0]

  if (!firstStoredFile) {
    throw new Error('Expected stored Covidence file')
  }

  expect(existsSync(path.resolve(process.cwd(), firstStoredFile.assetPath))).toBe(false)
})

test('Covidence prompt definition builds stage-specific text and reuses matching prompts', async () => {
  expect(
    buildCovidencePromptDefinition({
      answerSet: 'yes|no|unsure',
      exclusionCriteria: 'Case reports\nEditorials',
      inclusionCriteria: 'Adults with confirmed disease',
      mode: 'title_abstract',
    }),
  ).toEqual({
    originalText: [
      'Based on the inclusion and exclusion criteria, should this study be included for full text review?',
      '',
      'Allowed answers: yes, no, unsure',
      '',
      'Inclusion:',
      'Adults with confirmed disease',
      '',
      'Exclusion:',
      'Case reports\nEditorials',
    ].join('\n'),
    promptHeading: 'Covidence title/abstract screening',
    type: "'yes' | 'no' | 'unsure'",
  })

  expect(
    buildCovidencePromptDefinition({
      answerSet: 'yes|no',
      exclusionCriteria: 'Animal studies',
      inclusionCriteria: 'Randomized trials',
      mode: 'full_text',
    }),
  ).toEqual({
    originalText: [
      'Based on the inclusion and exclusion criteria, should this study be included in the final review?',
      '',
      'Allowed answers: yes, no',
      '',
      'Inclusion:',
      'Randomized trials',
      '',
      'Exclusion:',
      'Animal studies',
    ].join('\n'),
    promptHeading: 'Covidence full-text screening',
    type: "'yes' | 'no'",
  })

  const duckdbPath = `/tmp/f1-covidence-prompt-${Date.now()}.duckdb`
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const [{migrateDuckdb}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}, {getAppDatabaseService}, covidenceImportService, {getSqlLiteral}, {computePromptContentHash}] = await Promise.all([
          import('./src/db/migrateDuckdb.ts'),
          import('./src/server/utils/duckdbService.ts'),
          import('./src/server/utils/serverRuntimeRole.ts'),
          import('./src/server/services/appDatabaseService.ts'),
          import('./src/server/services/covidenceImportService.ts'),
          import('./src/server/services/appQueryHelpers.ts'),
          import('./src/server/utils/computePromptContentHash.ts'),
        ])

        resetDuckdbServiceForTests()
        resetServerRuntimeRoleForTests()
        await migrateDuckdb()

        const database = getAppDatabaseService()
        const definition = covidenceImportService.buildCovidencePromptDefinition({
          answerSet: 'yes|no|unsure',
          exclusionCriteria: 'Case reports',
          inclusionCriteria: 'Adults with confirmed disease',
          mode: 'title_abstract',
        })
        const contentHash = computePromptContentHash(definition.originalText, null, definition.promptHeading, definition.type)

        await database.run(\`
          INSERT INTO app.prompt (id, original_text, transformed_text, prompt_heading, type, content_hash, archived)
          VALUES (
            'prompt-existing',
            \${getSqlLiteral(definition.originalText)},
            NULL,
            \${getSqlLiteral(definition.promptHeading)},
            \${getSqlLiteral(definition.type)},
            \${getSqlLiteral(contentHash)},
            FALSE
          )
        \`)

        const reusedPrompt = await covidenceImportService.getOrCreateCovidencePrompt({
          answerSet: 'yes|no|unsure',
          exclusionCriteria: 'Case reports',
          inclusionCriteria: 'Adults with confirmed disease',
          mode: 'title_abstract',
        })
        const createdPrompt = await covidenceImportService.getOrCreateCovidencePrompt({
          answerSet: 'yes|no',
          exclusionCriteria: 'Case reports',
          inclusionCriteria: 'Adults with confirmed disease',
          mode: 'title_abstract',
        })
        const promptRows = await database.queryJson(\`
          SELECT id, prompt_heading AS promptHeading, type, original_text AS originalText
          FROM app.prompt
          ORDER BY created_at ASC, id ASC
        \`)

        console.log(JSON.stringify({createdPrompt, promptRows, reusedPrompt}))
        await database.close()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '39995',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '39996',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.toString() || result.stdout.toString() || 'Failed to create or reuse Covidence prompt',
      )
    }

    const stdoutLines = result.stdout
      .toString()
      .split('\n')
      .map((line) => {
        return line.trim()
      })
      .filter((line) => {
        return line.length > 0
      })
    const parsed = JSON.parse(stdoutLines.at(-1) ?? '{}') as {
      createdPrompt: {created: boolean; id: string; type: string}
      promptRows: Array<{id: string; originalText: string; promptHeading: string; type: string}>
      reusedPrompt: {created: boolean; id: string; type: string}
    }

    expect(parsed.reusedPrompt).toMatchObject({
      created: false,
      id: 'prompt-existing',
      promptHeading: 'Covidence title/abstract screening',
      type: "'yes' | 'no' | 'unsure'",
    })
    expect(parsed.createdPrompt.created).toBe(true)
    expect(parsed.createdPrompt.id).not.toBe('prompt-existing')
    expect(parsed.createdPrompt.type).toBe("'yes' | 'no'")
    expect(parsed.promptRows).toHaveLength(2)
    expect(parsed.promptRows[0]?.id).toBe('prompt-existing')
    expect(parsed.promptRows[1]?.promptHeading).toBe('Covidence title/abstract screening')
  } finally {
    ;[duckdbPath, `${duckdbPath}.wal`, `${duckdbPath}.writer.lock`, `${duckdbPath}.writer.history.json`].map(
      (filePath) => {
        if (existsSync(filePath)) {
          unlinkSync(filePath)
        }

        return filePath
      },
    )
  }
})

test('importCovidencePackageFromConfig stores merged articles with raw metadata on the Covidence route', async () => {
  const duckdbPath = `/tmp/f1-covidence-import-${Date.now()}.duckdb`
  const datasourceId = `covidence-import-${Date.now()}`
  const importRoute = `covidence:${datasourceId}`
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const [{migrateDuckdb}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}, {getAppDatabaseService}, covidenceImportService] = await Promise.all([
          import('./src/db/migrateDuckdb.ts'),
          import('./src/server/utils/duckdbService.ts'),
          import('./src/server/utils/serverRuntimeRole.ts'),
          import('./src/server/services/appDatabaseService.ts'),
          import('./src/server/services/covidenceImportService.ts'),
        ])

        resetDuckdbServiceForTests()
        resetServerRuntimeRoleForTests()
        await migrateDuckdb()

        const database = getAppDatabaseService()
        const datasourceId = ${JSON.stringify(datasourceId)}
        const importRoute = 'covidence:' + datasourceId
        const createConfig = async (allContent, irrelevantContent) => {
          const files = await covidenceImportService.storeCovidencePackageFiles({
            datasourceId,
            files: [
              {file: new File([allContent], 'all.csv', {type: 'text/csv'}), fileRole: 'all'},
              {file: new File([irrelevantContent], 'irrelevant.csv', {type: 'text/csv'}), fileRole: 'irrelevant'},
              {file: new File(['Title,Authors,Year,DOI\\nStudy A,"Doe, Jane",2024,10.1000/alpha\\n'], 'full_text.csv', {type: 'text/csv'}), fileRole: 'full_text'},
            ],
          })

          return covidenceImportService.buildCovidencePackageConfig({files, mode: 'title_abstract'})
        }

        const config = await createConfig(
          'Title,Authors,Abstract,Year,DOI,Tags,Notes\\nStudy A,"Doe, Jane",Summary A,2024,10.1000/alpha,tag-a,first note\\nStudy B,"Roe, John",Summary B,2023,10.1000/beta,tag-b,second note\\n',
          'Title,Authors,Year,DOI\\nStudy B,"Roe, John",2023,10.1000/beta\\n',
        )

        await database.transaction(async (tx) => {
          await covidenceImportService.importCovidencePackageFromConfig({config, datasourceId, importRoute, tx})
        })

        const articles = await database.queryJson(\`
          SELECT
            article_id AS articleId,
            article_title AS articleTitle,
            article_summary AS articleSummary,
            doi,
            pubmed_id AS pubmedId,
            TO_JSON(original_data) AS originalData,
            TO_JSON(source_metadata) AS sourceMetadata
          FROM app.article
          WHERE article_id LIKE '${importRoute}:%'
          ORDER BY article_id
        \`)
        const linkedArticles = await database.queryJson(\`
          SELECT COUNT(*)::INTEGER AS count
          FROM app.article_import_route air
          INNER JOIN app.import_route ir ON ir.id = air.import_route_id
          WHERE ir.route = '${importRoute}'
        \`)
        const normalizedArticles = articles.map((article) => {
          return {
            ...article,
            originalData: typeof article.originalData === 'string' ? JSON.parse(article.originalData) : article.originalData,
            sourceMetadata:
              typeof article.sourceMetadata === 'string' ? JSON.parse(article.sourceMetadata) : article.sourceMetadata,
          }
        })

        console.log(JSON.stringify({articles: normalizedArticles, linkedArticles}))
        covidenceImportService.deleteCovidencePackageFiles(datasourceId)
        await database.close()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '39993',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '39994',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'Failed to import Covidence package')
    }

    const stdoutLines = result.stdout
      .toString()
      .split('\n')
      .map((line) => {
        return line.trim()
      })
      .filter((line) => {
        return line.length > 0
      })
    const parsed = JSON.parse(stdoutLines.at(-1) ?? '{}') as {
      articles: Array<{
        articleId: string
        articleSummary: string | null
        articleTitle: string
        doi: string | null
        originalData: {covidence: {citation: {title: string}; sourceRows: Array<{sourceFileName: string}>}}
        pubmedId: string | null
        sourceMetadata: {covidence: {mode: string; stageMembership: Record<string, boolean>}}
      }>
      linkedArticles: Array<{count: number}>
    }

    expect(parsed.articles).toHaveLength(2)
    expect(parsed.linkedArticles[0]?.count).toBe(2)
    expect(parsed.articles[0]?.articleId).toContain(`${importRoute}:`)
    expect(parsed.articles[0]?.articleTitle).toBe('Study A')
    expect(parsed.articles[0]?.articleSummary).toBe('Summary A')
    expect(parsed.articles[0]?.doi).toBe('10.1000/alpha')
    expect(parsed.articles[0]?.originalData.covidence.citation.title).toBe('Study A')
    expect(parsed.articles[0]?.originalData.covidence.sourceRows).toHaveLength(2)
    expect(parsed.articles[0]?.sourceMetadata.covidence.mode).toBe('title_abstract')
    expect(parsed.articles[0]?.sourceMetadata.covidence.stageMembership).toEqual({
      all: true,
      excluded: false,
      full_text: true,
      included: false,
      irrelevant: false,
    })
    expect(parsed.articles[1]?.articleTitle).toBe('Study B')
  } finally {
    deleteCovidencePackageFiles(datasourceId)
    ;[duckdbPath, `${duckdbPath}.wal`, `${duckdbPath}.writer.lock`, `${duckdbPath}.writer.history.json`].map(
      (filePath) => {
        if (existsSync(filePath)) {
          unlinkSync(filePath)
        }

        return filePath
      },
    )
  }
})

test('parseCovidenceCsvReferenceRows keeps citation metadata and source file roles across Covidence csv lists', () => {
  const csvContent = [
    'Title,Authors,Abstract,Year,Tags,Notes,Reason for exclusion',
    'Study A,"Doe, Jane",A summary,2024,"tag one; tag two",Keep this,Wrong population',
  ].join('\n')

  const parsedRows = (['all', 'irrelevant', 'full_text', 'excluded', 'included'] as const).map((fileRole) => {
    return parseCovidenceCsvReferenceRows({
      content: csvContent,
      fileRole,
      format: 'csv',
      sourceFileName: `${fileRole}.csv`,
    })
  })

  expect(parsedRows).toEqual([
    {
      ok: true,
      rows: [
        {
          citation: {abstract: 'A summary', authors: 'Doe, Jane', title: 'Study A', year: '2024'},
          exclusionReason: 'Wrong population',
          fileRole: 'all',
          notes: 'Keep this',
          rowNumber: 2,
          sourceFileName: 'all.csv',
          tags: ['tag one', 'tag two'],
        },
      ],
    },
    {
      ok: true,
      rows: [
        {
          citation: {abstract: 'A summary', authors: 'Doe, Jane', title: 'Study A', year: '2024'},
          exclusionReason: 'Wrong population',
          fileRole: 'irrelevant',
          notes: 'Keep this',
          rowNumber: 2,
          sourceFileName: 'irrelevant.csv',
          tags: ['tag one', 'tag two'],
        },
      ],
    },
    {
      ok: true,
      rows: [
        {
          citation: {abstract: 'A summary', authors: 'Doe, Jane', title: 'Study A', year: '2024'},
          exclusionReason: 'Wrong population',
          fileRole: 'full_text',
          notes: 'Keep this',
          rowNumber: 2,
          sourceFileName: 'full_text.csv',
          tags: ['tag one', 'tag two'],
        },
      ],
    },
    {
      ok: true,
      rows: [
        {
          citation: {abstract: 'A summary', authors: 'Doe, Jane', title: 'Study A', year: '2024'},
          exclusionReason: 'Wrong population',
          fileRole: 'excluded',
          notes: 'Keep this',
          rowNumber: 2,
          sourceFileName: 'excluded.csv',
          tags: ['tag one', 'tag two'],
        },
      ],
    },
    {
      ok: true,
      rows: [
        {
          citation: {abstract: 'A summary', authors: 'Doe, Jane', title: 'Study A', year: '2024'},
          exclusionReason: 'Wrong population',
          fileRole: 'included',
          notes: 'Keep this',
          rowNumber: 2,
          sourceFileName: 'included.csv',
          tags: ['tag one', 'tag two'],
        },
      ],
    },
  ])
})

test('parseCovidenceCsvReferenceRows returns stable parse errors for malformed or unsupported inputs', () => {
  expect(
    parseCovidenceCsvReferenceRows({
      content: 'TY  - JOUR\nER  - \n',
      fileRole: 'full_text',
      format: 'ris',
      sourceFileName: 'full_text.ris',
    }),
  ).toEqual({
    error: {
      code: 'unsupported_format',
      fileRole: 'full_text',
      message: "Covidence reference parsing only supports CSV inputs, got 'ris'",
      rowNumber: null,
      sourceFileName: 'full_text.ris',
    },
    ok: false,
  })

  expect(
    parseCovidenceCsvReferenceRows({
      content: 'Title,Authors\n"broken',
      fileRole: 'all',
      format: 'csv',
      sourceFileName: 'all.csv',
    }),
  ).toEqual({
    error: {
      code: 'malformed_csv',
      fileRole: 'all',
      message: 'Covidence CSV has an unclosed quoted field',
      rowNumber: null,
      sourceFileName: 'all.csv',
    },
    ok: false,
  })

  expect(
    parseCovidenceCsvReferenceRows({
      content: 'Title,Authors\nStudy A',
      fileRole: 'excluded',
      format: 'csv',
      sourceFileName: 'excluded.csv',
    }),
  ).toEqual({
    error: {
      code: 'row_length_mismatch',
      fileRole: 'excluded',
      message: 'Covidence CSV row 2 has 1 fields; expected 2',
      rowNumber: 2,
      sourceFileName: 'excluded.csv',
    },
    ok: false,
  })
})

test('parseCovidenceReferenceRows parses Covidence RIS rows into the same downstream shape across file roles', () => {
  const risContent = [
    'TY  - JOUR',
    'TI  - Study A',
    'AB  - A summary',
    'AU  - Doe, Jane',
    'AU  - Roe, John',
    'DO  - 10.1000/example',
    'PMID  - 123456',
    'UR  - https://example.com/study-a',
    'KW  - tag one',
    'KW  - tag two',
    'N1  - Keep this',
    'LB  - included_source',
    'ID  - covidence-1',
    'ER  - ',
  ].join('\n')

  const parsedRows = (['all', 'irrelevant', 'full_text', 'excluded', 'included'] as const).map((fileRole) => {
    return parseCovidenceReferenceRows({
      content: risContent,
      fileRole,
      format: 'ris',
      sourceFileName: `${fileRole}.ris`,
    })
  })

  expect(parsedRows).toEqual([
    {
      ok: true,
      rows: [
        {
          citation: {
            authors: 'Doe, Jane; Roe, John',
            doi: '10.1000/example',
            keywords: 'tag one; tag two',
            pmid: '123456',
            reference_id: 'covidence-1',
            reference_type: 'JOUR',
            source_role: 'included_source',
            title: 'Study A',
            abstract: 'A summary',
            url: 'https://example.com/study-a',
          },
          exclusionReason: null,
          fileRole: 'all',
          notes: 'Keep this',
          rowNumber: 1,
          sourceFileName: 'all.ris',
          tags: ['tag one', 'tag two'],
        },
      ],
    },
    {
      ok: true,
      rows: [
        {
          citation: {
            authors: 'Doe, Jane; Roe, John',
            doi: '10.1000/example',
            keywords: 'tag one; tag two',
            pmid: '123456',
            reference_id: 'covidence-1',
            reference_type: 'JOUR',
            source_role: 'included_source',
            title: 'Study A',
            abstract: 'A summary',
            url: 'https://example.com/study-a',
          },
          exclusionReason: null,
          fileRole: 'irrelevant',
          notes: 'Keep this',
          rowNumber: 1,
          sourceFileName: 'irrelevant.ris',
          tags: ['tag one', 'tag two'],
        },
      ],
    },
    {
      ok: true,
      rows: [
        {
          citation: {
            authors: 'Doe, Jane; Roe, John',
            doi: '10.1000/example',
            keywords: 'tag one; tag two',
            pmid: '123456',
            reference_id: 'covidence-1',
            reference_type: 'JOUR',
            source_role: 'included_source',
            title: 'Study A',
            abstract: 'A summary',
            url: 'https://example.com/study-a',
          },
          exclusionReason: null,
          fileRole: 'full_text',
          notes: 'Keep this',
          rowNumber: 1,
          sourceFileName: 'full_text.ris',
          tags: ['tag one', 'tag two'],
        },
      ],
    },
    {
      ok: true,
      rows: [
        {
          citation: {
            authors: 'Doe, Jane; Roe, John',
            doi: '10.1000/example',
            keywords: 'tag one; tag two',
            pmid: '123456',
            reference_id: 'covidence-1',
            reference_type: 'JOUR',
            source_role: 'included_source',
            title: 'Study A',
            abstract: 'A summary',
            url: 'https://example.com/study-a',
          },
          exclusionReason: null,
          fileRole: 'excluded',
          notes: 'Keep this',
          rowNumber: 1,
          sourceFileName: 'excluded.ris',
          tags: ['tag one', 'tag two'],
        },
      ],
    },
    {
      ok: true,
      rows: [
        {
          citation: {
            authors: 'Doe, Jane; Roe, John',
            doi: '10.1000/example',
            keywords: 'tag one; tag two',
            pmid: '123456',
            reference_id: 'covidence-1',
            reference_type: 'JOUR',
            source_role: 'included_source',
            title: 'Study A',
            abstract: 'A summary',
            url: 'https://example.com/study-a',
          },
          exclusionReason: null,
          fileRole: 'included',
          notes: 'Keep this',
          rowNumber: 1,
          sourceFileName: 'included.ris',
          tags: ['tag one', 'tag two'],
        },
      ],
    },
  ])
})

test('parseCovidenceReferenceRows returns stable RIS parse errors for malformed inputs', () => {
  expect(
    parseCovidenceReferenceRows({
      content: 'TY  - JOUR\nTI  - Broken\n',
      fileRole: 'full_text',
      format: 'ris',
      sourceFileName: 'full_text.ris',
    }),
  ).toEqual({
    error: {
      code: 'malformed_ris',
      fileRole: 'full_text',
      message: 'Covidence RIS is missing a terminating ER field',
      rowNumber: null,
      sourceFileName: 'full_text.ris',
    },
    ok: false,
  })

  expect(
    parseCovidenceReferenceRows({
      content: 'Not RIS\nER  - \n',
      fileRole: 'all',
      format: 'ris',
      sourceFileName: 'all.ris',
    }),
  ).toEqual({
    error: {
      code: 'malformed_ris',
      fileRole: 'all',
      message: 'Covidence RIS line 1 is not a valid RIS field',
      rowNumber: 1,
      sourceFileName: 'all.ris',
    },
    ok: false,
  })
})

test('mergeCovidenceReferenceRows uses all rows as canonical metadata and reports conflicts and missing matches', () => {
  const merged = mergeCovidenceReferenceRows([
    {
      citation: {
        authors: 'Doe, Jane',
        doi: 'https://doi.org/10.1000/Alpha',
        title: 'Canonical DOI title',
        year: '2024',
      },
      exclusionReason: null,
      fileRole: 'all',
      notes: null,
      rowNumber: 2,
      sourceFileName: 'all.ris',
      tags: ['all-tag'],
    },
    {
      citation: {authors: 'Doe, Jane', doi: '10.1000/alpha', title: 'Overlay DOI title', year: '2024'},
      exclusionReason: null,
      fileRole: 'irrelevant',
      notes: 'irrelevant note',
      rowNumber: 3,
      sourceFileName: 'irrelevant.csv',
      tags: ['irrelevant-tag'],
    },
    {
      citation: {authors: 'Doe, Jane', doi: 'doi:10.1000/alpha', title: 'Second overlay DOI title', year: '2024'},
      exclusionReason: null,
      fileRole: 'full_text',
      notes: 'full text note',
      rowNumber: 4,
      sourceFileName: 'full_text.csv',
      tags: ['full-text-tag'],
    },
    {
      citation: {authors: 'Roe, John', pmid: '12345', title: 'Canonical PMID title', year: '2021'},
      exclusionReason: null,
      fileRole: 'all',
      notes: null,
      rowNumber: 5,
      sourceFileName: 'all.ris',
      tags: [],
    },
    {
      citation: {authors: 'Roe, John', pmid: '12345', title: 'Overlay PMID title', year: '2021'},
      exclusionReason: null,
      fileRole: 'full_text',
      notes: 'pmid note',
      rowNumber: 6,
      sourceFileName: 'full_text.csv',
      tags: ['pmid-tag'],
    },
    {
      citation: {authors: 'Lane, Kim', reference_id: 'cov-3', title: 'Canonical ref title', year: '2020'},
      exclusionReason: null,
      fileRole: 'all',
      notes: null,
      rowNumber: 7,
      sourceFileName: 'all.ris',
      tags: [],
    },
    {
      citation: {authors: 'Lane, Kim', reference_id: 'COV-3', title: 'Overlay ref title', year: '2020'},
      exclusionReason: null,
      fileRole: 'included',
      notes: 'included note',
      rowNumber: 8,
      sourceFileName: 'included.csv',
      tags: ['included-tag'],
    },
    {
      citation: {authors: 'Smith, Pat; Roe, John', title: 'Fallback title', year: '2019'},
      exclusionReason: null,
      fileRole: 'all',
      notes: null,
      rowNumber: 9,
      sourceFileName: 'all.csv',
      tags: [],
    },
    {
      citation: {authors: 'Smith, Pat', title: 'Fallback title', year: '2019'},
      exclusionReason: 'No outcome',
      fileRole: 'excluded',
      notes: 'excluded note',
      rowNumber: 10,
      sourceFileName: 'excluded.csv',
      tags: ['excluded-tag'],
    },
    {
      citation: {authors: 'Smith, Pat', title: 'Fallback title', year: '2019'},
      exclusionReason: null,
      fileRole: 'included',
      notes: 'included fallback note',
      rowNumber: 11,
      sourceFileName: 'included.csv',
      tags: ['included-fallback-tag'],
    },
    {
      citation: {authors: 'Missing, Match', doi: '10.9999/missing', title: 'Missing canonical', year: '2022'},
      exclusionReason: null,
      fileRole: 'excluded',
      notes: 'missing note',
      rowNumber: 12,
      sourceFileName: 'excluded.csv',
      tags: ['missing-tag'],
    },
  ])

  expect(
    merged.candidates.map((candidate) => {
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
  ).toEqual([
    {
      articleKey: 'doi:10.1000/alpha',
      articleKeySource: 'doi',
      citation: {
        authors: 'Doe, Jane',
        doi: 'https://doi.org/10.1000/Alpha',
        title: 'Canonical DOI title',
        year: '2024',
      },
      exclusionReasons: [],
      notes: ['irrelevant note', 'full text note'],
      stageMembership: {all: true, excluded: false, full_text: true, included: false, irrelevant: true},
      tags: ['all-tag', 'irrelevant-tag', 'full-text-tag'],
    },
    {
      articleKey: 'pmid:12345',
      articleKeySource: 'pmid',
      citation: {authors: 'Roe, John', pmid: '12345', title: 'Canonical PMID title', year: '2021'},
      exclusionReasons: [],
      notes: ['pmid note'],
      stageMembership: {all: true, excluded: false, full_text: true, included: false, irrelevant: false},
      tags: ['pmid-tag'],
    },
    {
      articleKey: 'reference_id:cov-3',
      articleKeySource: 'reference_id',
      citation: {authors: 'Lane, Kim', reference_id: 'cov-3', title: 'Canonical ref title', year: '2020'},
      exclusionReasons: [],
      notes: ['included note'],
      stageMembership: {all: true, excluded: false, full_text: false, included: true, irrelevant: false},
      tags: ['included-tag'],
    },
    {
      articleKey: `title_year_first_author:${getCovidenceFallbackHash('fallback title|2019|smith pat')}`,
      articleKeySource: 'title_year_first_author',
      citation: {authors: 'Smith, Pat; Roe, John', title: 'Fallback title', year: '2019'},
      exclusionReasons: ['No outcome'],
      notes: ['excluded note', 'included fallback note'],
      stageMembership: {all: true, excluded: true, full_text: false, included: true, irrelevant: false},
      tags: ['excluded-tag', 'included-fallback-tag'],
    },
  ])
  expect(merged.warnings.conflictingStageMemberships).toEqual([
    {
      articleKey: 'doi:10.1000/alpha',
      conflictingFileRoles: ['irrelevant', 'full_text'],
      sourceRows: [
        {
          citation: {authors: 'Doe, Jane', doi: '10.1000/alpha', title: 'Overlay DOI title', year: '2024'},
          exclusionReason: null,
          fileRole: 'irrelevant',
          notes: 'irrelevant note',
          rowNumber: 3,
          sourceFileName: 'irrelevant.csv',
          tags: ['irrelevant-tag'],
        },
        {
          citation: {authors: 'Doe, Jane', doi: 'doi:10.1000/alpha', title: 'Second overlay DOI title', year: '2024'},
          exclusionReason: null,
          fileRole: 'full_text',
          notes: 'full text note',
          rowNumber: 4,
          sourceFileName: 'full_text.csv',
          tags: ['full-text-tag'],
        },
      ],
    },
    {
      articleKey: `title_year_first_author:${getCovidenceFallbackHash('fallback title|2019|smith pat')}`,
      conflictingFileRoles: ['excluded', 'included'],
      sourceRows: [
        {
          citation: {authors: 'Smith, Pat', title: 'Fallback title', year: '2019'},
          exclusionReason: 'No outcome',
          fileRole: 'excluded',
          notes: 'excluded note',
          rowNumber: 10,
          sourceFileName: 'excluded.csv',
          tags: ['excluded-tag'],
        },
        {
          citation: {authors: 'Smith, Pat', title: 'Fallback title', year: '2019'},
          exclusionReason: null,
          fileRole: 'included',
          notes: 'included fallback note',
          rowNumber: 11,
          sourceFileName: 'included.csv',
          tags: ['included-fallback-tag'],
        },
      ],
    },
  ])
  expect(merged.warnings.missingMatches).toEqual([
    {
      articleKey: 'doi:10.9999/missing',
      articleKeySource: 'doi',
      fileRole: 'excluded',
      rowNumber: 12,
      sourceFileName: 'excluded.csv',
    },
  ])
})

test('analyzeCovidencePackageFiles returns detected roles counts warnings and sample merged rows', async () => {
  const result = await analyzeCovidencePackageFiles({
    files: [
      {
        file: new File(['Title,Authors,Year,DOI\nStudy A,"Doe, Jane",2024,10.1000/alpha\n'], 'all.csv', {
          type: 'text/csv',
        }),
        fileRole: 'all',
      },
      {
        file: new File(['Title,Authors,Year,DOI\nStudy A,"Doe, Jane",2024,10.1000/alpha\n'], 'full_text.csv', {
          type: 'text/csv',
        }),
        fileRole: 'full_text',
      },
      {
        file: new File(['Title,Authors,Year,DOI\nMissing Match,"Roe, John",2023,10.1000/missing\n'], 'irrelevant.csv', {
          type: 'text/csv',
        }),
        fileRole: 'irrelevant',
      },
    ],
    mode: 'title_abstract',
  })

  expect(result.ok).toBe(true)

  if (result.ok === false) {
    throw new Error('Expected Covidence analyze success')
  }

  expect(result.data.mode).toBe('title_abstract')
  expect(result.data.detectedFiles).toEqual([
    {fileRole: 'all', format: 'csv', rowCount: 1, sourceFileName: 'all.csv'},
    {fileRole: 'irrelevant', format: 'csv', rowCount: 1, sourceFileName: 'irrelevant.csv'},
    {fileRole: 'full_text', format: 'csv', rowCount: 1, sourceFileName: 'full_text.csv'},
  ])
  expect(result.data.counts).toEqual({
    conflictingStageMembershipCount: 0,
    fileCount: 3,
    filesByRole: {all: 1, excluded: 0, full_text: 1, included: 0, irrelevant: 1},
    mergedRowCount: 1,
    missingMatchCount: 1,
    rowCount: 3,
    rowsByRole: {all: 1, excluded: 0, full_text: 1, included: 0, irrelevant: 1},
  })
  expect(result.data.warnings.missingMatches).toEqual([
    {
      articleKey: 'doi:10.1000/missing',
      articleKeySource: 'doi',
      fileRole: 'irrelevant',
      rowNumber: 2,
      sourceFileName: 'irrelevant.csv',
    },
  ])
  expect(result.data.warnings.conflictingStageMemberships).toEqual([])
  expect(result.data.sampleMergedRows).toEqual([
    {
      articleKey: 'doi:10.1000/alpha',
      articleKeySource: 'doi',
      citation: {authors: 'Doe, Jane', doi: '10.1000/alpha', title: 'Study A', year: '2024'},
      exclusionReasons: [],
      notes: [],
      stageMembership: {all: true, excluded: false, full_text: true, included: false, irrelevant: false},
      tags: [],
    },
  ])
})

test('analyzeCovidencePackageFiles rejects missing required files for the selected mode', async () => {
  const result = await analyzeCovidencePackageFiles({
    files: [
      {file: new File(['Title\nStudy A\n'], 'all.csv', {type: 'text/csv'}), fileRole: 'all'},
      {file: new File(['Title\nStudy A\n'], 'full_text.csv', {type: 'text/csv'}), fileRole: 'full_text'},
    ],
    mode: 'title_abstract',
  })

  expect(result).toEqual({
    error: {
      code: 'invalid_file_roles',
      message: 'Invalid Covidence package file roles: missing required files: irrelevant',
    },
    ok: false,
  })
})

test('analyzeCovidencePackageFiles rejects mutually exclusive stage memberships', async () => {
  const result = await analyzeCovidencePackageFiles({
    files: [
      {
        file: new File(['Title,Authors,Year,DOI\nStudy A,"Doe, Jane",2024,10.1000/alpha\n'], 'all.csv', {
          type: 'text/csv',
        }),
        fileRole: 'all',
      },
      {
        file: new File(['Title,Authors,Year,DOI\nStudy A,"Doe, Jane",2024,10.1000/alpha\n'], 'irrelevant.csv', {
          type: 'text/csv',
        }),
        fileRole: 'irrelevant',
      },
      {
        file: new File(['Title,Authors,Year,DOI\nStudy A,"Doe, Jane",2024,10.1000/alpha\n'], 'full_text.csv', {
          type: 'text/csv',
        }),
        fileRole: 'full_text',
      },
    ],
    mode: 'title_abstract',
  })

  expect(result.ok).toBe(false)

  if (result.ok) {
    throw new Error('Expected Covidence analyze conflict failure')
  }

  expect(result.error.code).toBe('conflicting_stage_memberships')
  expect(result.error.message).toBe('Covidence package has mutually exclusive stage memberships')
  expect(result.error.warnings?.conflictingStageMemberships).toHaveLength(1)
  expect(result.error.warnings?.missingMatches).toEqual([])
})
