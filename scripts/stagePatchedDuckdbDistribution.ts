import assert from 'node:assert/strict'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {join, resolve} from 'node:path'
import {parseArgs} from 'node:util'

import manifest from '../vendor/duckdb/manifest.json'
import specification from '../vendor/duckdb/native-build.json'
import {buildPlatformPackage} from './buildDuckdbDistribution/buildPlatformPackage'
import {createDeterministicTarball} from './buildDuckdbDistribution/createDeterministicTarball'
import type {DistributionManifest} from './buildDuckdbDistribution/distributionManifest'
import {hashDistributionInput} from './buildDuckdbDistribution/hashDistributionInput'
import {readNativeBuild} from './stagePatchedDuckdbDistribution/readNativeBuild'

const {values} = parseArgs({options: {'native-dir': {type: 'string'}, 'output-dir': {type: 'string'}}, strict: true})
assert.ok(values['native-dir'] && values['output-dir'], 'Native input and candidate output directories are required')
const input = resolve(values['native-dir'])
const output = resolve(values['output-dir'])
await mkdir(output, {recursive: true})
const build = await readNativeBuild(input)
const base = manifest.platforms.find(({platform, arch}) => {
  return platform === build.platform && arch === build.arch
})
assert.ok(base, 'Native build target is not supported by the official Node bridge')
assert.equal(base.native.filename, build.library.filename)
const archive = createDeterministicTarball({
  [build.library.filename]: await readFile(join(input, build.library.filename)),
})
const artifactFilename = `duckdb-patched-libs-${build.platform}-${build.arch}-${specification.distributionVersion}.tar.gz`
const baseUrl = `https://github.com/fc-io/forska.ai/releases/download/${specification.releaseTag}/`
const platform = {
  ...base,
  filename: `duckdb-node-bindings-${build.platform}-${build.arch}-${specification.distributionVersion}.tgz`,
  artifact: {filename: artifactFilename, sha256: hashDistributionInput(archive), url: `${baseUrl}${artifactFilename}`},
  native: {filename: build.library.filename, sha256: build.library.sha256},
  nativeBuild: build,
}
const distribution: DistributionManifest = {
  ...manifest,
  distributionVersion: specification.distributionVersion,
  engine: {
    version: build.engineVersion,
    sourceId: build.sourceId,
    sourceRevision: build.sourceRevision,
    repository: manifest.engine.repository,
    nativeBuild: {sourceArchive: build.sourceArchive, patches: build.patches},
  },
  release: {tag: specification.releaseTag, inputAssetMirrors: true, baseUrl},
  platforms: [platform],
}
const bridgeResponse = await fetch(base.bridge.url, {signal: AbortSignal.timeout(120000)})
assert.ok(bridgeResponse.ok, `Cannot download pinned bridge: HTTP ${bridgeResponse.status}`)
const bridgeArchive = new Uint8Array(await bridgeResponse.arrayBuffer())
const nativeLicense = new Uint8Array(await readFile(join(input, 'DUCKDB_LICENSE')))
const packaged = await buildPlatformPackage({
  platform,
  distribution,
  bridgeArchive,
  nativeArchive: archive,
  nativeLicense,
})
platform.sha256 = packaged.sha256
platform.integrity = packaged.integrity
for (const [filename, bytes] of Object.entries({
  [platform.filename]: packaged.bytes,
  [artifactFilename]: archive,
  [base.bridge.filename]: bridgeArchive,
  DUCKDB_LICENSE: nativeLicense,
  'manifest.json': new TextEncoder().encode(`${JSON.stringify(distribution, null, 2)}\n`),
})) {
  await writeFile(join(output, filename), bytes, {flag: 'wx'})
}
console.log(
  JSON.stringify({
    package: platform.filename,
    sha256: packaged.sha256,
    integrity: packaged.integrity,
    sourceId: build.sourceId,
    candidateManifest: join(output, 'manifest.json'),
  }),
)
