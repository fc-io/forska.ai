import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync, realpathSync} from 'node:fs'
import {createRequire} from 'node:module'
import {dirname, isAbsolute, join, relative} from 'node:path'

import {assertDuckdbEngineVersion} from '../../src/server/utils/duckdbEngineContract.ts'
import manifest from '../../vendor/duckdb/manifest.json'

const assertContainedFile = (root: string, filename: string) => {
  const path = relative(realpathSync(root), realpathSync(filename))
  assert.ok(
    !isAbsolute(path) && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\'),
    `Dependency resolved outside the verified application: ${filename}`,
  )
}

const assertFileHash = (filename: string, expected: string) => {
  assert.equal(
    createHash('sha256').update(readFileSync(filename)).digest('hex'),
    expected,
    `Installed distribution file does not match the pinned manifest: ${filename}`,
  )
}

export const getInstalledDuckdbDistribution = (packageRoot: string) => {
  const platform = manifest.platforms.find((candidate) => {
    return candidate.platform === process.platform && candidate.arch === process.arch
  })
  assert.ok(platform, `No pinned DuckDB distribution for ${process.platform}-${process.arch}`)
  const rootRequire = createRequire(join(packageRoot, 'package.json'))
  const apiPath = rootRequire.resolve('@duckdb/node-api')
  const bindingsPath = createRequire(apiPath).resolve('@duckdb/node-bindings')
  const nativePath = createRequire(bindingsPath).resolve(`${platform.packageName}/duckdb.node`)
  const packageDirectory = dirname(nativePath)
  ;[apiPath, bindingsPath, nativePath].map((path) => {
    return assertContainedFile(packageRoot, path)
  })
  const apiMetadataPath = rootRequire.resolve('@duckdb/node-api/package.json')
  const bindingsMetadataPath = createRequire(apiPath).resolve('@duckdb/node-bindings/package.json')
  ;[
    apiMetadataPath,
    bindingsMetadataPath,
    ...['package.json', 'FORSKA_DUCKDB_PROVENANCE.json', platform.native.filename, 'LICENSE', 'DUCKDB_LICENSE'].map(
      (filename) => {
        return join(packageDirectory, filename)
      },
    ),
  ].map((path) => {
    return assertContainedFile(packageRoot, path)
  })
  const apiMetadata = JSON.parse(readFileSync(apiMetadataPath, 'utf8')) as Record<string, unknown>
  const bindingsMetadata = JSON.parse(readFileSync(bindingsMetadataPath, 'utf8')) as Record<string, unknown>
  assert.equal(apiMetadata.version, manifest.nodeBindingsVersion, 'Unexpected high-level Node API version')
  assert.equal(bindingsMetadata.version, manifest.nodeBindingsVersion, 'Unexpected Node binding router version')
  const metadata = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8')) as Record<string, unknown>
  assert.equal(metadata.name, platform.packageName)
  assert.equal(metadata.version, manifest.distributionVersion)
  assert.equal(metadata.scripts, undefined, 'Native package must not have install scripts')
  const provenance = JSON.parse(
    readFileSync(join(packageDirectory, 'FORSKA_DUCKDB_PROVENANCE.json'), 'utf8'),
  ) as Record<string, unknown>
  assert.equal(provenance.distributionVersion, manifest.distributionVersion)
  assert.deepEqual(provenance.engine, manifest.engine)
  assert.equal(provenance.nodeBindingsVersion, manifest.nodeBindingsVersion)
  assert.equal(provenance.platform, process.platform)
  assert.equal(provenance.arch, process.arch)
  assertFileHash(nativePath, platform.bridge.binarySha256)
  assertFileHash(join(packageDirectory, platform.native.filename), platform.native.sha256)
  assertFileHash(join(packageDirectory, 'LICENSE'), platform.bridge.licenseSha256)
  assertFileHash(join(packageDirectory, 'DUCKDB_LICENSE'), manifest.nativeLicense.sha256)
  const api = rootRequire('@duckdb/node-api') as typeof import('@duckdb/node-api')
  assertDuckdbEngineVersion(api.version())
  console.log('duckdb-distribution:verified', {
    engine: api.version(),
    platform: `${process.platform}-${process.arch}`,
    packageDirectory,
    sourceRevision: manifest.engine.sourceRevision,
    distributionVersion: manifest.distributionVersion,
  })
  return api
}
