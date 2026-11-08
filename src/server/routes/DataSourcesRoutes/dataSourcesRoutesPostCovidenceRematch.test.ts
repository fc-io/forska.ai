import {expect, test} from 'bun:test'

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

test('POST /api/datasources/:id/covidence-rematch passes dry runs and applies to the rematch service', () => {
  const runRoute = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')
        const rematchServicePath = new URL('./src/server/services/covidenceRematchService.ts', 'file://' + process.cwd() + '/').href
        const {HttpError} = await import('./src/server/utils/httpError.ts')
        const calls = []

        void mock.module(rematchServicePath, () => {
          return {
            runCovidenceRematch: async (params) => {
              calls.push(params)

              if (params.dataSourceId === 'ds-blocked') {
                throw new HttpError(409, 'Covidence rematch is blocked by rows in [{"rowCount":2,"tableName":"judgment"}]')
              }

              return {deletedArticles: params.dryRun ? 0 : 3, dryRun: params.dryRun, remappedArticleCount: 3}
            },
          }
        })

        const {dataSourcesRoutes} = await import('./src/server/routes/DataSourcesRoutes.ts?test=' + Date.now())
        const post = async (id, body) => {
          const response = await dataSourcesRoutes.handle(
            new Request('http://localhost/api/datasources/' + id + '/covidence-rematch', {
              body: JSON.stringify(body),
              headers: {'content-type': 'application/json'},
              method: 'POST',
            }),
          )
          const text = await response.text()

          return {body: text.startsWith('{') ? JSON.parse(text) : text, status: response.status}
        }

        const dryRun = await post('ds-1', {baseImportRoute: '  covidence:base  ', dryRun: true})
        const applied = await post('ds-1', {baseImportRoute: 'covidence:base', dryRun: false})
        const blocked = await post('ds-blocked', {baseImportRoute: 'covidence:base', dryRun: false})
        const invalid = await post('ds-1', {baseImportRoute: 'covidence:base'})

        console.log(JSON.stringify({applied, blocked, calls, dryRun, invalidStatus: invalid.status}))
      `,
    ],
    {cwd: process.cwd(), env: process.env},
  )

  if (runRoute.exitCode !== 0) {
    throw new Error(runRoute.stderr.toString() || runRoute.stdout.toString() || 'Covidence rematch route test failed')
  }

  const parsed = JSON.parse(getLastJsonLine(runRoute.stdout.toString())) as {
    applied: {body: unknown; status: number}
    blocked: {body: unknown; status: number}
    calls: unknown[]
    dryRun: {body: unknown; status: number}
    invalidStatus: number
  }

  expect(parsed.dryRun).toEqual({
    body: {data: {deletedArticles: 0, dryRun: true, remappedArticleCount: 3}},
    status: 200,
  })
  expect(parsed.applied).toEqual({
    body: {data: {deletedArticles: 3, dryRun: false, remappedArticleCount: 3}},
    status: 200,
  })
  expect(parsed.blocked.status).toBe(409)
  expect(JSON.stringify(parsed.blocked.body)).toContain('blocked by rows')
  expect(parsed.invalidStatus).toBe(422)
  expect(parsed.calls).toEqual([
    {baseImportRoute: 'covidence:base', dataSourceId: 'ds-1', dryRun: true},
    {baseImportRoute: 'covidence:base', dataSourceId: 'ds-1', dryRun: false},
    {baseImportRoute: 'covidence:base', dataSourceId: 'ds-blocked', dryRun: false},
  ])
})
