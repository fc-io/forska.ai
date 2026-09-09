import assert from 'node:assert/strict'
import {resolve} from 'node:path'
import {parseArgs} from 'node:util'

import {file} from 'bun'

import type {DistributionManifest} from './buildDuckdbDistribution/distributionManifest'
import {verifyDuckdbStringStatisticsRuntime} from './verifyDuckdbDistribution/verifyDuckdbStringStatistics'
import {verifyDuckdbUpdatedStringStatisticsRuntime} from './verifyDuckdbDistribution/verifyDuckdbUpdatedStringStatistics'
import {verifyDuckdbWalRuntime} from './verifyDuckdbDistribution/verifyDuckdbWal'
import {getPatchedRuntime} from './verifyPatchedDuckdb/getPatchedRuntime'

const {values} = parseArgs({
  options: {
    'package-root': {type: 'string'},
    manifest: {type: 'string'},
    directory: {type: 'string'},
    phase: {type: 'string'},
  },
  strict: true,
})
assert.ok(
  values['package-root'] && values.manifest && values.directory && values.phase,
  'Candidate verification inputs are required',
)
const distribution = (await file(values.manifest).json()) as DistributionManifest
const runtime = getPatchedRuntime(resolve(values['package-root']), distribution)
assert.equal(runtime.version(), distribution.engine.version)
const instance = await runtime.DuckDBInstance.create(':memory:', {legacy_disable_null_type: 'true'})
const connection = await instance.connect()
const version = (await connection.runAndReadAll('PRAGMA version')).getRowObjectsJS()[0]
assert.equal(version?.source_id, distribution.engine.sourceId)
connection.closeSync()
instance.closeSync()
if (values.phase === 'seed' || values.phase === 'reopen') {
  await verifyDuckdbWalRuntime(runtime, values.phase, values.directory, distribution.engine)
} else if (values.phase.startsWith('updated-statistics-')) {
  await verifyDuckdbUpdatedStringStatisticsRuntime(runtime, values.phase, values.directory, distribution.engine)
} else {
  await verifyDuckdbStringStatisticsRuntime(runtime, values.phase, values.directory, distribution.engine)
}
