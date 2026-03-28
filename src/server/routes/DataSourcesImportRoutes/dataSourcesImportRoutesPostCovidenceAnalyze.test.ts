import {expect, test} from 'bun:test'

type CovidenceAnalyzeRouteResult = {error: string | null; response: unknown; status: number}

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

test('Covidence analyze route returns service analysis data and 400 errors', () => {
  const runRoute = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const covidenceImportServiceModulePath = new URL('./src/server/services/covidenceImportService.ts', 'file://' + process.cwd() + '/').pathname

        const state = {
          error: null,
          response: null,
          status: 200,
        }

        void mock.module(covidenceImportServiceModulePath, () => {
          return {
            analyzeCovidencePackageFiles: async (body) => {
              return body.mode === 'title_abstract'
                ? {
                    data: {
                      counts: {
                        conflictingStageMembershipCount: 0,
                        fileCount: 3,
                        filesByRole: {all: 1, excluded: 0, full_text: 1, included: 0, irrelevant: 1},
                        mergedRowCount: 1,
                        missingMatchCount: 0,
                        rowCount: 3,
                        rowsByRole: {all: 1, excluded: 0, full_text: 1, included: 0, irrelevant: 1},
                      },
                      detectedFiles: [],
                      mode: body.mode,
                      sampleMergedRows: [],
                      warnings: {conflictingStageMemberships: [], missingMatches: []},
                    },
                    ok: true,
                  }
                : {
                    error: {code: 'invalid_upload', message: 'bad package'},
                    ok: false,
                  }
            },
          }
        })

        const {dataSourcesImportRoutesPostCovidenceAnalyze} = await import(
          './src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceAnalyze.ts?test=' + Date.now(),
        )

        state.response = await dataSourcesImportRoutesPostCovidenceAnalyze({
          body: {
            files: [
              {file: new File(['Title\\nStudy A\\n'], 'all.csv', {type: 'text/csv'}), fileRole: 'all'},
              {file: new File(['Title\\nStudy A\\n'], 'irrelevant.csv', {type: 'text/csv'}), fileRole: 'irrelevant'},
              {file: new File(['Title\\nStudy A\\n'], 'full_text.csv', {type: 'text/csv'}), fileRole: 'full_text'},
            ],
            mode: 'title_abstract',
          },
          set: state,
        })

        state.error = (
          await dataSourcesImportRoutesPostCovidenceAnalyze({
            body: {files: [], mode: 'full_text'},
            set: state,
          })
        ).error

        console.log(JSON.stringify(state))
      `,
    ],
    {cwd: process.cwd(), env: process.env},
  )

  if (runRoute.exitCode !== 0) {
    throw new Error(runRoute.stderr.toString() || runRoute.stdout.toString() || 'Covidence analyze route test failed')
  }

  const parsed = JSON.parse(getLastJsonLine(runRoute.stdout.toString())) as CovidenceAnalyzeRouteResult

  expect(parsed.response).toEqual({
    data: {
      counts: {
        conflictingStageMembershipCount: 0,
        fileCount: 3,
        filesByRole: {all: 1, excluded: 0, full_text: 1, included: 0, irrelevant: 1},
        mergedRowCount: 1,
        missingMatchCount: 0,
        rowCount: 3,
        rowsByRole: {all: 1, excluded: 0, full_text: 1, included: 0, irrelevant: 1},
      },
      detectedFiles: [],
      mode: 'title_abstract',
      sampleMergedRows: [],
      warnings: {conflictingStageMemberships: [], missingMatches: []},
    },
  })
  expect(parsed.error).toBe('bad package')
  expect(parsed.status).toBe(400)
})
