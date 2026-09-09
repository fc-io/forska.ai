import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'

import activeManifest from '../../vendor/duckdb/manifest.json'
import specification from '../../vendor/duckdb/native-build.json'
import type {NativeVerificationEvidence} from './nativeVerificationEvidence'

export const nativeVerificationFixture = (index = 0): NativeVerificationEvidence & {nativeXml: Uint8Array} => {
  const base = activeManifest.platforms[index]
  assert.ok(base)
  const platform = {...base, native: {...base.native, sha256: 'e'.repeat(64)}}
  const engine = {...activeManifest.engine, sourceId: specification.patchSha256.slice(0, 10)}
  const filter = readFileSync('.github/workflows/duckdb-native-build.yml', 'utf8').match(/--test-filter '([^']+)'/)?.[1]
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
  const nativeXml = Buffer.from(
    `<testsuite>${names
      .map((name) => {
        return `<testcase name="${name}"/>`
      })
      .join('')}</testsuite>`,
  )
  return {
    platform,
    engine,
    nativeXml,
    build: {
      schemaVersion: 1,
      distributionVersion: specification.distributionVersion,
      engineVersion: engine.version,
      sourceRevision: specification.sourceRevision,
      sourceId: engine.sourceId,
      sourceArchive: specification.sourceArchive,
      patches: [{filename: 'source.patch', sha256: specification.patchSha256}],
      extensionConfig: specification.extensionConfig,
      recipe: {inputs: [], sha256: 'a'.repeat(64)},
      platform: platform.platform,
      arch: platform.arch,
      library: {filename: platform.native.filename, sha256: platform.native.sha256},
      workflow: {repository: 'fc-io/forska.ai', runId: 'test-run', runAttempt: '1', commit: 'test-commit'},
    },
    verification: Buffer.from(
      JSON.stringify({
        distributionVersion: specification.distributionVersion,
        platform: `${platform.platform}-${platform.arch}`,
        engine,
        phases: [
          'seed',
          'reopen',
          'statistics-replay',
          'statistics-checkpoint',
          'statistics-reopen',
          'updated-statistics-live',
          'updated-statistics-live-reopen',
          'updated-statistics-replay',
          'updated-statistics-checkpoint',
          'updated-statistics-reopen',
        ],
        checkpointMemoryMiB: 32,
        passed: true,
      }),
    ),
  }
}
