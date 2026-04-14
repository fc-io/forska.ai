import {createHash} from 'node:crypto'
import {existsSync, unlinkSync} from 'node:fs'
import path from 'node:path'

import {afterEach, expect, test} from 'bun:test'

import {
  analyzeCovidencePackageFiles,
  buildCovidencePackageConfig,
  buildCovidencePromptDefinition,
  buildCovidencePromptDefinitionsForEligibilityFields,
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
      answerSet: 'yes|no|maybe',
      exclusionCriteria: 'Case reports\nEditorials',
      inclusionCriteria: 'Adults with confirmed disease',
      mode: 'title_abstract',
    }),
  ).toEqual({
    criteriaDisposition: 'combined',
    originalText: [
      'Based on the inclusion and exclusion criteria, should this study be included for full text review?',
      '',
      'Answer yes only if all inclusion criteria are satisfied and none of the exclusion criteria apply.',
      'Answer no if any inclusion criterion is not satisfied or any exclusion criterion applies.',
      'Answer maybe if the report does not provide enough information to determine whether the study should be included for full text review.',
      '',
      'Inclusion criteria (evaluate in order):',
      'Adults with confirmed disease',
      '',
      'Exclusion criteria (evaluate in order):',
      'Case reports\nEditorials',
    ].join('\n'),
    promptHeading: 'Covidence title/abstract screening',
    type: "'yes' | 'no' | 'maybe'",
  })

  expect(
    buildCovidencePromptDefinition({
      answerSet: 'yes|no',
      exclusionCriteria: 'Animal studies',
      inclusionCriteria: 'Randomized trials',
      mode: 'full_text',
    }),
  ).toEqual({
    criteriaDisposition: 'combined',
    originalText: [
      'Based on the inclusion and exclusion criteria, should this study be included in the final review?',
      '',
      'Answer yes only if all inclusion criteria are satisfied and none of the exclusion criteria apply.',
      'Answer no if any inclusion criterion is not satisfied or any exclusion criterion applies.',
      '',
      'Inclusion criteria (evaluate in order):',
      'Randomized trials',
      '',
      'Exclusion criteria (evaluate in order):',
      'Animal studies',
    ].join('\n'),
    promptHeading: 'Covidence full-text screening',
    type: "'yes' | 'no'",
  })

  expect(
    buildCovidencePromptDefinitionsForEligibilityFields({
      answerSet: 'yes|no|maybe',
      eligibilityFields: [
        {disposition: 'include', sectionKey: ' outcome ', sectionLabel: ' Outcome ', text: '   '},
        {
          disposition: 'include',
          sectionKey: ' population ',
          sectionLabel: ' Population ',
          text: ' Adults with confirmed disease ',
        },
        {disposition: 'exclude', sectionKey: ' other ', sectionLabel: ' Other ', text: ' Case reports '},
        {
          disposition: 'exclude',
          sectionKey: 'study_characteristics',
          sectionLabel: 'Study Characteristics',
          text: '\n\t',
        },
      ],
      mode: 'title_abstract',
    }),
  ).toEqual([
    {
      criteriaDisposition: 'include',
      criteriaSectionKey: 'population',
      criteriaSectionLabel: 'Population',
      originalText: [
        'Review only the Population inclusion criteria below.',
        'Answer yes if the study matches the Population inclusion criteria.',
        'Answer no if the study does not match the Population inclusion criteria.',
        'Answer maybe if the report does not provide enough information to decide.',
        '',
        'Population inclusion criteria:',
        'Adults with confirmed disease',
      ].join('\n'),
      promptHeading: 'Matches Population Inclusion',
      type: "'yes' | 'no' | 'maybe'",
    },
    {
      criteriaDisposition: 'exclude',
      criteriaSectionKey: 'other',
      criteriaSectionLabel: 'Other',
      originalText: [
        'Review only the Other exclusion criteria below.',
        'Answer yes if the study matches any of the Other exclusion criteria.',
        'Answer no if the study does not match any of the Other exclusion criteria.',
        'Answer maybe if the report does not provide enough information to decide.',
        '',
        'Other exclusion criteria:',
        'Case reports',
      ].join('\n'),
      promptHeading: 'Matches Other Exclusion',
      type: "'yes' | 'no' | 'maybe'",
    },
  ])

  expect(
    buildCovidencePromptDefinitionsForEligibilityFields({
      answerSet: 'yes|no',
      eligibilityFields: [
        {
          disposition: 'include',
          sectionKey: ' population ',
          sectionLabel: ' Population ',
          text: ' Adults with confirmed disease ',
        },
        {disposition: 'exclude', sectionKey: 'population', sectionLabel: 'Population', text: 'Pediatric-only cohorts'},
        {disposition: 'exclude', sectionKey: ' other ', sectionLabel: ' Other ', text: ' Case reports '},
      ],
      mode: 'full_text',
      promptGrouping: 'per_section',
    }),
  ).toEqual([
    {
      criteriaDisposition: 'combined',
      criteriaSectionKey: 'population',
      criteriaSectionLabel: 'Population',
      originalText: [
        'Based on the inclusion and exclusion criteria, should this study be included in the final review?',
        '',
        'Answer yes only if all inclusion criteria are satisfied and none of the exclusion criteria apply.',
        'Answer no if any inclusion criterion is not satisfied or any exclusion criterion applies.',
        '',
        'Inclusion criteria (evaluate in order):',
        'Adults with confirmed disease',
        '',
        'Exclusion criteria (evaluate in order):',
        'Pediatric-only cohorts',
      ].join('\n'),
      promptHeading: 'Matches Population Criteria',
      type: "'yes' | 'no'",
    },
    {
      criteriaDisposition: 'combined',
      criteriaSectionKey: 'other',
      criteriaSectionLabel: 'Other',
      originalText: [
        'Based on the inclusion and exclusion criteria, should this study be included in the final review?',
        '',
        'Answer yes only if all inclusion criteria are satisfied and none of the exclusion criteria apply.',
        'Answer no if any inclusion criterion is not satisfied or any exclusion criterion applies.',
        '',
        'Inclusion criteria (evaluate in order):',
        '(none provided)',
        '',
        'Exclusion criteria (evaluate in order):',
        'Case reports',
      ].join('\n'),
      promptHeading: 'Matches Other Criteria',
      type: "'yes' | 'no'",
    },
  ])

  expect(
    buildCovidencePromptDefinitionsForEligibilityFields({
      answerSet: 'yes|no|maybe',
      eligibilityFields: [
        {
          disposition: 'include',
          sectionKey: 'population',
          sectionLabel: 'Population',
          text: 'Adults with confirmed disease',
        },
        {disposition: 'exclude', sectionKey: 'other', sectionLabel: 'Other', text: 'Case reports'},
      ],
      mode: 'title_abstract',
      promptGrouping: 'single_prompt',
    }),
  ).toEqual([
    {
      criteriaDisposition: 'combined',
      originalText: [
        'Based on the inclusion and exclusion criteria, should this study be included for full text review?',
        '',
        'Answer yes only if all inclusion criteria are satisfied and none of the exclusion criteria apply.',
        'Answer no if any inclusion criterion is not satisfied or any exclusion criterion applies.',
        'Answer maybe if the report does not provide enough information to determine whether the study should be included for full text review.',
        '',
        'Inclusion criteria (evaluate in order):',
        'Adults with confirmed disease',
        '',
        'Exclusion criteria (evaluate in order):',
        'Case reports',
      ].join('\n'),
      promptHeading: 'Covidence title/abstract screening',
      type: "'yes' | 'no' | 'maybe'",
    },
  ])

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
          answerSet: 'yes|no|maybe',
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
          answerSet: 'yes|no|maybe',
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
      createdPrompt: {created: boolean; criteriaDisposition?: string; id: string; type: string}
      promptRows: Array<{id: string; originalText: string; promptHeading: string; type: string}>
      reusedPrompt: {created: boolean; criteriaDisposition?: string; id: string; type: string}
    }

    expect(parsed.reusedPrompt).toMatchObject({
      created: false,
      criteriaDisposition: 'combined',
      id: 'prompt-existing',
      promptHeading: 'Covidence title/abstract screening',
      type: "'yes' | 'no' | 'maybe'",
    })
    expect(parsed.createdPrompt.created).toBe(true)
    expect(parsed.createdPrompt.criteriaDisposition).toBe('combined')
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

test('getOrCreateCovidenceProject creates one title/abstract project per route and reuses it on later imports', async () => {
  const duckdbPath = `/tmp/f1-covidence-project-${Date.now()}.duckdb`
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

        await database.run(\`
          INSERT INTO app.provider_connection (id, label, provider_kind, enabled)
          VALUES ('pc-covidence', 'Covidence provider', 'openai-compatible', TRUE);

          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, enabled)
          VALUES ('model-covidence', 'pc-covidence', 'gpt-covidence', 'gpt-covidence', TRUE);

          INSERT INTO app.import_route (id, route, name, active)
          VALUES ('route-covidence', 'covidence:ds-1', 'covidence:ds-1', TRUE);
        \`)

        const prompt = await covidenceImportService.getOrCreateCovidencePrompt({
          answerSet: 'yes|no|maybe',
          exclusionCriteria: 'Case reports',
          inclusionCriteria: 'Adults with confirmed disease',
          mode: 'title_abstract',
        })
        const createdProject = await covidenceImportService.getOrCreateCovidenceProject({
          importRoute: 'covidence:ds-1',
          mode: 'title_abstract',
          promptId: prompt.id,
          title: 'Created datasource',
        })
        const reusedProject = await covidenceImportService.getOrCreateCovidenceProject({
          importRoute: 'covidence:ds-1',
          mode: 'title_abstract',
          promptId: prompt.id,
          title: 'Created datasource',
        })
        const projectRows = await database.queryJson(\`
          SELECT
            p.human_judgment_mode AS humanJudgmentMode,
            p.id AS id,
            p.model_id AS modelId,
            p.name AS name,
            p.use_title AS useTitle,
            p.use_abstract AS useAbstract,
            p.use_fulltext AS useFulltext,
            p.use_fulltext_no_images AS useFulltextNoImages
          FROM app.project p
        \`)
        const projectImportRouteRows = await database.queryJson(\`
          SELECT pir.project_id AS projectId, ir.route AS route
          FROM app.project_import_route pir
          INNER JOIN app.import_route ir ON ir.id = pir.import_route_id
        \`)
        const projectPromptRows = await database.queryJson(\`
          SELECT project_id AS projectId, prompt_id AS promptId, enabled
          FROM app.project_prompt
        \`)

        console.log(JSON.stringify({createdProject, projectImportRouteRows, projectPromptRows, projectRows, reusedProject}))
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
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'Failed to create Covidence project')
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
      createdProject: {
        created: boolean
        humanJudgmentMode: string
        id: string
        modelId: string
        name: string
        useAbstract: boolean
        useFulltext: boolean
        useFulltextNoImages: boolean
        useTitle: boolean
      }
      projectImportRouteRows: Array<{projectId: string; route: string}>
      projectPromptRows: Array<{enabled: boolean; projectId: string; promptId: string}>
      projectRows: Array<{
        humanJudgmentMode: string
        id: string
        modelId: string
        name: string
        useAbstract: boolean
        useFulltext: boolean
        useFulltextNoImages: boolean
        useTitle: boolean
      }>
      reusedProject: {
        created: boolean
        humanJudgmentMode: string
        id: string
        modelId: string
        name: string
        useAbstract: boolean
        useFulltext: boolean
        useFulltextNoImages: boolean
        useTitle: boolean
      }
    }

    expect(parsed.createdProject).toEqual({
      created: true,
      humanJudgmentMode: 'summary',
      id: parsed.createdProject.id,
      modelId: 'model-covidence',
      name: 'Created datasource',
      useAbstract: true,
      useFulltext: false,
      useFulltextNoImages: false,
      useTitle: true,
    })
    expect(parsed.reusedProject).toEqual({
      created: false,
      humanJudgmentMode: 'summary',
      id: parsed.createdProject.id,
      modelId: 'model-covidence',
      name: 'Created datasource',
      useAbstract: true,
      useFulltext: false,
      useFulltextNoImages: false,
      useTitle: true,
    })
    expect(parsed.projectRows).toEqual([
      {
        humanJudgmentMode: 'summary',
        id: parsed.createdProject.id,
        modelId: 'model-covidence',
        name: 'Created datasource',
        useAbstract: true,
        useFulltext: false,
        useFulltextNoImages: false,
        useTitle: true,
      },
    ])
    expect(parsed.projectImportRouteRows).toEqual([{projectId: parsed.createdProject.id, route: 'covidence:ds-1'}])
    expect(parsed.projectPromptRows).toHaveLength(1)
    expect(parsed.projectPromptRows[0]?.projectId).toBe(parsed.createdProject.id)
    expect(parsed.projectPromptRows[0]?.enabled).toBe(true)
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

test('full-text Covidence projects reuse the route-backed project and scope articles to full-text review rows', async () => {
  const duckdbPath = `/tmp/f1-covidence-full-text-project-${Date.now()}.duckdb`
  const datasourceId = `covidence-full-text-project-${Date.now()}`
  const importRoute = `covidence:${datasourceId}`
  datasourceIdsToDelete.add(datasourceId)
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
        const importRoute = ${JSON.stringify(importRoute)}
        const files = await covidenceImportService.storeCovidencePackageFiles({
          datasourceId,
          files: [
            {file: new File(['Title,Authors,Year,DOI\\nStudy A,"Doe, Jane",2024,10.1000/alpha\\nStudy B,"Roe, John",2023,10.1000/beta\\nStudy C,"Lane, Kim",2022,10.1000/gamma\\nStudy D,"Poe, Sam",2021,10.1000/delta\\n'], 'all.csv', {type: 'text/csv'}), fileRole: 'all'},
            {file: new File(['Title,Authors,Year,DOI\\nStudy D,"Poe, Sam",2021,10.1000/delta\\n'], 'irrelevant.csv', {type: 'text/csv'}), fileRole: 'irrelevant'},
            {file: new File(['Title,Authors,Year,DOI\\nStudy A,"Doe, Jane",2024,10.1000/alpha\\n'], 'full_text.csv', {type: 'text/csv'}), fileRole: 'full_text'},
            {file: new File(['Title,Authors,Year,DOI,Reason for exclusion\\nStudy B,"Roe, John",2023,10.1000/beta,Wrong population\\n'], 'excluded.csv', {type: 'text/csv'}), fileRole: 'excluded'},
            {file: new File(['Title,Authors,Year,DOI\\nStudy C,"Lane, Kim",2022,10.1000/gamma\\n'], 'included.csv', {type: 'text/csv'}), fileRole: 'included'},
          ],
        })
        const config = covidenceImportService.buildCovidencePackageConfig({files, mode: 'full_text'})

        await database.run(\`
          INSERT INTO app.provider_connection (id, label, provider_kind, enabled)
          VALUES ('pc-covidence-full-text', 'Covidence provider', 'openai-compatible', TRUE);

          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, enabled)
          VALUES ('model-covidence-full-text', 'pc-covidence-full-text', 'gpt-covidence', 'gpt-covidence', TRUE);

          INSERT INTO app.import_route (id, route, name, active)
          VALUES ('route-covidence-full-text', '\${importRoute}', '\${importRoute}', TRUE);
        \`)

        const createdProject = await covidenceImportService.getOrCreateCovidenceProject({
          importRoute,
          mode: 'full_text',
          title: 'Full text datasource',
        })
        const reusedProject = await covidenceImportService.getOrCreateCovidenceProject({
          importRoute,
          mode: 'full_text',
          title: 'Full text datasource',
        })

        await database.transaction(async (tx) => {
          await covidenceImportService.importCovidencePackageFromConfig({config, datasourceId, importRoute, tx})
          await covidenceImportService.syncCovidenceProjectScopeFromConfig({config, importRoute, projectId: createdProject.id, tx})
        })

        const projectRows = await database.queryJson(\`
          SELECT
            human_judgment_mode AS humanJudgmentMode,
            id,
            model_id AS modelId,
            name,
            use_title AS useTitle,
            use_abstract AS useAbstract,
            use_fulltext AS useFulltext,
            use_fulltext_no_images AS useFulltextNoImages
          FROM app.project
        \`)
        const projectArticleRows = await database.queryJson(\`
          SELECT
            a.article_id AS articleExternalId,
            a.article_title AS articleTitle,
            pa.imported_from_project_id AS importedFromProjectId,
            pa.project_id AS projectId
          FROM app.project_article pa
          INNER JOIN app.article a ON a.id = pa.article_id
          ORDER BY a.article_title ASC
        \`)
        const refreshStateRows = await database.queryJson(\`
          SELECT
            project_id AS projectId,
            CAST(dirty_token AS INTEGER) AS dirtyToken,
            last_request_reason AS reason
          FROM app.project_mart_refresh_state
          ORDER BY project_id ASC
        \`)
        const refreshArticleStateRows = await database.queryJson(\`
          SELECT
            project_id AS projectId,
            article_id AS articleId,
            CAST(first_dirty_token AS INTEGER) AS firstDirtyToken,
            CAST(last_dirty_token AS INTEGER) AS lastDirtyToken
          FROM app.project_mart_refresh_article_state
          ORDER BY article_id ASC
        \`)

        console.log(JSON.stringify({createdProject, projectArticleRows, projectRows, refreshArticleStateRows, refreshStateRows, reusedProject}))
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
      throw new Error(
        result.stderr.toString() || result.stdout.toString() || 'Failed to scope full-text Covidence project',
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
      createdProject: {
        created: boolean
        humanJudgmentMode: string
        id: string
        modelId: string
        name: string
        useAbstract: boolean
        useFulltext: boolean
        useFulltextNoImages: boolean
        useTitle: boolean
      }
      projectArticleRows: Array<{
        articleExternalId: string
        articleTitle: string
        importedFromProjectId: string
        projectId: string
      }>
      projectRows: Array<{
        humanJudgmentMode: string
        id: string
        modelId: string
        name: string
        useAbstract: boolean
        useFulltext: boolean
        useFulltextNoImages: boolean
        useTitle: boolean
      }>
      refreshArticleStateRows: Array<{
        articleId: string
        firstDirtyToken: number
        lastDirtyToken: number
        projectId: string
      }>
      refreshStateRows: Array<{dirtyToken: number; projectId: string; reason: string | null}>
      reusedProject: {
        created: boolean
        humanJudgmentMode: string
        id: string
        modelId: string
        name: string
        useAbstract: boolean
        useFulltext: boolean
        useFulltextNoImages: boolean
        useTitle: boolean
      }
    }

    expect(parsed.createdProject).toEqual({
      created: true,
      humanJudgmentMode: 'summary',
      id: parsed.createdProject.id,
      modelId: 'model-covidence-full-text',
      name: 'Full text datasource',
      useAbstract: true,
      useFulltext: true,
      useFulltextNoImages: false,
      useTitle: true,
    })
    expect(parsed.reusedProject).toEqual({
      created: false,
      humanJudgmentMode: 'summary',
      id: parsed.createdProject.id,
      modelId: 'model-covidence-full-text',
      name: 'Full text datasource',
      useAbstract: true,
      useFulltext: true,
      useFulltextNoImages: false,
      useTitle: true,
    })
    expect(parsed.projectRows).toEqual([
      {
        humanJudgmentMode: 'summary',
        id: parsed.createdProject.id,
        modelId: 'model-covidence-full-text',
        name: 'Full text datasource',
        useAbstract: true,
        useFulltext: true,
        useFulltextNoImages: false,
        useTitle: true,
      },
    ])
    expect(parsed.projectArticleRows).toEqual([
      {
        articleExternalId: `${importRoute}:doi%3A10.1000%2Falpha`,
        articleTitle: 'Study A',
        importedFromProjectId: parsed.createdProject.id,
        projectId: parsed.createdProject.id,
      },
      {
        articleExternalId: `${importRoute}:doi%3A10.1000%2Fbeta`,
        articleTitle: 'Study B',
        importedFromProjectId: parsed.createdProject.id,
        projectId: parsed.createdProject.id,
      },
      {
        articleExternalId: `${importRoute}:doi%3A10.1000%2Fgamma`,
        articleTitle: 'Study C',
        importedFromProjectId: parsed.createdProject.id,
        projectId: parsed.createdProject.id,
      },
    ])
    expect(parsed.refreshStateRows).toEqual([
      {dirtyToken: 1, projectId: parsed.createdProject.id, reason: 'syncCovidenceProjectScopeFromConfig'},
    ])
    expect(parsed.refreshArticleStateRows).toHaveLength(3)
    expect(
      parsed.refreshArticleStateRows.every((row) => {
        return row.firstDirtyToken === 1 && row.lastDirtyToken === 1 && row.projectId === parsed.createdProject.id
      }),
    ).toBe(true)
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

test('seedCovidenceHumanJudgmentsFromConfig upserts answered and unanswered title/abstract judgments idempotently', async () => {
  const duckdbPath = `/tmp/f1-covidence-human-seed-${Date.now()}.duckdb`
  const datasourceId = `covidence-human-seed-${Date.now()}`
  const importRoute = `covidence:${datasourceId}`
  datasourceIdsToDelete.add(datasourceId)
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
        const importRoute = ${JSON.stringify(importRoute)}
        const createConfig = async (allContent, irrelevantContent, fullTextContent) => {
          const files = await covidenceImportService.storeCovidencePackageFiles({
            datasourceId,
            files: [
              {file: new File([allContent], 'all.csv', {type: 'text/csv'}), fileRole: 'all'},
              {file: new File([irrelevantContent], 'irrelevant.csv', {type: 'text/csv'}), fileRole: 'irrelevant'},
              {file: new File([fullTextContent], 'full_text.csv', {type: 'text/csv'}), fileRole: 'full_text'},
            ],
          })

          return covidenceImportService.buildCovidencePackageConfig({files, mode: 'title_abstract'})
        }

        await database.run(\`
          INSERT INTO app.provider_connection (id, label, provider_kind, enabled)
          VALUES ('pc-covidence-seed', 'Covidence provider', 'openai-compatible', TRUE);

          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, enabled)
          VALUES ('model-covidence-seed', 'pc-covidence-seed', 'gpt-covidence', 'gpt-covidence', TRUE);

          INSERT INTO app.import_route (id, route, name, active)
          VALUES ('route-covidence-seed', '${importRoute}', '${importRoute}', TRUE);
        \`)

        const prompt = await covidenceImportService.getOrCreateCovidencePrompt({
          answerSet: 'yes|no|maybe',
          exclusionCriteria: 'Case reports',
          inclusionCriteria: 'Adults with confirmed disease',
          mode: 'title_abstract',
        })
        const project = await covidenceImportService.getOrCreateCovidenceProject({
          importRoute,
          mode: 'title_abstract',
          promptId: prompt.id,
          title: 'Covidence seeded project',
        })
        await database.run(\`UPDATE app.project SET human_judgment_mode = 'prompt' WHERE id = '\${project.id}'\`)

        const firstConfig = await createConfig(
          'Title,Authors,Year,DOI\\nStudy A,"Doe, Jane",2024,10.1000/alpha\\nStudy B,"Roe, John",2023,10.1000/beta\\nStudy C,"Lane, Kim",2022,10.1000/gamma\\n',
          'Title,Authors,Year,DOI\\nStudy B,"Roe, John",2023,10.1000/beta\\n',
          'Title,Authors,Year,DOI\\nStudy A,"Doe, Jane",2024,10.1000/alpha\\n',
        )

        await database.transaction(async (tx) => {
          await covidenceImportService.importCovidencePackageFromConfig({config: firstConfig, datasourceId, importRoute, tx})
          await covidenceImportService.seedCovidenceHumanJudgmentsFromConfig({config: firstConfig, importRoute, projectId: project.id, tx})
        })

        const secondConfig = await createConfig(
          'Title,Authors,Year,DOI\\nStudy A,"Doe, Jane",2024,10.1000/alpha\\nStudy B,"Roe, John",2023,10.1000/beta\\nStudy C,"Lane, Kim",2022,10.1000/gamma\\n',
          'Title,Authors,Year,DOI\\nStudy C,"Lane, Kim",2022,10.1000/gamma\\n',
          'Title,Authors,Year,DOI\\nStudy A,"Doe, Jane",2024,10.1000/alpha\\n',
        )

        await covidenceImportService.seedCovidenceHumanJudgmentsFromConfig({
          config: secondConfig,
          importRoute,
          projectId: project.id,
        })

        const judgmentRows = await database.queryJson(\`
          SELECT
            a.article_id AS articleExternalId,
            a.article_title AS articleTitle,
            jh.article_id AS articleId,
            jh.is_answered AS isAnswered,
            jh.answer AS answer,
            jh.comment AS comment,
            jh.prompt_id AS promptId
          FROM app.judgment_human jh
          INNER JOIN app.article a ON a.id = jh.article_id
          WHERE jh.project_id = '\${project.id}'
          ORDER BY a.article_title ASC, jh.prompt_id ASC
        \`)

        console.log(JSON.stringify({judgmentRows, projectId: project.id, promptId: prompt.id}))
        covidenceImportService.deleteCovidencePackageFiles(datasourceId)
        await database.close()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '39997',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '39998',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.toString() || result.stdout.toString() || 'Failed to seed Covidence human judgments',
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
      judgmentRows: Array<{
        answer: string | null
        articleExternalId: string
        articleId: string
        articleTitle: string
        comment: string | null
        isAnswered: boolean
        promptId: string
      }>
      projectId: string
      promptId: string
    }

    expect(parsed.judgmentRows).toHaveLength(3)
    expect(parsed.judgmentRows[0]?.answer).toBe('yes')
    expect(parsed.judgmentRows[0]?.articleExternalId).toContain(`${importRoute}:`)
    expect(typeof parsed.judgmentRows[0]?.articleId).toBe('string')
    expect(parsed.judgmentRows[0]?.articleTitle).toBe('Study A')
    expect(parsed.judgmentRows[0]?.comment).toBeNull()
    expect(parsed.judgmentRows[0]?.isAnswered).toBe(true)
    expect(parsed.judgmentRows[0]?.promptId).toBe(parsed.promptId)
    expect(parsed.judgmentRows[1]?.answer).toBeNull()
    expect(parsed.judgmentRows[1]?.articleExternalId).toContain(`${importRoute}:`)
    expect(typeof parsed.judgmentRows[1]?.articleId).toBe('string')
    expect(parsed.judgmentRows[1]?.articleTitle).toBe('Study B')
    expect(parsed.judgmentRows[1]?.comment).toBeNull()
    expect(parsed.judgmentRows[1]?.isAnswered).toBe(false)
    expect(parsed.judgmentRows[1]?.promptId).toBe(parsed.promptId)
    expect(parsed.judgmentRows[2]?.answer).toBe('no')
    expect(parsed.judgmentRows[2]?.articleExternalId).toContain(`${importRoute}:`)
    expect(typeof parsed.judgmentRows[2]?.articleId).toBe('string')
    expect(parsed.judgmentRows[2]?.articleTitle).toBe('Study C')
    expect(parsed.judgmentRows[2]?.comment).toBeNull()
    expect(parsed.judgmentRows[2]?.isAnswered).toBe(true)
    expect(parsed.judgmentRows[2]?.promptId).toBe(parsed.promptId)
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

test('seedCovidenceHumanJudgmentsFromConfig treats disjoint screen irrelevant and select rows as null no yes', async () => {
  const duckdbPath = `/tmp/f1-covidence-human-screen-union-${Date.now()}.duckdb`
  const datasourceId = `covidence-human-screen-union-${Date.now()}`
  const importRoute = `covidence:${datasourceId}`
  datasourceIdsToDelete.add(datasourceId)
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
        const importRoute = ${JSON.stringify(importRoute)}
        const files = await covidenceImportService.storeCovidencePackageFiles({
          datasourceId,
          files: [
            {
              file: new File(['Title,Authors,Published Year\\nStudy A,"Doe, Jane",2024\\n'], 'all.csv', {type: 'text/csv'}),
              fileRole: 'all',
            },
            {
              file: new File(['Title,Authors,Published Year,Ref\\nStudy B,"Roe, John",2023,screen-2\\n'], 'irrelevant.csv', {type: 'text/csv'}),
              fileRole: 'irrelevant',
            },
            {
              file: new File(['Title,Authors,Published Year,Covidence #\\nStudy C,"Lane, Kim",2022,#5003\\n'], 'full_text.csv', {type: 'text/csv'}),
              fileRole: 'full_text',
            },
          ],
        })
        const config = covidenceImportService.buildCovidencePackageConfig({files, mode: 'title_abstract'})

        await database.run(
          "INSERT INTO app.provider_connection (id, label, provider_kind, enabled) VALUES ('pc-covidence-screen-union', 'Covidence provider', 'openai-compatible', TRUE);"
          + "INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, enabled) VALUES ('model-covidence-screen-union', 'pc-covidence-screen-union', 'gpt-covidence', 'gpt-covidence', TRUE);"
          + "INSERT INTO app.import_route (id, route, name, active) VALUES ('route-covidence-screen-union', '${importRoute}', '${importRoute}', TRUE);"
        )

        const prompt = await covidenceImportService.getOrCreateCovidencePrompt({
          answerSet: 'yes|no|maybe',
          exclusionCriteria: 'Case reports',
          inclusionCriteria: 'Adults with confirmed disease',
          mode: 'title_abstract',
        })
        const project = await covidenceImportService.getOrCreateCovidenceProject({
          importRoute,
          mode: 'title_abstract',
          promptId: prompt.id,
          title: 'Covidence screen union project',
        })
        await database.run(\`UPDATE app.project SET human_judgment_mode = 'prompt' WHERE id = '\${project.id}'\`)

        await database.transaction(async (tx) => {
          await covidenceImportService.importCovidencePackageFromConfig({config, datasourceId, importRoute, tx})
          await covidenceImportService.seedCovidenceHumanJudgmentsFromConfig({config, importRoute, projectId: project.id, tx})
        })

        const judgmentRows = await database.queryJson(
          \`SELECT
            a.article_id AS articleExternalId,
            a.article_title AS articleTitle,
            jh.is_answered AS isAnswered,
            jh.answer AS answer,
            jh.prompt_id AS promptId
          FROM app.judgment_human jh
          INNER JOIN app.article a ON a.id = jh.article_id
          WHERE jh.project_id = '\${project.id}'
          ORDER BY a.article_title ASC, jh.prompt_id ASC\`
        )

        console.log(JSON.stringify({judgmentRows, promptId: prompt.id}))
        covidenceImportService.deleteCovidencePackageFiles(datasourceId)
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
        result.stderr.toString() || result.stdout.toString() || 'Failed to seed disjoint Covidence title/abstract rows',
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
      judgmentRows: Array<{
        answer: string | null
        articleExternalId: string
        articleTitle: string
        isAnswered: boolean
        promptId: string
      }>
      promptId: string
    }

    expect(parsed.judgmentRows).toHaveLength(3)
    expect(parsed.judgmentRows[0]?.answer).toBeNull()
    expect(parsed.judgmentRows[0]?.articleExternalId).toContain(`${importRoute}:title_year_first_author%3A`)
    expect(parsed.judgmentRows[0]?.articleTitle).toBe('Study A')
    expect(parsed.judgmentRows[0]?.isAnswered).toBe(false)
    expect(parsed.judgmentRows[0]?.promptId).toBe(parsed.promptId)
    expect(parsed.judgmentRows[1]).toEqual({
      answer: 'no',
      articleExternalId: `${importRoute}:reference_id%3Ascreen-2`,
      articleTitle: 'Study B',
      isAnswered: true,
      promptId: parsed.promptId,
    })
    expect(parsed.judgmentRows[2]).toEqual({
      answer: 'yes',
      articleExternalId: `${importRoute}:covidence%3A%235003`,
      articleTitle: 'Study C',
      isAnswered: true,
      promptId: parsed.promptId,
    })
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

test('syncCovidenceProjectPrompts persists summary-mode criteria metadata in prompt order', async () => {
  const duckdbPath = `/tmp/f1-covidence-summary-prompt-metadata-${Date.now()}.duckdb`
  const importRoute = `covidence:summary-prompt-metadata-${Date.now()}`
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
        const importRoute = ${JSON.stringify(importRoute)}

        await database.run(\`
          INSERT INTO app.provider_connection (id, label, provider_kind, enabled)
          VALUES ('pc-covidence-summary-prompt-metadata', 'Covidence provider', 'openai-compatible', TRUE);

          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, enabled)
          VALUES ('model-covidence-summary-prompt-metadata', 'pc-covidence-summary-prompt-metadata', 'gpt-covidence', 'gpt-covidence', TRUE);

          INSERT INTO app.import_route (id, route, name, active)
          VALUES ('route-covidence-summary-prompt-metadata', '\${importRoute}', '\${importRoute}', TRUE);
        \`)

        const promptDefinitions = covidenceImportService.buildCovidencePromptDefinitionsForEligibilityFields({
          answerSet: 'yes|no|maybe',
          eligibilityFields: [
            {
              disposition: 'include',
              sectionKey: 'population',
              sectionLabel: 'Population',
              text: 'Adults with confirmed disease',
            },
            {
              disposition: 'exclude',
              sectionKey: 'other',
              sectionLabel: 'Other',
              text: 'Case reports',
            },
          ],
          mode: 'title_abstract',
        })
        const prompts = await Promise.all(
          promptDefinitions.map((definition) => {
            return covidenceImportService.getOrCreateCovidencePrompt({promptDefinition: definition})
          }),
        )
        const project = await covidenceImportService.getOrCreateCovidenceProject({
          importRoute,
          mode: 'title_abstract',
          title: 'Covidence summary criteria project',
        })

        await covidenceImportService.syncCovidenceProjectPrompts({
          projectId: project.id,
          promptLinks: prompts.map((prompt, index) => {
            const definition = promptDefinitions[index]

            return {
              promptId: prompt.id,
              criteriaDisposition: definition?.criteriaDisposition,
              criteriaSectionKey: definition?.criteriaSectionKey,
              criteriaSectionLabel: definition?.criteriaSectionLabel,
            }
          }),
        })

        const [projectRow] = await database.queryJson(\`
          SELECT human_judgment_mode AS humanJudgmentMode
          FROM app.project
          WHERE id = '\${project.id}'
        \`)
        const projectPromptRows = await database.queryJson(\`
          SELECT
            prompt_id AS promptId,
            prompt_order AS promptOrder,
            criteria_disposition AS criteriaDisposition,
            criteria_section_key AS criteriaSectionKey,
            criteria_section_label AS criteriaSectionLabel
          FROM app.project_prompt
          WHERE project_id = '\${project.id}'
          ORDER BY prompt_order ASC
        \`)

        console.log(JSON.stringify({humanJudgmentMode: projectRow?.humanJudgmentMode ?? null, projectPromptRows}))
        await database.close()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '39987',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '39988',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.toString() || result.stdout.toString() || 'Failed to persist Covidence summary prompt metadata',
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
      humanJudgmentMode: string | null
      projectPromptRows: Array<{
        criteriaDisposition: string | null
        criteriaSectionKey: string | null
        criteriaSectionLabel: string | null
        promptId: string
        promptOrder: number
      }>
    }

    expect(parsed.humanJudgmentMode).toBe('summary')
    expect(parsed.projectPromptRows).toEqual([
      {
        criteriaDisposition: 'include',
        criteriaSectionKey: 'population',
        criteriaSectionLabel: 'Population',
        promptId: parsed.projectPromptRows[0]?.promptId ?? '',
        promptOrder: 0,
      },
      {
        criteriaDisposition: 'exclude',
        criteriaSectionKey: 'other',
        criteriaSectionLabel: 'Other',
        promptId: parsed.projectPromptRows[1]?.promptId ?? '',
        promptOrder: 1,
      },
    ])
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

test('seedCovidenceHumanJudgmentsFromConfig upserts full-text included and excluded judgments idempotently', async () => {
  const duckdbPath = `/tmp/f1-covidence-full-text-human-seed-${Date.now()}.duckdb`
  const datasourceId = `covidence-full-text-human-seed-${Date.now()}`
  const importRoute = `covidence:${datasourceId}`
  datasourceIdsToDelete.add(datasourceId)
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
        const importRoute = ${JSON.stringify(importRoute)}
        const createConfig = async (allContent, irrelevantContent, fullTextContent, excludedContent, includedContent) => {
          const files = await covidenceImportService.storeCovidencePackageFiles({
            datasourceId,
            files: [
              {file: new File([allContent], 'all.csv', {type: 'text/csv'}), fileRole: 'all'},
              {file: new File([irrelevantContent], 'irrelevant.csv', {type: 'text/csv'}), fileRole: 'irrelevant'},
              {file: new File([fullTextContent], 'full_text.csv', {type: 'text/csv'}), fileRole: 'full_text'},
              {file: new File([excludedContent], 'excluded.csv', {type: 'text/csv'}), fileRole: 'excluded'},
              {file: new File([includedContent], 'included.csv', {type: 'text/csv'}), fileRole: 'included'},
            ],
          })

          return covidenceImportService.buildCovidencePackageConfig({files, mode: 'full_text'})
        }

        await database.run(\`
          INSERT INTO app.provider_connection (id, label, provider_kind, enabled)
          VALUES ('pc-covidence-full-text-seed', 'Covidence provider', 'openai-compatible', TRUE);

          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, enabled)
          VALUES ('model-covidence-full-text-seed', 'pc-covidence-full-text-seed', 'gpt-covidence', 'gpt-covidence', TRUE);

          INSERT INTO app.import_route (id, route, name, active)
          VALUES ('route-covidence-full-text-seed', '${importRoute}', '${importRoute}', TRUE);
        \`)

        const prompt = await covidenceImportService.getOrCreateCovidencePrompt({
          answerSet: 'yes|no|maybe',
          exclusionCriteria: 'Case reports',
          inclusionCriteria: 'Adults with confirmed disease',
          mode: 'full_text',
        })
        const project = await covidenceImportService.getOrCreateCovidenceProject({
          importRoute,
          mode: 'full_text',
          promptId: prompt.id,
          title: 'Covidence full-text seeded project',
        })
        await database.run(\`UPDATE app.project SET human_judgment_mode = 'prompt' WHERE id = '\${project.id}'\`)

        const firstConfig = await createConfig(
          'Title,Authors,Year,DOI\\nStudy A,"Doe, Jane",2024,10.1000/alpha\\nStudy B,"Roe, John",2023,10.1000/beta\\nStudy C,"Lane, Kim",2022,10.1000/gamma\\nStudy D,"Poe, Sam",2021,10.1000/delta\\n',
          'Title,Authors,Year,DOI\\nStudy D,"Poe, Sam",2021,10.1000/delta\\n',
          'Title,Authors,Year,DOI\\nStudy A,"Doe, Jane",2024,10.1000/alpha\\n',
          'Title,Authors,Year,DOI,Reason for exclusion\\nStudy B,"Roe, John",2023,10.1000/beta,Wrong population\\n',
          'Title,Authors,Year,DOI\\nStudy C,"Lane, Kim",2022,10.1000/gamma\\n',
        )

        await database.transaction(async (tx) => {
          await covidenceImportService.importCovidencePackageFromConfig({config: firstConfig, datasourceId, importRoute, tx})
          await covidenceImportService.syncCovidenceProjectScopeFromConfig({config: firstConfig, importRoute, projectId: project.id, tx})
          await covidenceImportService.seedCovidenceHumanJudgmentsFromConfig({config: firstConfig, importRoute, projectId: project.id, tx})
        })

        const secondConfig = await createConfig(
          'Title,Authors,Year,DOI\\nStudy A,"Doe, Jane",2024,10.1000/alpha\\nStudy B,"Roe, John",2023,10.1000/beta\\nStudy C,"Lane, Kim",2022,10.1000/gamma\\nStudy D,"Poe, Sam",2021,10.1000/delta\\n',
          'Title,Authors,Year,DOI\\nStudy D,"Poe, Sam",2021,10.1000/delta\\n',
          'Title,Authors,Year,DOI\\nStudy C,"Lane, Kim",2022,10.1000/gamma\\n',
          'Title,Authors,Year,DOI,Reason for exclusion\\nStudy A,"Doe, Jane",2024,10.1000/alpha,Wrong comparator\\n',
          'Title,Authors,Year,DOI\\nStudy B,"Roe, John",2023,10.1000/beta\\n',
        )

        await database.transaction(async (tx) => {
          await covidenceImportService.syncCovidenceProjectScopeFromConfig({config: secondConfig, importRoute, projectId: project.id, tx})
          await covidenceImportService.seedCovidenceHumanJudgmentsFromConfig({config: secondConfig, importRoute, projectId: project.id, tx})
        })

        const judgmentRows = await database.queryJson(\`
          SELECT
            a.article_id AS articleExternalId,
            a.article_title AS articleTitle,
            jh.article_id AS articleId,
            jh.is_answered AS isAnswered,
            jh.answer AS answer,
            jh.comment AS comment,
            jh.prompt_id AS promptId
          FROM app.judgment_human jh
          INNER JOIN app.article a ON a.id = jh.article_id
          WHERE jh.project_id = '\${project.id}'
          ORDER BY a.article_title ASC, jh.prompt_id ASC
        \`)
        const projectArticleRows = await database.queryJson(\`
          SELECT
            a.article_id AS articleExternalId,
            a.article_title AS articleTitle,
            pa.imported_from_project_id AS importedFromProjectId,
            pa.project_id AS projectId
          FROM app.project_article pa
          INNER JOIN app.article a ON a.id = pa.article_id
          WHERE pa.project_id = '\${project.id}'
          ORDER BY a.article_title ASC
        \`)

        console.log(JSON.stringify({judgmentRows, projectArticleRows, projectId: project.id, promptId: prompt.id}))
        covidenceImportService.deleteCovidencePackageFiles(datasourceId)
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
        result.stderr.toString() || result.stdout.toString() || 'Failed to seed full-text Covidence human judgments',
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
      judgmentRows: Array<{
        answer: string | null
        articleExternalId: string
        articleId: string
        articleTitle: string
        comment: string | null
        isAnswered: boolean
        promptId: string
      }>
      projectArticleRows: Array<{
        articleExternalId: string
        articleTitle: string
        importedFromProjectId: string
        projectId: string
      }>
      projectId: string
      promptId: string
    }

    expect(parsed.judgmentRows).toHaveLength(3)
    expect(parsed.judgmentRows[0]).toMatchObject({
      answer: 'no',
      articleExternalId: `${importRoute}:doi%3A10.1000%2Falpha`,
      articleTitle: 'Study A',
      comment: null,
      isAnswered: true,
      promptId: parsed.promptId,
    })
    expect(typeof parsed.judgmentRows[0]?.articleId).toBe('string')
    expect(parsed.judgmentRows[1]).toMatchObject({
      answer: 'yes',
      articleExternalId: `${importRoute}:doi%3A10.1000%2Fbeta`,
      articleTitle: 'Study B',
      comment: null,
      isAnswered: true,
      promptId: parsed.promptId,
    })
    expect(typeof parsed.judgmentRows[1]?.articleId).toBe('string')
    expect(parsed.judgmentRows[2]).toMatchObject({
      answer: null,
      articleExternalId: `${importRoute}:doi%3A10.1000%2Fgamma`,
      articleTitle: 'Study C',
      comment: null,
      isAnswered: false,
      promptId: parsed.promptId,
    })
    expect(typeof parsed.judgmentRows[2]?.articleId).toBe('string')
    expect(parsed.projectArticleRows).toEqual([
      {
        articleExternalId: `${importRoute}:doi%3A10.1000%2Falpha`,
        articleTitle: 'Study A',
        importedFromProjectId: parsed.projectId,
        projectId: parsed.projectId,
      },
      {
        articleExternalId: `${importRoute}:doi%3A10.1000%2Fbeta`,
        articleTitle: 'Study B',
        importedFromProjectId: parsed.projectId,
        projectId: parsed.projectId,
      },
      {
        articleExternalId: `${importRoute}:doi%3A10.1000%2Fgamma`,
        articleTitle: 'Study C',
        importedFromProjectId: parsed.projectId,
        projectId: parsed.projectId,
      },
    ])
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

test('seedCovidenceHumanJudgmentsFromConfig seeds one summary judgment row per imported article for summary-mode projects', async () => {
  const duckdbPath = `/tmp/f1-covidence-summary-seed-${Date.now()}.duckdb`
  const datasourceId = `covidence-summary-seed-${Date.now()}`
  const importRoute = `covidence:${datasourceId}`
  datasourceIdsToDelete.add(datasourceId)
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
        const importRoute = ${JSON.stringify(importRoute)}
        const files = await covidenceImportService.storeCovidencePackageFiles({
          datasourceId,
          files: [
            {file: new File(['Title,Authors,Year,DOI\\nStudy A,"Doe, Jane",2024,10.1000/alpha\\nStudy B,"Roe, John",2023,10.1000/beta\\nStudy C,"Lane, Kim",2022,10.1000/gamma\\n'], 'all.csv', {type: 'text/csv'}), fileRole: 'all'},
            {file: new File(['Title,Authors,Year,DOI\\nStudy B,"Roe, John",2023,10.1000/beta\\n'], 'irrelevant.csv', {type: 'text/csv'}), fileRole: 'irrelevant'},
            {file: new File(['Title,Authors,Year,DOI\\nStudy A,"Doe, Jane",2024,10.1000/alpha\\n'], 'full_text.csv', {type: 'text/csv'}), fileRole: 'full_text'},
          ],
        })
        const config = covidenceImportService.buildCovidencePackageConfig({files, mode: 'title_abstract'})

        await database.run(\`
          INSERT INTO app.provider_connection (id, label, provider_kind, enabled)
          VALUES ('pc-covidence-summary-seed', 'Covidence provider', 'openai-compatible', TRUE);

          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, enabled)
          VALUES ('model-covidence-summary-seed', 'pc-covidence-summary-seed', 'gpt-covidence', 'gpt-covidence', TRUE);

          INSERT INTO app.import_route (id, route, name, active)
          VALUES ('route-covidence-summary-seed', '${importRoute}', '${importRoute}', TRUE);
        \`)

        const project = await covidenceImportService.getOrCreateCovidenceProject({
          importRoute,
          mode: 'title_abstract',
          title: 'Covidence summary seeded project',
        })

        await database.transaction(async (tx) => {
          await covidenceImportService.importCovidencePackageFromConfig({config, datasourceId, importRoute, tx})
          await covidenceImportService.seedCovidenceHumanJudgmentsFromConfig({config, importRoute, projectId: project.id, tx})
        })

        const summaryRows = await database.queryJson(\`
          SELECT
            a.article_id AS articleExternalId,
            a.article_title AS articleTitle,
            jhs.answer AS answer,
            jhs.origin AS origin
          FROM app.judgment_human_summary jhs
          INNER JOIN app.article a ON a.id = jhs.article_id
          WHERE jhs.project_id = '\${project.id}'
          ORDER BY a.article_title ASC
        \`)
        const promptRows = await database.queryJson(\`
          SELECT id
          FROM app.judgment_human
          WHERE project_id = '\${project.id}'
        \`)

        console.log(JSON.stringify({promptRows, project, summaryRows}))
        covidenceImportService.deleteCovidencePackageFiles(datasourceId)
        await database.close()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '39989',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '39990',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.toString() || result.stdout.toString() || 'Failed to seed summary-mode Covidence human judgments',
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
      project: {humanJudgmentMode: string}
      promptRows: Array<{id: string}>
      summaryRows: Array<{answer: string | null; articleExternalId: string; articleTitle: string; origin: string}>
    }

    expect(parsed.project.humanJudgmentMode).toBe('summary')
    expect(parsed.promptRows).toEqual([])
    expect(parsed.summaryRows).toEqual([
      {
        answer: 'yes',
        articleExternalId: `${importRoute}:doi%3A10.1000%2Falpha`,
        articleTitle: 'Study A',
        origin: 'covidence_import',
      },
      {
        answer: 'no',
        articleExternalId: `${importRoute}:doi%3A10.1000%2Fbeta`,
        articleTitle: 'Study B',
        origin: 'covidence_import',
      },
      {
        answer: null,
        articleExternalId: `${importRoute}:doi%3A10.1000%2Fgamma`,
        articleTitle: 'Study C',
        origin: 'covidence_import',
      },
    ])
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

test('parseCovidenceCsvReferenceRows keeps embedded newlines commas and escaped quotes inside quoted cells', () => {
  expect(
    parseCovidenceCsvReferenceRows({
      content: [
        'Title,Authors,Abstract,Notes',
        'Study A,"Doe, Jane","First line',
        'Second ""quoted"" line, with comma",Keep this',
      ].join('\n'),
      fileRole: 'all',
      format: 'csv',
      sourceFileName: 'all.csv',
    }),
  ).toEqual({
    ok: true,
    rows: [
      {
        citation: {abstract: 'First line\nSecond "quoted" line, with comma', authors: 'Doe, Jane', title: 'Study A'},
        exclusionReason: null,
        fileRole: 'all',
        notes: 'Keep this',
        rowNumber: 2,
        sourceFileName: 'all.csv',
        tags: [],
      },
    ],
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

test('parseCovidenceReferenceRows appends RIS continuation lines to the active field', () => {
  expect(
    parseCovidenceReferenceRows({
      content: [
        'TY  - JOUR',
        'TI  - Study A',
        'AB  - First line',
        ' second line',
        'N1  - First note',
        ' second note line',
        'ER  - ',
      ].join('\n'),
      fileRole: 'full_text',
      format: 'ris',
      sourceFileName: 'full_text.ris',
    }),
  ).toEqual({
    ok: true,
    rows: [
      {
        citation: {abstract: 'First line\nsecond line', reference_type: 'JOUR', title: 'Study A'},
        exclusionReason: null,
        fileRole: 'full_text',
        notes: 'First note\nsecond note line',
        rowNumber: 1,
        sourceFileName: 'full_text.ris',
        tags: [],
      },
    ],
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
        covidenceIds: candidate.covidenceIds,
        duplicateStudyRecordCount: candidate.duplicateStudyRecordCount,
        exclusionReasons: candidate.exclusionReasons,
        hasDuplicateStudyRecords: candidate.hasDuplicateStudyRecords,
        hasStudyDecisionConflict: candidate.hasStudyDecisionConflict,
        isSeededHumanJudgmentAnswered: candidate.isSeededHumanJudgmentAnswered,
        notes: candidate.notes,
        referenceIds: candidate.referenceIds,
        seededHumanJudgmentAnswer: candidate.seededHumanJudgmentAnswer,
        stageMembership: candidate.stageMembership,
        studyDecisionAnswers: candidate.studyDecisionAnswers,
        studyKey: candidate.studyKey,
        studyKeySource: candidate.studyKeySource,
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
      covidenceIds: [],
      duplicateStudyRecordCount: 1,
      exclusionReasons: [],
      hasDuplicateStudyRecords: false,
      hasStudyDecisionConflict: false,
      isSeededHumanJudgmentAnswered: false,
      notes: ['irrelevant note', 'full text note'],
      referenceIds: [],
      seededHumanJudgmentAnswer: null,
      stageMembership: {all: true, excluded: false, full_text: true, included: false, irrelevant: true},
      studyDecisionAnswers: [],
      studyKey: 'doi:10.1000/alpha',
      studyKeySource: 'doi',
      tags: ['all-tag', 'irrelevant-tag', 'full-text-tag'],
    },
    {
      articleKey: 'pmid:12345',
      articleKeySource: 'pmid',
      citation: {authors: 'Roe, John', pmid: '12345', title: 'Canonical PMID title', year: '2021'},
      covidenceIds: [],
      duplicateStudyRecordCount: 1,
      exclusionReasons: [],
      hasDuplicateStudyRecords: false,
      hasStudyDecisionConflict: false,
      isSeededHumanJudgmentAnswered: false,
      notes: ['pmid note'],
      referenceIds: [],
      seededHumanJudgmentAnswer: null,
      stageMembership: {all: true, excluded: false, full_text: true, included: false, irrelevant: false},
      studyDecisionAnswers: [],
      studyKey: 'pmid:12345',
      studyKeySource: 'pmid',
      tags: ['pmid-tag'],
    },
    {
      articleKey: 'reference_id:cov-3',
      articleKeySource: 'reference_id',
      citation: {authors: 'Lane, Kim', reference_id: 'cov-3', title: 'Canonical ref title', year: '2020'},
      covidenceIds: [],
      duplicateStudyRecordCount: 1,
      exclusionReasons: [],
      hasDuplicateStudyRecords: false,
      hasStudyDecisionConflict: false,
      isSeededHumanJudgmentAnswered: true,
      notes: ['included note'],
      referenceIds: ['cov-3', 'COV-3'],
      seededHumanJudgmentAnswer: 'yes',
      stageMembership: {all: true, excluded: false, full_text: false, included: true, irrelevant: false},
      studyDecisionAnswers: ['yes'],
      studyKey: 'reference_id:cov-3',
      studyKeySource: 'reference_id',
      tags: ['included-tag'],
    },
    {
      articleKey: `title_year_first_author:${getCovidenceFallbackHash('fallback title|2019|smith pat')}`,
      articleKeySource: 'title_year_first_author',
      citation: {authors: 'Smith, Pat; Roe, John', title: 'Fallback title', year: '2019'},
      covidenceIds: [],
      duplicateStudyRecordCount: 1,
      exclusionReasons: ['No outcome'],
      hasDuplicateStudyRecords: false,
      hasStudyDecisionConflict: false,
      isSeededHumanJudgmentAnswered: true,
      notes: ['excluded note', 'included fallback note'],
      referenceIds: [],
      seededHumanJudgmentAnswer: 'yes',
      stageMembership: {all: true, excluded: true, full_text: false, included: true, irrelevant: false},
      studyDecisionAnswers: ['yes'],
      studyKey: `title_year_first_author:${getCovidenceFallbackHash('fallback title|2019|smith pat')}`,
      studyKeySource: 'title_year_first_author',
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
  expect(merged.warnings.duplicateStudyGroups).toEqual([])
  expect(merged.warnings.studyDecisionConflicts).toEqual([])
})

test('mergeCovidenceReferenceRows unions disjoint title abstract stage rows without missing matches', () => {
  const merged = mergeCovidenceReferenceRows(
    [
      {
        citation: {authors: 'Doe, Jane', published_year: '2024', title: 'Study A'},
        exclusionReason: null,
        fileRole: 'all',
        notes: null,
        rowNumber: 2,
        sourceFileName: 'screen.csv',
        tags: ['screen'],
      },
      {
        citation: {authors: 'Doe, Jane', published_year: '2024', title: 'Study A'},
        exclusionReason: null,
        fileRole: 'full_text',
        notes: 'approved',
        rowNumber: 3,
        sourceFileName: 'select.csv',
        tags: ['select'],
      },
      {
        citation: {authors: 'Roe, John', published_year: '2023', ref: 'screen-2', title: 'Study B'},
        exclusionReason: 'Wrong population',
        fileRole: 'irrelevant',
        notes: 'excluded',
        rowNumber: 4,
        sourceFileName: 'irrelevant.csv',
        tags: ['irrelevant'],
      },
    ],
    'title_abstract',
  )

  expect(
    merged.candidates.map((candidate) => {
      return {
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
        referenceIds: candidate.referenceIds,
        seededHumanJudgmentAnswer: candidate.seededHumanJudgmentAnswer,
        stageMembership: candidate.stageMembership,
        studyDecisionAnswers: candidate.studyDecisionAnswers,
        studyKey: candidate.studyKey,
        studyKeySource: candidate.studyKeySource,
        tags: candidate.tags,
      }
    }),
  ).toEqual([
    {
      articleKey: `title_year_first_author:${getCovidenceFallbackHash('study a|2024|doe jane')}`,
      articleKeySource: 'title_year_first_author',
      citation: {authors: 'Doe, Jane', published_year: '2024', title: 'Study A'},
      covidenceIds: [],
      duplicateStudyRecordCount: 1,
      exclusionReasons: [],
      hasDuplicateStudyRecords: false,
      hasStudyDecisionConflict: false,
      isSeededHumanJudgmentAnswered: true,
      notes: ['approved'],
      referenceIds: [],
      seededHumanJudgmentAnswer: 'yes',
      stageMembership: {all: true, excluded: false, full_text: true, included: false, irrelevant: false},
      studyDecisionAnswers: ['yes'],
      studyKey: `title_year_first_author:${getCovidenceFallbackHash('study a|2024|doe jane')}`,
      studyKeySource: 'title_year_first_author',
      tags: ['screen', 'select'],
    },
    {
      articleKey: 'reference_id:screen-2',
      articleKeySource: 'reference_id',
      citation: {authors: 'Roe, John', published_year: '2023', ref: 'screen-2', title: 'Study B'},
      covidenceIds: [],
      duplicateStudyRecordCount: 1,
      exclusionReasons: ['Wrong population'],
      hasDuplicateStudyRecords: false,
      hasStudyDecisionConflict: false,
      isSeededHumanJudgmentAnswered: true,
      notes: ['excluded'],
      referenceIds: ['screen-2'],
      seededHumanJudgmentAnswer: 'no',
      stageMembership: {all: false, excluded: false, full_text: false, included: false, irrelevant: true},
      studyDecisionAnswers: ['no'],
      studyKey: 'reference_id:screen-2',
      studyKeySource: 'reference_id',
      tags: ['irrelevant'],
    },
  ])
  expect(merged.warnings).toEqual({
    conflictingStageMemberships: [],
    duplicateStudyGroups: [],
    missingMatches: [],
    studyDecisionConflicts: [],
  })
})

test('analyzeCovidencePackageFiles returns detected roles counts warnings and sample merged rows', async () => {
  const result = await analyzeCovidencePackageFiles({
    files: [
      {
        file: new File(['Title,Authors,Published Year\nStudy A,"Doe, Jane",2024\n'], 'all.csv', {type: 'text/csv'}),
        fileRole: 'all',
      },
      {
        file: new File(['Title,Authors,Published Year\nStudy A,"Doe, Jane",2024\n'], 'full_text.csv', {
          type: 'text/csv',
        }),
        fileRole: 'full_text',
      },
      {
        file: new File(['Title,Authors,Published Year,Ref\nStudy B,"Roe, John",2023,screen-2\n'], 'irrelevant.csv', {
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
    duplicateStudyGroupCount: 0,
    fileCount: 3,
    filesByRole: {all: 1, excluded: 0, full_text: 1, included: 0, irrelevant: 1},
    mergedRowCount: 2,
    missingMatchCount: 0,
    rowCount: 3,
    rowsByRole: {all: 1, excluded: 0, full_text: 1, included: 0, irrelevant: 1},
    studyDecisionConflictCount: 0,
    studyGroupCount: 2,
  })
  expect(result.data.warnings.missingMatches).toEqual([])
  expect(result.data.warnings.conflictingStageMemberships).toEqual([])
  expect(result.data.warnings.duplicateStudyGroups).toEqual([])
  expect(result.data.warnings.studyDecisionConflicts).toEqual([])
  expect(result.data.sampleMergedRows).toEqual([
    {
      articleKey: `title_year_first_author:${getCovidenceFallbackHash('study a|2024|doe jane')}`,
      articleKeySource: 'title_year_first_author',
      citation: {authors: 'Doe, Jane', published_year: '2024', title: 'Study A'},
      duplicateStudyRecordCount: 1,
      exclusionReasons: [],
      hasDuplicateStudyRecords: false,
      hasStudyDecisionConflict: false,
      notes: [],
      stageMembership: {all: true, excluded: false, full_text: true, included: false, irrelevant: false},
      studyKey: `title_year_first_author:${getCovidenceFallbackHash('study a|2024|doe jane')}`,
      studyKeySource: 'title_year_first_author',
      tags: [],
    },
    {
      articleKey: 'reference_id:screen-2',
      articleKeySource: 'reference_id',
      citation: {authors: 'Roe, John', published_year: '2023', ref: 'screen-2', title: 'Study B'},
      duplicateStudyRecordCount: 1,
      exclusionReasons: [],
      hasDuplicateStudyRecords: false,
      hasStudyDecisionConflict: false,
      notes: [],
      stageMembership: {all: false, excluded: false, full_text: false, included: false, irrelevant: true},
      studyKey: 'reference_id:screen-2',
      studyKeySource: 'reference_id',
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

test('analyzeCovidencePackageFiles returns mutually exclusive stage memberships as warnings', async () => {
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

  expect(result.ok).toBe(true)

  if (result.ok === false) {
    throw new Error('Expected Covidence analyze warning success')
  }

  expect(result.data.counts.conflictingStageMembershipCount).toBe(1)
  expect(result.data.warnings.conflictingStageMemberships).toHaveLength(1)
  expect(result.data.warnings.missingMatches).toEqual([])
})
