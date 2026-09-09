import assert from 'node:assert/strict'
import {cp, mkdir, readFile} from 'node:fs/promises'
import {join, resolve} from 'node:path'
import {parseArgs} from 'node:util'

import type {DistributionManifest} from './buildDuckdbDistribution/distributionManifest'
import {hashDistributionInput} from './buildDuckdbDistribution/hashDistributionInput'
import {assertNativeTestReport} from './buildPatchedDuckdb/assertNativeTestReport'
import {runNativeCommand} from './buildPatchedDuckdb/runNativeCommand'
import {readNativeBuild} from './stagePatchedDuckdbDistribution/readNativeBuild'

const {values} = parseArgs({
  options: {
    'input-dir': {type: 'string'},
    'work-dir': {type: 'string'},
    'run-id': {type: 'string'},
    target: {type: 'string'},
    repository: {type: 'string'},
  },
  strict: true,
})
assert.ok(values['input-dir'] && values['work-dir'] && values['run-id'] && values.target && values.repository)
assert.match(values['run-id'], /^[1-9][0-9]*$/)
assert.equal(values.target, `${process.platform}-${process.arch}`, 'Retained candidate requires its native runner')
const input = resolve(values['input-dir'])
const work = resolve(values['work-dir'])
const originalNative = join(input, 'native-output')
const originalCandidate = join(input, 'candidate')
const build = await readNativeBuild(originalNative)
assert.equal(`${build.platform}-${build.arch}`, values.target)
assert.equal(build.workflow.repository, values.repository)
assert.equal(build.workflow.runId, values['run-id'])
assert.match(build.workflow.commit ?? '', /^[a-f0-9]{40}$/)
const xml = await readFile(join(originalNative, 'native-tests.xml'), 'utf8')
const sqlCases = [...xml.matchAll(/<testcase\b[^>]*\bname="([^"]+)"/g)]
  .map((match) => {
    return match[1] ?? ''
  })
  .filter((name) => {
    return name.startsWith('test/sql/')
  })
assertNativeTestReport(xml, sqlCases.join(','))
const original = JSON.parse(await readFile(join(originalCandidate, 'manifest.json'), 'utf8')) as DistributionManifest
assert.equal(original.platforms.length, 1)
const platform = original.platforms[0]
assert.ok(platform)
assert.match(platform.filename, /^[a-zA-Z0-9._-]+\.tgz$/)
assert.deepEqual(platform.nativeBuild, build)
assert.equal(original.distributionVersion, build.distributionVersion)
assert.equal(original.engine.version, build.engineVersion)
assert.equal(original.engine.sourceId, build.sourceId)
assert.equal(platform.native.sha256, build.library.sha256)
const originalPackage = await readFile(join(originalCandidate, platform.filename))
assert.equal(hashDistributionInput(originalPackage), platform.sha256)
await mkdir(work)
const native = join(work, 'native-output')
const candidate = join(work, 'candidate')
await cp(originalNative, native, {recursive: true, force: false, errorOnExist: true})
const log = join(work, 'artifact-reverification.log')
await runNativeCommand(
  [
    process.execPath,
    join(import.meta.dir, 'stagePatchedDuckdbDistribution.ts'),
    '--native-dir',
    native,
    '--output-dir',
    candidate,
  ],
  resolve(import.meta.dir, '..'),
  log,
)
assert.deepEqual(
  JSON.parse(await readFile(join(candidate, 'manifest.json'), 'utf8')),
  original,
  'Restaging changed original candidate provenance',
)
assert.deepEqual(
  await readFile(join(candidate, platform.filename)),
  originalPackage,
  'Restaging changed original package bytes',
)
await runNativeCommand(
  [
    process.execPath,
    join(import.meta.dir, 'validatePatchedDuckdbCandidate.ts'),
    '--candidate-dir',
    candidate,
    '--work-dir',
    join(work, 'candidate-verification'),
  ],
  resolve(import.meta.dir, '..'),
  log,
)
console.log(
  JSON.stringify({
    passed: true,
    target: values.target,
    sourceRun: values['run-id'],
    sourceId: build.sourceId,
    packageSha256: platform.sha256,
  }),
)
