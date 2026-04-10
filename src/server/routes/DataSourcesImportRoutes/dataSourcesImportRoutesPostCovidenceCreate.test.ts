import {expect, test} from 'bun:test'

type CovidenceCreateSuccessResult = {
  deleteCalls: string[]
  getDataSourceCallCount: number
  martQueueCalls?: Array<{importRouteIds: string[]; reason: string}>
  projectCalls?: Array<{importRoute: string; mode: string; promptId: string | null; title: string}>
  promptCalls?: Array<{promptDefinition: {originalText: string; promptHeading: string; type: string}}>
  promptSyncCalls?: Array<{projectId: string; promptIds: string[]}>
  queueCalls: string[][]
  seedCalls?: Array<{importRoute: string; mode: string; projectId: string | null}>
  scopeCalls?: Array<{importRoute: string; mode: string; projectId: string | null}>
  result: {
    data: {
      covidencePackageConfig: {kind: 'covidence_import'; mode: 'full_text' | 'title_abstract'; version: 1}
      covidenceProject?: {created: boolean; id: string; name: string} | null
      covidencePrompts?: Array<{created: boolean; id: string; promptHeading: string; type: string}>
    }
    success: boolean
  }
  storedFileCalls: Array<{datasourceId: string; files: Array<{fileName: string; fileRole: string}>}>
  transactionCallCount: number
  txStatements: string[]
}

type CovidenceCreateFailureResult = {
  deleteCalls: string[]
  errorMessage: string | null
  getDataSourceCallCount: number
  transactionCallCount: number
}

const getLastJsonLine = (stdout: string) => {
  return (
    stdout
      .split('\n')
      .map((line) => {
        return line.trim()
      })
      .filter((line) => {
        return line !== ''
      })
      .at(-1) ?? ''
  )
}

test('Covidence datasource create stores package files and persists cursor config in one transaction', () => {
  const runRoute = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const appDatabaseServiceModulePath = new URL('./src/server/services/appDatabaseService.ts', 'file://' + process.cwd() + '/').pathname
        const articleImportStoreServiceModulePath = new URL('./src/server/services/articleImportStoreService.ts', 'file://' + process.cwd() + '/').pathname
        const covidenceImportServiceModulePath = new URL('./src/server/services/covidenceImportService.ts', 'file://' + process.cwd() + '/').pathname
        const dataSourceQueryServiceModulePath = new URL('./src/server/services/dataSourceQueryService.ts', 'file://' + process.cwd() + '/').pathname
        const duckdbMartRefreshServiceModulePath = new URL('./src/server/services/getDuckdbMartRefreshService.ts', 'file://' + process.cwd() + '/').pathname

        const state = {
          deleteCalls: [],
          getDataSourceCallCount: 0,
          martQueueCalls: [],
          projectCalls: [],
          queueCalls: [],
          seedCalls: [],
          scopeCalls: [],
          storedFileCalls: [],
          transactionCallCount: 0,
          txStatements: [],
        }

        void mock.module(articleImportStoreServiceModulePath, () => {
          return {
            queueImportedArticleRefreshes: async (importRouteIds) => {
              state.queueCalls.push(importRouteIds)
            },
          }
        })

        void mock.module(duckdbMartRefreshServiceModulePath, () => {
          return {
            getDuckdbMartRefreshService: () => {
              return {
                queueProjectRefreshesByImportRouteIds: async (importRouteIds, reason) => {
                  state.martQueueCalls.push({importRouteIds, reason})
                },
              }
            },
          }
        })

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                transaction: async (work) => {
                  state.transactionCallCount += 1
                  return await work({
                    run: async (statement) => {
                      state.txStatements.push(statement)
                    },
                  })
                },
              }
            },
          }
        })

        void mock.module(covidenceImportServiceModulePath, () => {
          return {
            buildCovidencePromptDefinition: (params) => {
              return {originalText: 'Prompt body', promptHeading: 'Prompt heading', type: params.answerSet === 'yes|no' ? "'yes' | 'no'" : "'yes' | 'no' | 'unsure'"}
            },
            buildCovidencePromptDefinitionsForEligibilityFields: () => {
              return []
            },
            buildCovidencePackageConfig: (params) => {
              return {kind: 'covidence_import', version: 1, ...params}
            },
            deleteCovidencePackageFiles: (datasourceId) => {
              state.deleteCalls.push(datasourceId)
            },
            getCovidencePackageCursor: (config) => {
              return JSON.stringify(config)
            },
            getOrCreateCovidenceProject: async (params) => {
              state.projectCalls.push({...params, tx: undefined})
              return {
                created: true,
                id: 'project-created',
                modelId: 'model-default',
                name: params.title,
                useAbstract: true,
                useFulltext: false,
                useFulltextNoImages: false,
                useTitle: true,
              }
            },
            getOrCreateCovidencePrompt: async () => {
              return null
            },
            importCovidencePackageFromConfig: async () => {
              return {importRouteIds: ['route-1'], stats: {importedCount: 2, itemCount: 2}}
            },
            seedCovidenceHumanJudgmentsFromConfig: async (params) => {
              state.seedCalls.push({importRoute: params.importRoute, mode: params.config.mode, projectId: params.projectId ?? null})
            },
            storeCovidencePackageFiles: async (params) => {
              state.storedFileCalls.push({
                datasourceId: params.datasourceId,
                files: params.files.map((entry) => {
                  return {fileName: entry.file.name, fileRole: entry.fileRole}
                }),
              })

              return [
                {
                  assetPath: 'assets/covidence_imports/' + params.datasourceId + '/all-all.csv',
                  fileRole: 'all',
                  format: 'csv',
                  sourceFileName: 'all.csv',
                },
                {
                  assetPath: 'assets/covidence_imports/' + params.datasourceId + '/irrelevant-irrelevant.csv',
                  fileRole: 'irrelevant',
                  format: 'csv',
                  sourceFileName: 'irrelevant.csv',
                },
                {
                  assetPath: 'assets/covidence_imports/' + params.datasourceId + '/full_text-full_text.ris',
                  fileRole: 'full_text',
                  format: 'ris',
                  sourceFileName: 'full_text.ris',
                },
              ]
            },
            syncCovidenceProjectPrompts: async () => {},
            syncCovidenceProjectScopeFromConfig: async (params) => {
              state.scopeCalls.push({importRoute: params.importRoute, mode: params.config.mode, projectId: params.projectId ?? null})
            },
          }
        })

        void mock.module(dataSourceQueryServiceModulePath, () => {
          return {
            getDataSourceQueryService: () => {
              return {
                getDataSourceById: async (id) => {
                  state.getDataSourceCallCount += 1
                  return {
                    archived: false,
                    createdAt: new Date('2026-01-01T00:00:00.000Z'),
                    cursor: 'cursor-json',
                    dateFrom: null,
                    dateTo: null,
                    description: 'Created from Covidence package',
                    id,
                    importRoute: 'covidence:' + id,
                    itemsAfterLastImport: 0,
                    lastImportAt: null,
                    title: 'Created datasource',
                    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
                  }
                },
              }
            },
          }
        })

        const {dataSourcesImportRoutesPostCovidenceCreate} = await import(
          './src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceCreate.ts?test=' + Date.now(),
        )

        const result = await dataSourcesImportRoutesPostCovidenceCreate({
          description: 'Created from Covidence package',
          files: [
            {file: new File(['a,b\\n1,2\\n'], 'all.csv', {type: 'text/csv'}), fileRole: 'all'},
            {file: new File(['a,b\\n3,4\\n'], 'irrelevant.csv', {type: 'text/csv'}), fileRole: 'irrelevant'},
            {file: new File(['TY  - JOUR\\nER  - \\n'], 'full_text.ris', {type: 'text/plain'}), fileRole: 'full_text'},
          ],
          mode: 'title_abstract',
          title: 'Created datasource',
        })

        console.log(JSON.stringify({...state, result}))
      `,
    ],
    {cwd: process.cwd(), env: process.env},
  )

  if (runRoute.exitCode !== 0) {
    throw new Error(runRoute.stderr.toString() || runRoute.stdout.toString() || 'Covidence create success test failed')
  }

  const parsed = JSON.parse(getLastJsonLine(runRoute.stdout.toString())) as CovidenceCreateSuccessResult

  expect(parsed.transactionCallCount).toBe(1)
  expect(parsed.storedFileCalls).toHaveLength(1)
  expect(parsed.storedFileCalls[0]?.files).toEqual([
    {fileName: 'all.csv', fileRole: 'all'},
    {fileName: 'irrelevant.csv', fileRole: 'irrelevant'},
    {fileName: 'full_text.ris', fileRole: 'full_text'},
  ])
  expect(parsed.txStatements).toHaveLength(3)
  expect(parsed.txStatements[0]).toContain('INSERT INTO app.data_source')
  expect(parsed.txStatements[1]).toContain('UPDATE app.import_route')
  expect(parsed.txStatements[2]).toContain('items_after_last_import = 2')
  expect(parsed.txStatements[2]).toContain('covidence:')
  expect(parsed.txStatements[2]).toContain('covidence_import')
  expect(parsed.deleteCalls).toEqual([])
  expect(parsed.projectCalls).toHaveLength(1)
  expect(parsed.projectCalls?.[0]?.importRoute).toContain('covidence:')
  expect(parsed.projectCalls?.[0]?.mode).toBe('title_abstract')
  expect(parsed.projectCalls?.[0]?.promptId).toBeNull()
  expect(parsed.projectCalls?.[0]?.title).toBe('Created datasource')
  expect(parsed.seedCalls).toHaveLength(1)
  expect(parsed.seedCalls?.[0]?.importRoute).toContain('covidence:')
  expect(parsed.seedCalls?.[0]?.mode).toBe('title_abstract')
  expect(parsed.seedCalls?.[0]?.projectId).toBe('project-created')
  expect(parsed.scopeCalls).toHaveLength(1)
  expect(parsed.scopeCalls?.[0]?.importRoute).toContain('covidence:')
  expect(parsed.scopeCalls?.[0]?.mode).toBe('title_abstract')
  expect(parsed.scopeCalls?.[0]?.projectId).toBe('project-created')
  expect(parsed.martQueueCalls).toEqual([])
  expect(parsed.queueCalls).toEqual([['route-1']])
  expect(parsed.getDataSourceCallCount).toBe(1)
  expect(parsed.result.success).toBe(true)
  expect(parsed.result.data.covidencePackageConfig).toMatchObject({
    kind: 'covidence_import',
    mode: 'title_abstract',
    version: 1,
  })
  expect(parsed.result.data.covidenceProject).toMatchObject({
    created: true,
    id: 'project-created',
    name: 'Created datasource',
  })
})

test('Covidence datasource create deletes stored files when the transaction fails', () => {
  const runRoute = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const appDatabaseServiceModulePath = new URL('./src/server/services/appDatabaseService.ts', 'file://' + process.cwd() + '/').pathname
        const articleImportStoreServiceModulePath = new URL('./src/server/services/articleImportStoreService.ts', 'file://' + process.cwd() + '/').pathname
        const covidenceImportServiceModulePath = new URL('./src/server/services/covidenceImportService.ts', 'file://' + process.cwd() + '/').pathname
        const dataSourceQueryServiceModulePath = new URL('./src/server/services/dataSourceQueryService.ts', 'file://' + process.cwd() + '/').pathname
        const duckdbMartRefreshServiceModulePath = new URL('./src/server/services/getDuckdbMartRefreshService.ts', 'file://' + process.cwd() + '/').pathname

        const state = {
          deleteCalls: [],
          errorMessage: null,
          getDataSourceCallCount: 0,
          transactionCallCount: 0,
        }

        void mock.module(articleImportStoreServiceModulePath, () => {
          return {
            queueImportedArticleRefreshes: async () => {},
          }
        })

        void mock.module(duckdbMartRefreshServiceModulePath, () => {
          return {
            getDuckdbMartRefreshService: () => {
              return {
                queueProjectRefreshesByImportRouteIds: async () => {},
              }
            },
          }
        })

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                transaction: async () => {
                  state.transactionCallCount += 1
                  throw new Error('boom')
                },
              }
            },
          }
        })

        void mock.module(covidenceImportServiceModulePath, () => {
          return {
            buildCovidencePromptDefinition: (params) => {
              return {originalText: 'Prompt body', promptHeading: 'Prompt heading', type: params.answerSet === 'yes|no' ? "'yes' | 'no'" : "'yes' | 'no' | 'unsure'"}
            },
            buildCovidencePromptDefinitionsForEligibilityFields: () => {
              return []
            },
            buildCovidencePackageConfig: (params) => {
              return {kind: 'covidence_import', version: 1, ...params}
            },
            deleteCovidencePackageFiles: (datasourceId) => {
              state.deleteCalls.push(datasourceId)
            },
            getCovidencePackageCursor: (config) => {
              return JSON.stringify(config)
            },
            getOrCreateCovidenceProject: async () => {
              return null
            },
            getOrCreateCovidencePrompt: async () => {
              return null
            },
            importCovidencePackageFromConfig: async () => {
              return {importRouteIds: ['route-1'], stats: {importedCount: 2, itemCount: 2}}
            },
            seedCovidenceHumanJudgmentsFromConfig: async () => {},
            storeCovidencePackageFiles: async (params) => {
              return [
                {
                  assetPath: 'assets/covidence_imports/' + params.datasourceId + '/all-all.csv',
                  fileRole: 'all',
                  format: 'csv',
                  sourceFileName: 'all.csv',
                },
                {
                  assetPath: 'assets/covidence_imports/' + params.datasourceId + '/irrelevant-irrelevant.csv',
                  fileRole: 'irrelevant',
                  format: 'csv',
                  sourceFileName: 'irrelevant.csv',
                },
                {
                  assetPath: 'assets/covidence_imports/' + params.datasourceId + '/full_text-full_text.ris',
                  fileRole: 'full_text',
                  format: 'ris',
                  sourceFileName: 'full_text.ris',
                },
              ]
            },
            syncCovidenceProjectPrompts: async () => {},
            syncCovidenceProjectScopeFromConfig: async () => {},
          }
        })

        void mock.module(dataSourceQueryServiceModulePath, () => {
          return {
            getDataSourceQueryService: () => {
              return {
                getDataSourceById: async () => {
                  state.getDataSourceCallCount += 1
                  return null
                },
              }
            },
          }
        })

        const {dataSourcesImportRoutesPostCovidenceCreate} = await import(
          './src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceCreate.ts?test=' + Date.now(),
        )

        try {
          await dataSourcesImportRoutesPostCovidenceCreate({
            files: [
              {file: new File(['a,b\\n1,2\\n'], 'all.csv', {type: 'text/csv'}), fileRole: 'all'},
              {file: new File(['a,b\\n3,4\\n'], 'irrelevant.csv', {type: 'text/csv'}), fileRole: 'irrelevant'},
              {file: new File(['TY  - JOUR\\nER  - \\n'], 'full_text.ris', {type: 'text/plain'}), fileRole: 'full_text'},
            ],
            mode: 'title_abstract',
            title: 'Created datasource',
          })
        } catch (error) {
          state.errorMessage = error instanceof Error ? error.message : String(error)
        }

        console.log(JSON.stringify(state))
      `,
    ],
    {cwd: process.cwd(), env: process.env},
  )

  if (runRoute.exitCode !== 0) {
    throw new Error(runRoute.stderr.toString() || runRoute.stdout.toString() || 'Covidence create failure test failed')
  }

  const parsed = JSON.parse(getLastJsonLine(runRoute.stdout.toString())) as CovidenceCreateFailureResult

  expect(parsed.errorMessage).toBe('boom')
  expect(parsed.transactionCallCount).toBe(1)
  expect(parsed.deleteCalls).toHaveLength(1)
  expect(parsed.getDataSourceCallCount).toBe(0)
})

test('Covidence datasource create builds or reuses the screening prompt when criteria are provided', () => {
  const runRoute = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const appDatabaseServiceModulePath = new URL('./src/server/services/appDatabaseService.ts', 'file://' + process.cwd() + '/').pathname
        const articleImportStoreServiceModulePath = new URL('./src/server/services/articleImportStoreService.ts', 'file://' + process.cwd() + '/').pathname
        const covidenceImportServiceModulePath = new URL('./src/server/services/covidenceImportService.ts', 'file://' + process.cwd() + '/').pathname
        const dataSourceQueryServiceModulePath = new URL('./src/server/services/dataSourceQueryService.ts', 'file://' + process.cwd() + '/').pathname
        const duckdbMartRefreshServiceModulePath = new URL('./src/server/services/getDuckdbMartRefreshService.ts', 'file://' + process.cwd() + '/').pathname

        const state = {
          deleteCalls: [],
          getDataSourceCallCount: 0,
          martQueueCalls: [],
          projectCalls: [],
          promptCalls: [],
          promptSyncCalls: [],
          queueCalls: [],
          seedCalls: [],
          scopeCalls: [],
          storedFileCalls: [],
          transactionCallCount: 0,
          txStatements: [],
        }

        void mock.module(articleImportStoreServiceModulePath, () => {
          return {
            queueImportedArticleRefreshes: async (importRouteIds) => {
              state.queueCalls.push(importRouteIds)
            },
          }
        })

        void mock.module(duckdbMartRefreshServiceModulePath, () => {
          return {
            getDuckdbMartRefreshService: () => {
              return {
                queueProjectRefreshesByImportRouteIds: async (importRouteIds, reason) => {
                  state.martQueueCalls.push({importRouteIds, reason})
                },
              }
            },
          }
        })

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                transaction: async (work) => {
                  state.transactionCallCount += 1
                  return await work({
                    queryJson: async () => [],
                    run: async (statement) => {
                      state.txStatements.push(statement)
                    },
                  })
                },
              }
            },
          }
        })

        void mock.module(covidenceImportServiceModulePath, () => {
          return {
            buildCovidencePromptDefinition: (params) => {
              return {originalText: 'Prompt body', promptHeading: 'Prompt heading', type: params.answerSet === 'yes|no' ? "'yes' | 'no'" : "'yes' | 'no' | 'unsure'"}
            },
            buildCovidencePromptDefinitionsForEligibilityFields: ({answerSet, eligibilityFields, mode}) => {
              const question = mode === 'full_text'
                ? 'Based on the inclusion and exclusion criteria, should this study be included in the final review?'
                : 'Based on the inclusion and exclusion criteria, should this study be included for full text review?'
              const allowedAnswers = answerSet === 'yes|no' ? 'yes, no' : 'yes, no, unsure'

              return eligibilityFields.map((eligibilityField) => {
                return {
                  originalText: [
                    question,
                    '',
                    'Allowed answers: ' + allowedAnswers,
                    '',
                    (eligibilityField.disposition === 'include' ? 'Include criterion' : 'Exclude criterion') + ' (' + eligibilityField.sectionLabel + '):',
                    eligibilityField.text,
                  ].join('\\n'),
                  promptHeading: 'Covidence title/abstract screening | ' + eligibilityField.sectionLabel + ' | ' + eligibilityField.disposition,
                  type: answerSet === 'yes|no' ? "'yes' | 'no'" : "'yes' | 'no' | 'unsure'",
                }
              })
            },
            buildCovidencePackageConfig: (params) => {
              return {kind: 'covidence_import', version: 1, ...params}
            },
            deleteCovidencePackageFiles: (datasourceId) => {
              state.deleteCalls.push(datasourceId)
            },
            getCovidencePackageCursor: (config) => {
              return JSON.stringify(config)
            },
            getOrCreateCovidenceProject: async (params) => {
              state.projectCalls.push({...params, tx: undefined})
              return {
                created: true,
                id: 'project-created',
                modelId: 'model-default',
                name: params.title,
                useAbstract: true,
                useFulltext: false,
                useFulltextNoImages: false,
                useTitle: true,
              }
            },
            getOrCreateCovidencePrompt: async (params) => {
              state.promptCalls.push({...params, tx: undefined})
              const promptIndex = state.promptCalls.length

              return {
                created: false,
                id: 'prompt-existing-' + promptIndex,
                originalText: params.promptDefinition.originalText,
                promptHeading: params.promptDefinition.promptHeading,
                type: params.promptDefinition.type,
              }
            },
            importCovidencePackageFromConfig: async () => {
              return {importRouteIds: ['route-1'], stats: {importedCount: 2, itemCount: 2}}
            },
            seedCovidenceHumanJudgmentsFromConfig: async (params) => {
              state.seedCalls.push({importRoute: params.importRoute, mode: params.config.mode, projectId: params.projectId ?? null})
            },
            storeCovidencePackageFiles: async (params) => {
              state.storedFileCalls.push({
                datasourceId: params.datasourceId,
                files: params.files.map((entry) => {
                  return {fileName: entry.file.name, fileRole: entry.fileRole}
                }),
              })

              return [
                {
                  assetPath: 'assets/covidence_imports/' + params.datasourceId + '/all-all.csv',
                  fileRole: 'all',
                  format: 'csv',
                  sourceFileName: 'all.csv',
                },
                {
                  assetPath: 'assets/covidence_imports/' + params.datasourceId + '/irrelevant-irrelevant.csv',
                  fileRole: 'irrelevant',
                  format: 'csv',
                  sourceFileName: 'irrelevant.csv',
                },
                {
                  assetPath: 'assets/covidence_imports/' + params.datasourceId + '/full_text-full_text.ris',
                  fileRole: 'full_text',
                  format: 'ris',
                  sourceFileName: 'full_text.ris',
                },
              ]
            },
            syncCovidenceProjectPrompts: async (params) => {
              state.promptSyncCalls.push({...params, tx: undefined})
            },
            syncCovidenceProjectScopeFromConfig: async (params) => {
              state.scopeCalls.push({importRoute: params.importRoute, mode: params.config.mode, projectId: params.projectId ?? null})
            },
          }
        })

        void mock.module(dataSourceQueryServiceModulePath, () => {
          return {
            getDataSourceQueryService: () => {
              return {
                getDataSourceById: async (id) => {
                  state.getDataSourceCallCount += 1
                  return {
                    archived: false,
                    createdAt: new Date('2026-01-01T00:00:00.000Z'),
                    cursor: 'cursor-json',
                    dateFrom: null,
                    dateTo: null,
                    description: 'Created from Covidence package',
                    id,
                    importRoute: 'covidence:' + id,
                    itemsAfterLastImport: 0,
                    lastImportAt: null,
                    title: 'Created datasource',
                    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
                  }
                },
              }
            },
          }
        })

        const {dataSourcesImportRoutesPostCovidenceCreate} = await import(
          './src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceCreate.ts?test=' + Date.now(),
        )

        const result = await dataSourcesImportRoutesPostCovidenceCreate({
          answerSet: 'yes|no|unsure',
          description: 'Created from Covidence package',
          eligibilityFields: [
            {disposition: 'include', sectionKey: ' population ', sectionLabel: ' Population ', text: ' Adults with confirmed disease '},
            {disposition: 'exclude', sectionKey: ' other ', sectionLabel: ' Other ', text: ' Case reports '},
            {disposition: 'include', sectionKey: ' outcome ', sectionLabel: ' Outcome ', text: '   '},
          ],
          files: [
            {file: new File(['a,b\\n1,2\\n'], 'all.csv', {type: 'text/csv'}), fileRole: 'all'},
            {file: new File(['a,b\\n3,4\\n'], 'irrelevant.csv', {type: 'text/csv'}), fileRole: 'irrelevant'},
            {file: new File(['TY  - JOUR\\nER  - \\n'], 'full_text.ris', {type: 'text/plain'}), fileRole: 'full_text'},
          ],
          mode: 'title_abstract',
          title: 'Created datasource',
        })

        console.log(JSON.stringify({...state, result}))
      `,
    ],
    {cwd: process.cwd(), env: process.env},
  )

  if (runRoute.exitCode !== 0) {
    throw new Error(runRoute.stderr.toString() || runRoute.stdout.toString() || 'Covidence create prompt test failed')
  }

  const parsed = JSON.parse(getLastJsonLine(runRoute.stdout.toString())) as CovidenceCreateSuccessResult

  expect(parsed.promptCalls).toEqual([
    {
      promptDefinition: {
        originalText: [
          'Based on the inclusion and exclusion criteria, should this study be included for full text review?',
          '',
          'Allowed answers: yes, no, unsure',
          '',
          'Include criterion (Population):',
          'Adults with confirmed disease',
        ].join('\n'),
        promptHeading: 'Covidence title/abstract screening | Population | include',
        type: "'yes' | 'no' | 'unsure'",
      },
    },
    {
      promptDefinition: {
        originalText: [
          'Based on the inclusion and exclusion criteria, should this study be included for full text review?',
          '',
          'Allowed answers: yes, no, unsure',
          '',
          'Exclude criterion (Other):',
          'Case reports',
        ].join('\n'),
        promptHeading: 'Covidence title/abstract screening | Other | exclude',
        type: "'yes' | 'no' | 'unsure'",
      },
    },
  ])
  expect(parsed.projectCalls).toHaveLength(1)
  expect(parsed.projectCalls?.[0]?.importRoute).toContain('covidence:')
  expect(parsed.projectCalls?.[0]?.mode).toBe('title_abstract')
  expect(parsed.projectCalls?.[0]?.promptId).toBeNull()
  expect(parsed.projectCalls?.[0]?.title).toBe('Created datasource')
  expect(parsed.promptSyncCalls).toEqual([
    {projectId: 'project-created', promptIds: ['prompt-existing-1', 'prompt-existing-2']},
  ])
  expect(parsed.seedCalls).toHaveLength(1)
  expect(parsed.seedCalls?.[0]?.importRoute).toContain('covidence:')
  expect(parsed.seedCalls?.[0]?.mode).toBe('title_abstract')
  expect(parsed.seedCalls?.[0]?.projectId).toBe('project-created')
  expect(parsed.scopeCalls).toHaveLength(1)
  expect(parsed.scopeCalls?.[0]?.importRoute).toContain('covidence:')
  expect(parsed.scopeCalls?.[0]?.mode).toBe('title_abstract')
  expect(parsed.scopeCalls?.[0]?.projectId).toBe('project-created')
  expect(parsed.martQueueCalls).toEqual([])
  expect(parsed.result.data.covidenceProject).toMatchObject({
    created: true,
    id: 'project-created',
    name: 'Created datasource',
  })
  expect(parsed.result.data.covidencePrompts).toEqual([
    {
      created: false,
      id: 'prompt-existing-1',
      originalText: [
        'Based on the inclusion and exclusion criteria, should this study be included for full text review?',
        '',
        'Allowed answers: yes, no, unsure',
        '',
        'Include criterion (Population):',
        'Adults with confirmed disease',
      ].join('\n'),
      promptHeading: 'Covidence title/abstract screening | Population | include',
      type: "'yes' | 'no' | 'unsure'",
    },
    {
      created: false,
      id: 'prompt-existing-2',
      originalText: [
        'Based on the inclusion and exclusion criteria, should this study be included for full text review?',
        '',
        'Allowed answers: yes, no, unsure',
        '',
        'Exclude criterion (Other):',
        'Case reports',
      ].join('\n'),
      promptHeading: 'Covidence title/abstract screening | Other | exclude',
      type: "'yes' | 'no' | 'unsure'",
    },
  ])
})

test('Covidence datasource create also creates or reuses a full-text project with scoped articles', () => {
  const runRoute = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const appDatabaseServiceModulePath = new URL('./src/server/services/appDatabaseService.ts', 'file://' + process.cwd() + '/').pathname
        const articleImportStoreServiceModulePath = new URL('./src/server/services/articleImportStoreService.ts', 'file://' + process.cwd() + '/').pathname
        const covidenceImportServiceModulePath = new URL('./src/server/services/covidenceImportService.ts', 'file://' + process.cwd() + '/').pathname
        const dataSourceQueryServiceModulePath = new URL('./src/server/services/dataSourceQueryService.ts', 'file://' + process.cwd() + '/').pathname
        const duckdbMartRefreshServiceModulePath = new URL('./src/server/services/getDuckdbMartRefreshService.ts', 'file://' + process.cwd() + '/').pathname

        const state = {
          deleteCalls: [],
          getDataSourceCallCount: 0,
          martQueueCalls: [],
          projectCalls: [],
          promptCalls: [],
          promptSyncCalls: [],
          queueCalls: [],
          seedCalls: [],
          scopeCalls: [],
          storedFileCalls: [],
          transactionCallCount: 0,
          txStatements: [],
        }

        void mock.module(articleImportStoreServiceModulePath, () => {
          return {
            queueImportedArticleRefreshes: async (importRouteIds) => {
              state.queueCalls.push(importRouteIds)
            },
          }
        })

        void mock.module(duckdbMartRefreshServiceModulePath, () => {
          return {
            getDuckdbMartRefreshService: () => {
              return {
                queueProjectRefreshesByImportRouteIds: async (importRouteIds, reason) => {
                  state.martQueueCalls.push({importRouteIds, reason})
                },
              }
            },
          }
        })

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                transaction: async (work) => {
                  state.transactionCallCount += 1
                  return await work({
                    queryJson: async () => [],
                    run: async (statement) => {
                      state.txStatements.push(statement)
                    },
                  })
                },
              }
            },
          }
        })

        void mock.module(covidenceImportServiceModulePath, () => {
          return {
            buildCovidencePromptDefinition: (params) => {
              return {originalText: 'Prompt body', promptHeading: 'Prompt heading', type: params.answerSet === 'yes|no' ? "'yes' | 'no'" : "'yes' | 'no' | 'unsure'"}
            },
            buildCovidencePromptDefinitionsForEligibilityFields: ({answerSet, eligibilityFields, mode}) => {
              const question = mode === 'full_text'
                ? 'Based on the inclusion and exclusion criteria, should this study be included in the final review?'
                : 'Based on the inclusion and exclusion criteria, should this study be included for full text review?'
              const allowedAnswers = answerSet === 'yes|no' ? 'yes, no' : 'yes, no, unsure'
              const promptHeadingPrefix = mode === 'full_text' ? 'Covidence full-text screening | ' : 'Covidence title/abstract screening | '

              return eligibilityFields.map((eligibilityField) => {
                return {
                  originalText: [
                    question,
                    '',
                    'Allowed answers: ' + allowedAnswers,
                    '',
                    (eligibilityField.disposition === 'include' ? 'Include criterion' : 'Exclude criterion') + ' (' + eligibilityField.sectionLabel + '):',
                    eligibilityField.text,
                  ].join('\\n'),
                  promptHeading: promptHeadingPrefix + eligibilityField.sectionLabel + ' | ' + eligibilityField.disposition,
                  type: answerSet === 'yes|no' ? "'yes' | 'no'" : "'yes' | 'no' | 'unsure'",
                }
              })
            },
            buildCovidencePackageConfig: (params) => {
              return {kind: 'covidence_import', version: 1, ...params}
            },
            deleteCovidencePackageFiles: (datasourceId) => {
              state.deleteCalls.push(datasourceId)
            },
            getCovidencePackageCursor: (config) => {
              return JSON.stringify(config)
            },
            getOrCreateCovidenceProject: async (params) => {
              state.projectCalls.push({...params, tx: undefined})
              return {
                created: false,
                id: 'project-full-text',
                modelId: 'model-default',
                name: params.title,
                useAbstract: true,
                useFulltext: true,
                useFulltextNoImages: false,
                useTitle: true,
              }
            },
            getOrCreateCovidencePrompt: async (params) => {
              state.promptCalls.push({...params, tx: undefined})
              const promptIndex = state.promptCalls.length

              return {
                created: true,
                id: 'prompt-full-text-' + promptIndex,
                originalText: params.promptDefinition.originalText,
                promptHeading: params.promptDefinition.promptHeading,
                type: params.promptDefinition.type,
              }
            },
            importCovidencePackageFromConfig: async () => {
              return {importRouteIds: ['route-1'], stats: {importedCount: 3, itemCount: 4}}
            },
            seedCovidenceHumanJudgmentsFromConfig: async (params) => {
              state.seedCalls.push({importRoute: params.importRoute, mode: params.config.mode, projectId: params.projectId ?? null})
            },
            storeCovidencePackageFiles: async (params) => {
              state.storedFileCalls.push({
                datasourceId: params.datasourceId,
                files: params.files.map((entry) => {
                  return {fileName: entry.file.name, fileRole: entry.fileRole}
                }),
              })

              return [
                {assetPath: 'assets/covidence_imports/' + params.datasourceId + '/all-all.csv', fileRole: 'all', format: 'csv', sourceFileName: 'all.csv'},
                {assetPath: 'assets/covidence_imports/' + params.datasourceId + '/irrelevant-irrelevant.csv', fileRole: 'irrelevant', format: 'csv', sourceFileName: 'irrelevant.csv'},
                {assetPath: 'assets/covidence_imports/' + params.datasourceId + '/full_text-full_text.csv', fileRole: 'full_text', format: 'csv', sourceFileName: 'full_text.csv'},
                {assetPath: 'assets/covidence_imports/' + params.datasourceId + '/excluded-excluded.csv', fileRole: 'excluded', format: 'csv', sourceFileName: 'excluded.csv'},
                {assetPath: 'assets/covidence_imports/' + params.datasourceId + '/included-included.csv', fileRole: 'included', format: 'csv', sourceFileName: 'included.csv'},
              ]
            },
            syncCovidenceProjectPrompts: async (params) => {
              state.promptSyncCalls.push({...params, tx: undefined})
            },
            syncCovidenceProjectScopeFromConfig: async (params) => {
              state.scopeCalls.push({importRoute: params.importRoute, mode: params.config.mode, projectId: params.projectId ?? null})
            },
          }
        })

        void mock.module(dataSourceQueryServiceModulePath, () => {
          return {
            getDataSourceQueryService: () => {
              return {
                getDataSourceById: async (id) => {
                  state.getDataSourceCallCount += 1
                  return {
                    archived: false,
                    createdAt: new Date('2026-01-01T00:00:00.000Z'),
                    cursor: 'cursor-json',
                    dateFrom: null,
                    dateTo: null,
                    description: 'Created from Covidence package',
                    id,
                    importRoute: 'covidence:' + id,
                    itemsAfterLastImport: 0,
                    lastImportAt: null,
                    title: 'Full text datasource',
                    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
                  }
                },
              }
            },
          }
        })

        const {dataSourcesImportRoutesPostCovidenceCreate} = await import(
          './src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceCreate.ts?test=' + Date.now(),
        )

        const result = await dataSourcesImportRoutesPostCovidenceCreate({
          answerSet: 'yes|no',
          description: 'Created from Covidence package',
          eligibilityFields: [
            {disposition: 'include', sectionKey: 'population', sectionLabel: 'Population', text: 'Adults with confirmed disease'},
            {disposition: 'include', sectionKey: 'outcome', sectionLabel: 'Outcome', text: 'Pain reduction at follow-up'},
            {disposition: 'exclude', sectionKey: 'study_characteristics', sectionLabel: 'Study Characteristics', text: 'Case reports'},
          ],
          files: [
            {file: new File(['a,b\\n1,2\\n'], 'all.csv', {type: 'text/csv'}), fileRole: 'all'},
            {file: new File(['a,b\\n3,4\\n'], 'irrelevant.csv', {type: 'text/csv'}), fileRole: 'irrelevant'},
            {file: new File(['a,b\\n5,6\\n'], 'full_text.csv', {type: 'text/csv'}), fileRole: 'full_text'},
            {file: new File(['a,b\\n7,8\\n'], 'excluded.csv', {type: 'text/csv'}), fileRole: 'excluded'},
            {file: new File(['a,b\\n9,10\\n'], 'included.csv', {type: 'text/csv'}), fileRole: 'included'},
          ],
          mode: 'full_text',
          title: 'Full text datasource',
        })

        console.log(JSON.stringify({...state, result}))
      `,
    ],
    {cwd: process.cwd(), env: process.env},
  )

  if (runRoute.exitCode !== 0) {
    throw new Error(
      runRoute.stderr.toString() || runRoute.stdout.toString() || 'Covidence full-text create test failed',
    )
  }

  const parsed = JSON.parse(getLastJsonLine(runRoute.stdout.toString())) as CovidenceCreateSuccessResult

  expect(parsed.promptCalls).toEqual([
    {
      promptDefinition: {
        originalText: [
          'Based on the inclusion and exclusion criteria, should this study be included in the final review?',
          '',
          'Allowed answers: yes, no',
          '',
          'Include criterion (Population):',
          'Adults with confirmed disease',
        ].join('\n'),
        promptHeading: 'Covidence full-text screening | Population | include',
        type: "'yes' | 'no'",
      },
    },
    {
      promptDefinition: {
        originalText: [
          'Based on the inclusion and exclusion criteria, should this study be included in the final review?',
          '',
          'Allowed answers: yes, no',
          '',
          'Include criterion (Outcome):',
          'Pain reduction at follow-up',
        ].join('\n'),
        promptHeading: 'Covidence full-text screening | Outcome | include',
        type: "'yes' | 'no'",
      },
    },
    {
      promptDefinition: {
        originalText: [
          'Based on the inclusion and exclusion criteria, should this study be included in the final review?',
          '',
          'Allowed answers: yes, no',
          '',
          'Exclude criterion (Study Characteristics):',
          'Case reports',
        ].join('\n'),
        promptHeading: 'Covidence full-text screening | Study Characteristics | exclude',
        type: "'yes' | 'no'",
      },
    },
  ])
  expect(parsed.projectCalls).toHaveLength(1)
  expect(parsed.projectCalls?.[0]?.importRoute).toContain('covidence:')
  expect(parsed.projectCalls?.[0]?.mode).toBe('full_text')
  expect(parsed.projectCalls?.[0]?.promptId).toBeNull()
  expect(parsed.projectCalls?.[0]?.title).toBe('Full text datasource')
  expect(parsed.promptSyncCalls).toEqual([
    {projectId: 'project-full-text', promptIds: ['prompt-full-text-1', 'prompt-full-text-2', 'prompt-full-text-3']},
  ])
  expect(parsed.scopeCalls).toHaveLength(1)
  expect(parsed.scopeCalls?.[0]?.importRoute).toContain('covidence:')
  expect(parsed.scopeCalls?.[0]?.mode).toBe('full_text')
  expect(parsed.scopeCalls?.[0]?.projectId).toBe('project-full-text')
  expect(parsed.seedCalls).toHaveLength(1)
  expect(parsed.seedCalls?.[0]?.importRoute).toContain('covidence:')
  expect(parsed.seedCalls?.[0]?.mode).toBe('full_text')
  expect(parsed.seedCalls?.[0]?.projectId).toBe('project-full-text')
  expect(parsed.result.data.covidencePackageConfig).toMatchObject({
    kind: 'covidence_import',
    mode: 'full_text',
    version: 1,
  })
  expect(parsed.result.data.covidenceProject).toMatchObject({
    created: false,
    id: 'project-full-text',
    name: 'Full text datasource',
  })
  expect(parsed.result.data.covidencePrompts).toEqual([
    {
      created: true,
      id: 'prompt-full-text-1',
      originalText: [
        'Based on the inclusion and exclusion criteria, should this study be included in the final review?',
        '',
        'Allowed answers: yes, no',
        '',
        'Include criterion (Population):',
        'Adults with confirmed disease',
      ].join('\n'),
      promptHeading: 'Covidence full-text screening | Population | include',
      type: "'yes' | 'no'",
    },
    {
      created: true,
      id: 'prompt-full-text-2',
      originalText: [
        'Based on the inclusion and exclusion criteria, should this study be included in the final review?',
        '',
        'Allowed answers: yes, no',
        '',
        'Include criterion (Outcome):',
        'Pain reduction at follow-up',
      ].join('\n'),
      promptHeading: 'Covidence full-text screening | Outcome | include',
      type: "'yes' | 'no'",
    },
    {
      created: true,
      id: 'prompt-full-text-3',
      originalText: [
        'Based on the inclusion and exclusion criteria, should this study be included in the final review?',
        '',
        'Allowed answers: yes, no',
        '',
        'Exclude criterion (Study Characteristics):',
        'Case reports',
      ].join('\n'),
      promptHeading: 'Covidence full-text screening | Study Characteristics | exclude',
      type: "'yes' | 'no'",
    },
  ])
})

test('Covidence datasource create skips prompt creation when normalized eligibility fields are empty', () => {
  const runRoute = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const appDatabaseServiceModulePath = new URL('./src/server/services/appDatabaseService.ts', 'file://' + process.cwd() + '/').pathname
        const articleImportStoreServiceModulePath = new URL('./src/server/services/articleImportStoreService.ts', 'file://' + process.cwd() + '/').pathname
        const covidenceImportServiceModulePath = new URL('./src/server/services/covidenceImportService.ts', 'file://' + process.cwd() + '/').pathname
        const dataSourceQueryServiceModulePath = new URL('./src/server/services/dataSourceQueryService.ts', 'file://' + process.cwd() + '/').pathname
        const duckdbMartRefreshServiceModulePath = new URL('./src/server/services/getDuckdbMartRefreshService.ts', 'file://' + process.cwd() + '/').pathname

        const state = {
          deleteCalls: [],
          getDataSourceCallCount: 0,
          martQueueCalls: [],
          projectCalls: [],
          promptCalls: [],
          promptSyncCalls: [],
          queueCalls: [],
          seedCalls: [],
          scopeCalls: [],
          storedFileCalls: [],
          transactionCallCount: 0,
          txStatements: [],
        }

        void mock.module(articleImportStoreServiceModulePath, () => {
          return {
            queueImportedArticleRefreshes: async (importRouteIds) => {
              state.queueCalls.push(importRouteIds)
            },
          }
        })

        void mock.module(duckdbMartRefreshServiceModulePath, () => {
          return {
            getDuckdbMartRefreshService: () => {
              return {
                queueProjectRefreshesByImportRouteIds: async (importRouteIds, reason) => {
                  state.martQueueCalls.push({importRouteIds, reason})
                },
              }
            },
          }
        })

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                transaction: async (work) => {
                  state.transactionCallCount += 1
                  return await work({
                    run: async (statement) => {
                      state.txStatements.push(statement)
                    },
                  })
                },
              }
            },
          }
        })

        void mock.module(covidenceImportServiceModulePath, () => {
          return {
            buildCovidencePromptDefinition: (params) => {
              return {originalText: 'Prompt body', promptHeading: 'Prompt heading', type: params.answerSet === 'yes|no' ? "'yes' | 'no'" : "'yes' | 'no' | 'unsure'"}
            },
            buildCovidencePromptDefinitionsForEligibilityFields: () => {
              return []
            },
            buildCovidencePackageConfig: (params) => {
              return {kind: 'covidence_import', version: 1, ...params}
            },
            deleteCovidencePackageFiles: (datasourceId) => {
              state.deleteCalls.push(datasourceId)
            },
            getCovidencePackageCursor: (config) => {
              return JSON.stringify(config)
            },
            getOrCreateCovidenceProject: async (params) => {
              state.projectCalls.push({...params, tx: undefined})
              return {
                created: true,
                id: 'project-created',
                modelId: 'model-default',
                name: params.title,
                useAbstract: true,
                useFulltext: false,
                useFulltextNoImages: false,
                useTitle: true,
              }
            },
            getOrCreateCovidencePrompt: async (params) => {
              state.promptCalls.push({...params, tx: undefined})
              return {
                created: true,
                id: 'prompt-created',
                originalText: 'Prompt body',
                promptHeading: 'Covidence title/abstract screening',
                type: "'yes' | 'no' | 'unsure'",
              }
            },
            importCovidencePackageFromConfig: async () => {
              return {importRouteIds: ['route-1'], stats: {importedCount: 2, itemCount: 2}}
            },
            seedCovidenceHumanJudgmentsFromConfig: async (params) => {
              state.seedCalls.push({importRoute: params.importRoute, mode: params.config.mode, projectId: params.projectId ?? null})
            },
            storeCovidencePackageFiles: async (params) => {
              state.storedFileCalls.push({
                datasourceId: params.datasourceId,
                files: params.files.map((entry) => {
                  return {fileName: entry.file.name, fileRole: entry.fileRole}
                }),
              })

              return [
                {assetPath: 'assets/covidence_imports/' + params.datasourceId + '/all-all.csv', fileRole: 'all', format: 'csv', sourceFileName: 'all.csv'},
                {assetPath: 'assets/covidence_imports/' + params.datasourceId + '/irrelevant-irrelevant.csv', fileRole: 'irrelevant', format: 'csv', sourceFileName: 'irrelevant.csv'},
                {assetPath: 'assets/covidence_imports/' + params.datasourceId + '/full_text-full_text.ris', fileRole: 'full_text', format: 'ris', sourceFileName: 'full_text.ris'},
              ]
            },
            syncCovidenceProjectPrompts: async (params) => {
              state.promptSyncCalls.push({...params, tx: undefined})
            },
            syncCovidenceProjectScopeFromConfig: async (params) => {
              state.scopeCalls.push({importRoute: params.importRoute, mode: params.config.mode, projectId: params.projectId ?? null})
            },
          }
        })

        void mock.module(dataSourceQueryServiceModulePath, () => {
          return {
            getDataSourceQueryService: () => {
              return {
                getDataSourceById: async (id) => {
                  state.getDataSourceCallCount += 1
                  return {
                    archived: false,
                    createdAt: new Date('2026-01-01T00:00:00.000Z'),
                    cursor: 'cursor-json',
                    dateFrom: null,
                    dateTo: null,
                    description: 'Created from Covidence package',
                    id,
                    importRoute: 'covidence:' + id,
                    itemsAfterLastImport: 0,
                    lastImportAt: null,
                    title: 'Created datasource',
                    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
                  }
                },
              }
            },
          }
        })

        const {dataSourcesImportRoutesPostCovidenceCreate} = await import(
          './src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceCreate.ts?test=' + Date.now(),
        )

        const result = await dataSourcesImportRoutesPostCovidenceCreate({
          answerSet: 'yes|no|unsure',
          description: 'Created from Covidence package',
          eligibilityFields: [
            {disposition: 'include', sectionKey: 'population', sectionLabel: 'Population', text: '   '},
            {disposition: 'exclude', sectionKey: 'other', sectionLabel: 'Other', text: '\\n\\t'},
          ],
          files: [
            {file: new File(['a,b\\n1,2\\n'], 'all.csv', {type: 'text/csv'}), fileRole: 'all'},
            {file: new File(['a,b\\n3,4\\n'], 'irrelevant.csv', {type: 'text/csv'}), fileRole: 'irrelevant'},
            {file: new File(['TY  - JOUR\\nER  - \\n'], 'full_text.ris', {type: 'text/plain'}), fileRole: 'full_text'},
          ],
          mode: 'title_abstract',
          title: 'Created datasource',
        })

        console.log(JSON.stringify({...state, result}))
      `,
    ],
    {cwd: process.cwd(), env: process.env},
  )

  if (runRoute.exitCode !== 0) {
    throw new Error(
      runRoute.stderr.toString()
        || runRoute.stdout.toString()
        || 'Covidence create empty eligibility fields test failed',
    )
  }

  const parsed = JSON.parse(getLastJsonLine(runRoute.stdout.toString())) as CovidenceCreateSuccessResult

  expect(parsed.promptCalls).toEqual([])
  expect(parsed.projectCalls).toHaveLength(1)
  expect(parsed.projectCalls?.[0]?.promptId).toBeNull()
  expect(parsed.promptSyncCalls).toEqual([])
  expect(parsed.result.data.covidencePrompts).toEqual([])
  expect(parsed.queueCalls).toEqual([['route-1']])
})
