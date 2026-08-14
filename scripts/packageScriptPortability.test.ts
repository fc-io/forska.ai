import {join} from 'node:path'

import {expect, test} from 'bun:test'

import {parseRunPlaywrightArgs} from './runPlaywright.ts'
import {parseRunWithEnvArgs} from './runWithEnv.ts'

const projectRoot = process.cwd()

const readPackageScripts = async () => {
  const packageJson = (await globalThis.Bun.file(join(projectRoot, 'package.json')).json()) as {
    scripts: Record<string, string>
  }

  return packageJson.scripts
}

const expectNoInlineEnvAssignment = (scriptName: string, command: string) => {
  expect(command, `${scriptName} should not use POSIX inline env assignment`).not.toMatch(
    /(?:^|&&\s+|\|\|\s+|;\s+)[A-Z_][A-Z0-9_]*=/u,
  )
}

test('reviewed package scripts avoid POSIX-only shell syntax', async () => {
  const scripts = await readPackageScripts()

  expect(scripts.test).toBe('bun scripts/runPackageTests.ts')
  expect(scripts.test).not.toContain('sh -c')
  expect(scripts.test).not.toContain('$?')
  expect(scripts.test).not.toContain('[ ')

  for (const scriptName of [
    'test:network-smoke:current-db:readonly',
    'test:network-smoke:synthetic',
    'test:dev-server:current-db',
    'dev:server:bun-watch',
    'dev:server:single',
    'dev:server:api-only',
    'dev:server:duckdb-owner',
  ]) {
    expectNoInlineEnvAssignment(scriptName, scripts[scriptName] ?? '')
  }

  expect(scripts['test:network-smoke:current-db:readonly']).toContain('bun scripts/runPlaywright.ts')
  expect(scripts['test:network-smoke:current-db:readonly']).not.toContain('bunx playwright')
  expect(scripts['test:network-smoke:synthetic']).toContain('bun scripts/runPlaywright.ts')
  expect(scripts['test:network-smoke:synthetic']).not.toContain('bunx playwright')
})

test('runWithEnv parses package-style env entries without a shell', () => {
  expect(
    parseRunWithEnvArgs([
      'SERVER_ROLE=maintenance-worker',
      'SERVER_DUCKDB_OWNER_URL=',
      'BUN_CONFIG_MAX_HTTP_REQUESTS=2048',
      '--',
      'bun',
      'run',
      '--watch',
      'src/server/index.ts',
    ]),
  ).toMatchObject({
    command: [expect.stringMatching(/[\\/]bun(?:\.exe)?$/u), 'run', '--watch', 'src/server/index.ts'],
    env: {BUN_CONFIG_MAX_HTTP_REQUESTS: '2048', SERVER_DUCKDB_OWNER_URL: '', SERVER_ROLE: 'maintenance-worker'},
  })
})

test('runPlaywright consumes package env flags before forwarding playwright args', () => {
  expect(
    parseRunPlaywrightArgs([
      '--env',
      'FORSKA_NETWORK_SMOKE_AUDIT=true',
      '--env',
      'FORSKA_DISABLE_SERVER_MUTATIONS=true',
      'tests/e2e/networkSmoke.spec.ts',
    ]),
  ).toEqual({
    env: {FORSKA_DISABLE_SERVER_MUTATIONS: 'true', FORSKA_NETWORK_SMOKE_AUDIT: 'true'},
    passthroughArgs: ['tests/e2e/networkSmoke.spec.ts'],
  })
})
