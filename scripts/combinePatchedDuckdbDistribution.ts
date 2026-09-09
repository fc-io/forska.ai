import assert from 'node:assert/strict'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {dirname, join, resolve} from 'node:path'
import {parseArgs} from 'node:util'

import {file, Glob} from 'bun'

import activeManifest from '../vendor/duckdb/manifest.json'
import specification from '../vendor/duckdb/native-build.json'
import {buildPlatformPackage} from './buildDuckdbDistribution/buildPlatformPackage'
import type {DistributionManifest, DistributionPlatform} from './buildDuckdbDistribution/distributionManifest'
import {copyVerifiedReleaseInput} from './combinePatchedDuckdbDistribution/copyVerifiedReleaseInput'
import type {NativeVerificationEvidence} from './combinePatchedDuckdbDistribution/nativeVerificationEvidence'
import {readNativeTestEvidence} from './combinePatchedDuckdbDistribution/readNativeTestEvidence'
import {retainNativeBuildInputs} from './combinePatchedDuckdbDistribution/retainNativeBuildInputs'
import {retainNativeVerificationEvidence} from './combinePatchedDuckdbDistribution/retainNativeVerificationEvidence'
import {type NativeBuild, readNativeBuild} from './stagePatchedDuckdbDistribution/readNativeBuild'

const {values} = parseArgs({options: {'input-dir': {type: 'string'}, 'output-dir': {type: 'string'}}, strict: true})
assert.ok(
  values['input-dir'] && values['output-dir'],
  'Downloaded native artifacts and fresh output directory are required',
)
const input = resolve(values['input-dir'])
const output = resolve(values['output-dir'])
await mkdir(output)
const paths = await Array.fromAsync(new Glob('**/candidate/manifest.json').scan(input))
assert.equal(paths.length, activeManifest.platforms.length, 'All six separately verified native artifacts are required')
const manifests: DistributionManifest[] = []
const platforms: DistributionPlatform[] = []
const nativeBuilds: NativeBuild[] = []
const evidence: NativeVerificationEvidence[] = []
for (const manifestPath of paths) {
  const candidate = dirname(join(input, manifestPath))
  const manifest = (await file(join(candidate, 'manifest.json')).json()) as DistributionManifest
  assert.equal(manifest.distributionVersion, specification.distributionVersion)
  assert.equal(manifest.platforms.length, 1)
  const platform = manifest.platforms[0]
  assert.ok(platform)
  const build = await readNativeBuild(join(candidate, '../native-output'))
  nativeBuilds.push(build)
  assert.deepEqual(platform.nativeBuild, build)
  const verified = (await file(join(candidate, 'verification.json')).json()) as Record<string, unknown>
  assert.equal(verified.passed, true)
  assert.equal(verified.distributionVersion, manifest.distributionVersion)
  assert.equal(verified.platform, `${platform.platform}-${platform.arch}`)
  assert.deepEqual(verified.engine, manifest.engine)
  evidence.push({
    build,
    platform,
    engine: manifest.engine,
    ...(await readNativeTestEvidence(join(candidate, '../native-output'))),
    verification: await readFile(join(candidate, 'verification.json')),
  })
  const bridgeArchive = await copyVerifiedReleaseInput(
    join(candidate, platform.bridge.filename),
    platform.bridge.filename,
    platform.bridge.sha256,
    output,
  )
  const nativeArchive = await copyVerifiedReleaseInput(
    join(candidate, platform.artifact.filename),
    platform.artifact.filename,
    platform.artifact.sha256,
    output,
  )
  const nativeLicense = await copyVerifiedReleaseInput(
    join(candidate, 'DUCKDB_LICENSE'),
    'DUCKDB_LICENSE',
    manifest.nativeLicense.sha256,
    output,
  )
  const rebuilt = await buildPlatformPackage({
    platform,
    distribution: manifest,
    bridgeArchive,
    nativeArchive,
    nativeLicense,
  })
  assert.equal(rebuilt.sha256, platform.sha256, 'Candidate package is not reproducible from retained inputs')
  assert.equal(rebuilt.integrity, platform.integrity)
  await copyVerifiedReleaseInput(join(candidate, platform.filename), platform.filename, platform.sha256, output)
  manifests.push(manifest)
  platforms.push(platform)
}
const first = manifests[0]
assert.ok(first)
assert.deepEqual(
  platforms
    .map(({platform, arch}) => {
      return `${platform}-${arch}`
    })
    .sort(),
  activeManifest.platforms
    .map(({platform, arch}) => {
      return `${platform}-${arch}`
    })
    .sort(),
)
for (const manifest of manifests) {
  assert.deepEqual(manifest.engine, first.engine, 'Native targets were built from different engine inputs')
  assert.deepEqual(manifest.release, first.release)
}
const sourceFiles = await Array.fromAsync(new Glob(`**/${specification.sourceArchive.filename}`).scan(input))
assert.equal(sourceFiles.length, 1, 'Retain exactly one pinned upstream source archive for the release mirror')
const sourceFile = sourceFiles[0]
assert.ok(sourceFile)
await copyVerifiedReleaseInput(
  join(input, sourceFile),
  specification.sourceArchive.filename,
  specification.sourceArchive.sha256,
  output,
)
const distribution = {
  ...first,
  platforms: platforms.sort((a, b) => {
    return a.packageName.localeCompare(b.packageName, 'en')
  }),
}
const buildInputs = await retainNativeBuildInputs(nativeBuilds, resolve(import.meta.dir, '..'), output)
const verificationEvidence = await retainNativeVerificationEvidence(evidence, output)
await writeFile(join(output, 'manifest.json'), `${JSON.stringify(distribution, null, 2)}\n`, {flag: 'wx'})
const packageHashes = platforms
  .map((platform) => {
    return `${platform.sha256}  ${platform.filename}`
  })
  .sort()
  .join('\n')
await writeFile(
  join(output, 'SHA256SUMS'),
  `${packageHashes}\n${buildInputs.sha256}  ${buildInputs.filename}\n${verificationEvidence.sha256}  ${verificationEvidence.filename}\n`,
  {flag: 'wx'},
)
console.log(
  JSON.stringify({distributionVersion: distribution.distributionVersion, platforms: platforms.length, output}),
)
