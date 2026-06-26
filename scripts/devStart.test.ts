import {realpathSync} from 'node:fs'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

import {devStartCommands} from './devStart.ts'

const projectRoot = process.cwd()
const bunExecutablePath = realpathSync(process.execPath)

test('dev:start uses the cross-platform launcher', async () => {
  const packageJson = (await globalThis.Bun.file(join(projectRoot, 'package.json')).json()) as {
    scripts: Record<string, string>
  }

  expect(packageJson.scripts['dev:start']).toBe('bun scripts/devStart.ts')
  expect(packageJson.scripts['dev:start']).not.toContain('&')
})

test('dev:start launches app before api', () => {
  expect(
    devStartCommands.map(({name}) => {
      return name
    }),
  ).toEqual(['app', 'api'])
  expect(devStartCommands[0].command).toEqual([
    bunExecutablePath,
    'scripts/runWithRuntimeProfile.ts',
    '--profile',
    'primary',
    '--mode',
    'app',
  ])
  expect(devStartCommands[1].command).toEqual([
    bunExecutablePath,
    'scripts/runWithRuntimeProfile.ts',
    '--profile',
    'primary',
    '--mode',
    'stacked-server',
  ])
})
