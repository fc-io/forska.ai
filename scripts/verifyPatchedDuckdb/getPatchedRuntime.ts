import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync, realpathSync} from 'node:fs'
import {createRequire} from 'node:module'
import {dirname, isAbsolute, join, relative} from 'node:path'

import type {DistributionManifest} from '../buildDuckdbDistribution/distributionManifest'

export const getPatchedRuntime = (root: string, distribution: DistributionManifest) => {
  const platform = distribution.platforms.find((item) => {
    return item.platform === process.platform && item.arch === process.arch
  })
  assert.ok(platform?.nativeBuild, 'Candidate must contain an attested native build for this runner')
  const require = createRequire(join(root, 'package.json'))
  const apiPath = require.resolve('@duckdb/node-api')
  const apiRequire = createRequire(apiPath)
  const bindingsPath = apiRequire.resolve('@duckdb/node-bindings')
  const bindingsRequire = createRequire(bindingsPath)
  const nativePath = bindingsRequire.resolve(`${platform.packageName}/duckdb.node`)
  const nativeRoot = dirname(nativePath)
  const apiMetadata = require.resolve('@duckdb/node-api/package.json')
  const bindingMetadata = apiRequire.resolve('@duckdb/node-bindings/package.json')
  for (const path of [
    apiPath,
    bindingsPath,
    nativePath,
    apiMetadata,
    bindingMetadata,
    ...['package.json', platform.native.filename, 'FORSKA_DUCKDB_PROVENANCE.json', 'LICENSE', 'DUCKDB_LICENSE'].map(
      (filename) => {
        return join(nativeRoot, filename)
      },
    ),
  ]) {
    const resolved = relative(realpathSync(root), realpathSync(path))
    assert.ok(
      !isAbsolute(resolved) && resolved !== '..' && !resolved.startsWith('../') && !resolved.startsWith('..\\'),
      'Candidate dependency escaped its isolated package root',
    )
  }
  const readJson = (path: string) => {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  }
  assert.equal(readJson(apiMetadata).version, distribution.nodeBindingsVersion)
  assert.equal(readJson(bindingMetadata).version, distribution.nodeBindingsVersion)
  const metadata = readJson(join(nativeRoot, 'package.json'))
  assert.equal(metadata.name, platform.packageName)
  assert.equal(metadata.version, distribution.distributionVersion)
  assert.equal(metadata.scripts, undefined)
  for (const [filename, expected] of Object.entries({
    'duckdb.node': platform.bridge.binarySha256,
    [platform.native.filename]: platform.native.sha256,
    LICENSE: platform.bridge.licenseSha256,
    DUCKDB_LICENSE: distribution.nativeLicense.sha256,
  })) {
    assert.equal(
      createHash('sha256')
        .update(readFileSync(join(nativeRoot, filename)))
        .digest('hex'),
      expected,
    )
  }
  const provenance = readJson(join(nativeRoot, 'FORSKA_DUCKDB_PROVENANCE.json'))
  assert.equal(provenance.distributionVersion, distribution.distributionVersion)
  assert.deepEqual(provenance.engine, distribution.engine)
  assert.deepEqual(provenance.nativeBuild, platform.nativeBuild)
  return require(apiPath) as typeof import('@duckdb/node-api')
}
