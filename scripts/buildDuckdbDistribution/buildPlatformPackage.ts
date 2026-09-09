import assert from 'node:assert/strict'

import {Archive} from 'bun'

import manifest from '../../vendor/duckdb/manifest.json'
import {createDeterministicTarball} from './createDeterministicTarball'
import type {DistributionManifest, DistributionPlatform} from './distributionManifest'
import {assertDistributionHash, getDistributionIntegrity, hashDistributionInput} from './hashDistributionInput'

export type {DistributionPlatform} from './distributionManifest'

const readArchiveFile = async (files: Map<string, File>, name: string) => {
  const entry = files.get(name)
  assert.ok(entry, `archive is missing regular file: ${name}`)
  return new Uint8Array(await entry.arrayBuffer())
}

const encodeJson = (value: unknown) => {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`)
}

export const buildPlatformPackage = async (input: {
  platform: DistributionPlatform
  bridgeArchive: Uint8Array
  nativeArchive: Uint8Array
  nativeLicense: Uint8Array
  distribution?: DistributionManifest
}) => {
  const {platform, bridgeArchive, nativeArchive, nativeLicense} = input
  const distribution = input.distribution ?? manifest
  assertDistributionHash(bridgeArchive, platform.bridge.sha256, platform.bridge.filename)
  assert.equal(getDistributionIntegrity(bridgeArchive), platform.bridge.integrity, 'bridge npm integrity mismatch')
  assertDistributionHash(nativeArchive, platform.artifact.sha256, platform.artifact.filename)
  assertDistributionHash(nativeLicense, distribution.nativeLicense.sha256, 'DuckDB engine license')
  const bridgeFiles = await new Archive(bridgeArchive).files()
  const nativeFiles = await new Archive(nativeArchive).files()
  const metadataBytes = await readArchiveFile(bridgeFiles, 'package/package.json')
  const metadata = JSON.parse(new TextDecoder().decode(metadataBytes)) as Record<string, unknown>
  assert.equal(metadata.name, platform.packageName, 'bridge package name mismatch')
  assert.equal(metadata.version, distribution.nodeBindingsVersion, 'bridge version mismatch')
  assert.deepEqual(metadata.os, [platform.platform], 'bridge OS mismatch')
  assert.deepEqual(metadata.cpu, [platform.arch], 'bridge architecture mismatch')
  assert.equal(metadata.license, 'MIT', 'bridge license mismatch')
  assert.equal(metadata.scripts, undefined, 'native package must not execute installation scripts')
  assert.equal(metadata.dependencies, undefined, 'native package must be self-contained')
  assert.equal(metadata.optionalDependencies, undefined, 'native package must not include a fallback engine')
  const bridge = await readArchiveFile(bridgeFiles, 'package/duckdb.node')
  const native = await readArchiveFile(nativeFiles, platform.native.filename)
  const bridgeLicense = await readArchiveFile(bridgeFiles, 'package/LICENSE')
  assertDistributionHash(bridge, platform.bridge.binarySha256, 'Node C bridge')
  assertDistributionHash(native, platform.native.sha256, 'DuckDB engine library')
  assertDistributionHash(bridgeLicense, platform.bridge.licenseSha256, 'Node binding license')
  const provenance = {
    schemaVersion: distribution.schemaVersion,
    distributionVersion: distribution.distributionVersion,
    engine: distribution.engine,
    nodeBindingsVersion: distribution.nodeBindingsVersion,
    platform: platform.platform,
    arch: platform.arch,
    artifact: platform.artifact,
    bridge: platform.bridge,
    files: {'duckdb.node': platform.bridge.binarySha256, [platform.native.filename]: platform.native.sha256},
    nativeLicense: distribution.nativeLicense,
    ...(platform.nativeBuild ? {nativeBuild: platform.nativeBuild} : {}),
  }
  const packageMetadata = {
    ...metadata,
    version: distribution.distributionVersion,
    main: metadata.main ?? './duckdb.node',
    description: `Forska distribution of DuckDB ${distribution.engine.version} with the official Node C bridge`,
    forskaDuckdb: {engineVersion: distribution.engine.version, sourceRevision: distribution.engine.sourceRevision},
  }
  const files = {
    'package/package.json': encodeJson(packageMetadata),
    'package/duckdb.node': bridge,
    [`package/${platform.native.filename}`]: native,
    'package/LICENSE': bridgeLicense,
    'package/DUCKDB_LICENSE': nativeLicense,
    'package/FORSKA_DUCKDB_PROVENANCE.json': encodeJson(provenance),
  }
  const bytes = createDeterministicTarball(files, platform.platform)
  return {bytes, sha256: hashDistributionInput(bytes), integrity: getDistributionIntegrity(bytes)}
}
