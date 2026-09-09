import assert from 'node:assert/strict'
import {copyFile, mkdir, stat, writeFile} from 'node:fs/promises'
import {join, resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {parseArgs} from 'node:util'

import {file} from 'bun'

import type {DistributionManifest} from './buildDuckdbDistribution/distributionManifest'
import {runNativeCommand} from './buildPatchedDuckdb/runNativeCommand'

const {values} = parseArgs({options: {'candidate-dir': {type: 'string'}, 'work-dir': {type: 'string'}}, strict: true})
assert.ok(
  values['candidate-dir'] && values['work-dir'],
  'Candidate package and disposable working directories are required',
)
const candidate = resolve(values['candidate-dir'])
const work = resolve(values['work-dir'])
const root = join(work, 'application')
const evidence = join(work, 'evidence')
await mkdir(root, {recursive: true})
await mkdir(evidence, {recursive: true})
const distribution = (await file(join(candidate, 'manifest.json')).json()) as DistributionManifest
assert.equal(distribution.platforms.length, 1, 'A candidate build must verify exactly its native platform')
const platform = distribution.platforms[0]
assert.ok(platform)
assert.equal(platform.platform, process.platform)
assert.equal(platform.arch, process.arch)
await writeFile(
  join(root, 'package.json'),
  `${JSON.stringify(
    {
      name: 'forska-patched-duckdb-verification',
      private: true,
      dependencies: {'@duckdb/node-api': distribution.nodeBindingsVersion},
      overrides: {[platform.packageName]: pathToFileURL(join(candidate, platform.filename)).href},
    },
    null,
    2,
  )}\n`,
  {flag: 'wx'},
)
const log = join(evidence, 'verification.log')
await runNativeCommand([process.execPath, 'install', '--ignore-scripts'], root, log)
const phases = [
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
]
for (const phase of phases) {
  await runNativeCommand(
    [
      process.execPath,
      join(import.meta.dir, 'verifyPatchedDuckdb.ts'),
      '--package-root',
      root,
      '--manifest',
      join(candidate, 'manifest.json'),
      '--directory',
      evidence,
      '--phase',
      phase,
    ],
    root,
    log,
  )
  if (phase === 'seed') {
    assert.ok(
      (await stat(join(evidence, 'new-wal.duckdb.wal'))).size > 0,
      'WAL proof must replay real committed WAL bytes',
    )
  }
}
await copyFile(join(import.meta.dir, 'duckdbCheckpointMemoryRegression.ts'), join(root, 'checkpoint.ts'))
await runNativeCommand([process.execPath, join(root, 'checkpoint.ts')], root, log)
await writeFile(
  join(candidate, 'verification.json'),
  `${JSON.stringify(
    {
      distributionVersion: distribution.distributionVersion,
      platform: `${process.platform}-${process.arch}`,
      engine: distribution.engine,
      phases,
      checkpointMemoryMiB: 32,
      passed: true,
    },
    null,
    2,
  )}\n`,
  {flag: 'wx'},
)
