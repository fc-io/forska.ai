import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

import {afterAll, expect, test} from 'bun:test'

import {
  getRuntimeDependencyPreflightMessage,
  getRuntimeDependencyProblems,
  runtimeDependencyLazyModuleSpecifiers,
} from './runtimeDependencyPreflight.ts'

const rootDirectory = mkdtempSync(join(tmpdir(), 'forska-dependency-preflight-'))

const writeJson = (relativePath: string, value: unknown) => {
  const filePath = join(rootDirectory, relativePath)

  mkdirSync(dirname(filePath), {recursive: true})
  writeFileSync(filePath, JSON.stringify(value))
}

afterAll(() => {
  rmSync(rootDirectory, {force: true, recursive: true})
})

test('the repository checkout has every declared dependency and the lazy full-text modules installed', () => {
  expect(getRuntimeDependencyProblems()).toEqual([])
  expect(runtimeDependencyLazyModuleSpecifiers).toEqual(['fflate', 'pngjs', 'gpt-tokenizer/encoding/o200k_base'])
})

test('missing, outdated and unresolvable packages are reported, non-semver specs only need to be present', () => {
  writeJson('package.json', {
    dependencies: {
      '@scope/present': '^1.2.0',
      'git-dep': 'github:owner/repo#abc',
      'lazy-pkg': '^2.0.0',
      missing: '^7.0.0',
      outdated: '4.0.3',
    },
    devDependencies: {'dev-only': '^1.0.0'},
  })
  writeJson('node_modules/@scope/present/package.json', {name: '@scope/present', version: '1.4.0'})
  writeJson('node_modules/git-dep/package.json', {name: 'git-dep', version: '0.0.0-dev'})
  writeJson('node_modules/lazy-pkg/package.json', {exports: {'.': './index.js'}, name: 'lazy-pkg', version: '2.1.0'})
  writeFileSync(join(rootDirectory, 'node_modules/lazy-pkg/index.js'), 'export const value = 1\n')
  writeJson('node_modules/outdated/package.json', {name: 'outdated', version: '4.0.2'})

  const problems = getRuntimeDependencyProblems({
    lazyModuleSpecifiers: ['lazy-pkg', 'lazy-pkg/encoding/missing', 'missing/sub'],
    rootDirectory,
  })

  expect(problems).toEqual([
    {installedVersion: null, name: 'missing', requiredVersion: '^7.0.0'},
    {installedVersion: '4.0.2', name: 'outdated', requiredVersion: '4.0.3'},
    {installedVersion: null, name: 'lazy-pkg/encoding/missing', requiredVersion: null},
  ])
  expect(getRuntimeDependencyPreflightMessage(problems)).toBe(
    'Installed packages do not match package.json: missing (missing, needs ^7.0.0), outdated (4.0.2 installed, needs 4.0.3), lazy-pkg/encoding/missing (missing). Run `bun install` in the repository root (needed after every git pull that changes package.json or bun.lock), then start the server again.',
  )
})
