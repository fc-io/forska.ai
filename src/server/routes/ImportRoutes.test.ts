import {readFileSync} from 'node:fs'

import {expect, test} from 'bun:test'

test('import route list keeps the unpaginated product contract explicit', () => {
  const routeText = readFileSync('src/server/routes/ImportRoutes.ts', 'utf8')

  expect(routeText).toContain('ORDER BY route ASC')
  expect(routeText).toContain('importRoutesWorkloadContext')
  expect(routeText).not.toContain('maxResultRows')
  expect(routeText).not.toContain('LIMIT')
})
