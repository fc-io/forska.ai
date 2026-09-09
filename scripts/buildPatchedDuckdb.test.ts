import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

import specification from '../vendor/duckdb/native-build.json'
import {hashDistributionInput} from './buildDuckdbDistribution/hashDistributionInput'
import {assertNativeTestReport} from './buildPatchedDuckdb/assertNativeTestReport'
import {getNativeBuildArguments} from './buildPatchedDuckdb/getNativeBuildArguments'
import {getNativeExtractionCommand} from './buildPatchedDuckdb/getNativeExtractionCommand'

test('Windows source extraction uses native bsdtar instead of interpreting drive letters as remote tar hosts', () => {
  const args = getNativeExtractionCommand('D:\\inputs\\source.tar.gz', 'D:\\source', 'win32', 'C:\\Windows')
  expect(args).toEqual([
    'C:\\Windows\\System32\\tar.exe',
    '-xzf',
    'D:\\inputs\\source.tar.gz',
    '--strip-components=1',
    '-C',
    'D:\\source',
  ])
  expect(getNativeExtractionCommand('/inputs/source.tar.gz', '/source', 'linux')[0]).toBe('tar')
  expect(() => {
    return getNativeExtractionCommand('source.tar.gz', 'source', 'win32')
  }).toThrow('native system root')
})

test('native build pins the source and patch independently from the active installed distribution', () => {
  expect(hashDistributionInput(readFileSync(specification.patches[0] ?? ''))).toBe(specification.patchSha256)
  expect(specification.distributionVersion).toBe('2.0.0-alpha40881.forska.2')
  expect(specification.parallelism).toBe(4)
  expect(specification.sourceArchive.sha256).toMatch(/^[a-f0-9]{64}$/)
})

test('native build retains C++ regressions, explicit patched identity and bundled offline extensions on six targets', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    for (const arch of ['x64', 'arm64']) {
      const args = getNativeBuildArguments({
        source: '/upstream',
        build: '/build',
        sourceId: specification.patchSha256,
        platform,
        arch,
      })
      expect(args).toContain('-DENABLE_UNITTEST_CPP_TESTS=ON')
      expect(args).toContain(`-DDUCKDB_EXTENSION_CONFIGS=${join('/upstream', specification.extensionConfig)}`)
      expect(args).toContain(`-DGIT_COMMIT_HASH=${specification.patchSha256}`)
      expect(args).toContain('-DDISABLE_UNITY=ON')
      expect(args).not.toContain('-DDISABLE_BUILTIN_EXTENSIONS=ON')
    }
  }
})

test('native report refuses partial selections even when all selected tests passed', () => {
  const workflow = readFileSync('.github/workflows/duckdb-native-build.yml', 'utf8')
  const filter = workflow.match(/--test-filter '([^']+)'/)?.[1]
  assert.ok(filter)
  const names = [
    ...filter.split(',').filter((name) => {
      return name.startsWith('test/sql/')
    }),
    'Truncated string maxima preserve the wider prefix in both merge orders',
    'Exact short string maxima and unequal prefixes retain ordinary ordering',
    'String maximum merges preserve equal, empty and unknown bound semantics',
    'String maximum unions are associative and preserve every represented suffix',
  ]
  const xml = `<testsuite>${names
    .map((name) => {
      return `<testcase name="${name}"/>`
    })
    .join('')}</testsuite>`
  expect(() => {
    return assertNativeTestReport(xml, filter)
  }).not.toThrow()
  expect(() => {
    return assertNativeTestReport(xml.replace(/<testcase[^>]+\/>/, ''), filter)
  }).toThrow('18 named cases')
  expect(() => {
    return assertNativeTestReport(xml.replace('</testsuite>', '<skipped/></testsuite>'), filter)
  }).toThrow('failed or skipped')
})
