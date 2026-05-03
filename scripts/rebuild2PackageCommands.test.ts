import {join} from 'node:path'

import {expect, test} from 'bun:test'

const projectRoot = process.cwd()

test('package exposes rebuild2 cutover and removes obsolete mart refresh queue commands', async () => {
  const packageJson = (await Bun.file(join(projectRoot, 'package.json')).json()) as {scripts: Record<string, string>}
  const obsoleteCommandMatches = Object.entries(packageJson.scripts)
    .filter(([name, command]) => {
      return `${name} ${command}`.includes('refresh-queue') || command.includes('recoverArchivedProjectRefreshQueue')
    })
    .map(([name]) => {
      return name
    })

  expect(packageJson.scripts['db:duck:rebuild2-cutover']).toBe(
    'SERVER_ROLE=maintenance-worker SERVER_DUCKDB_OWNER_URL= bun scripts/rebuild2Cutover.ts',
  )
  expect(obsoleteCommandMatches).toEqual([])
})
