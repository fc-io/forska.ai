import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {gunzipSync} from 'node:zlib'

import {Archive} from 'bun'
import {expect, test} from 'bun:test'

import manifest from '../vendor/duckdb/manifest.json'
import {buildPlatformPackage, type DistributionPlatform} from './buildDuckdbDistribution/buildPlatformPackage'
import {createDeterministicTarball} from './buildDuckdbDistribution/createDeterministicTarball'
import {getDistributionIntegrity, hashDistributionInput} from './buildDuckdbDistribution/hashDistributionInput'

const bytes = (text: string) => {
  return new TextEncoder().encode(text)
}

const readText = (files: Map<string, File>, name: string) => {
  const value = files.get(name)
  assert.ok(value, `missing ${name}`)
  return value.text()
}

const getFailureMessage = async (input: Parameters<typeof buildPlatformPackage>[0]) => {
  const result: unknown = await buildPlatformPackage(input).catch((error: unknown) => {
    return error
  })
  assert.ok(result instanceof Error, 'expected packaging to fail')
  return result.message
}

const fixture = async (metadataOverride: Record<string, unknown> = {}) => {
  const base = manifest.platforms[0] as DistributionPlatform
  const bridge = bytes('pinned bridge')
  const license = bytes('pinned MIT bridge license')
  const native = bytes('pinned preview engine')
  const bridgeMetadata = {
    name: base.packageName,
    version: manifest.nodeBindingsVersion,
    license: 'MIT',
    os: [base.platform],
    cpu: [base.arch],
    repository: {type: 'git', url: 'https://github.com/duckdb/duckdb-node-neo.git'},
    ...metadataOverride,
  }
  const bridgeArchive = await new Archive({
    'package/package.json': JSON.stringify(bridgeMetadata),
    'package/duckdb.node': bridge,
    'package/LICENSE': license,
    [`package/${base.native.filename}`]: bytes('old engine must not be copied'),
  }).bytes()
  const nativeArchive = await new Archive({[base.native.filename]: native}).bytes()
  const nativeLicense = new Uint8Array(await readFile(new URL('../vendor/duckdb/DUCKDB_LICENSE', import.meta.url)))
  const platform = {
    ...base,
    artifact: {...base.artifact, sha256: hashDistributionInput(nativeArchive)},
    native: {...base.native, sha256: hashDistributionInput(native)},
    bridge: {
      ...base.bridge,
      sha256: hashDistributionInput(bridgeArchive),
      integrity: getDistributionIntegrity(bridgeArchive),
      binarySha256: hashDistributionInput(bridge),
      licenseSha256: hashDistributionInput(license),
    },
  }
  return {platform, bridgeArchive, nativeArchive, nativeLicense}
}

test('distribution replaces the engine without changing the verified Node bridge or adding install scripts', async () => {
  const built = await buildPlatformPackage(await fixture())
  const files = await new Archive(built.bytes).files()
  const metadata = JSON.parse(await readText(files, 'package/package.json')) as Record<string, unknown>
  const provenance = JSON.parse(await readText(files, 'package/FORSKA_DUCKDB_PROVENANCE.json')) as {
    engine: typeof manifest.engine
    nodeBindingsVersion: string
  }
  expect(metadata.version).toBe(manifest.distributionVersion)
  expect(metadata.name).toBe(manifest.platforms[0]?.packageName)
  expect(metadata.os).toEqual(['darwin'])
  expect(metadata.cpu).toEqual(['arm64'])
  expect(metadata.main).toBe('./duckdb.node')
  expect(metadata.scripts).toBeUndefined()
  expect(metadata.dependencies).toBeUndefined()
  expect(await readText(files, 'package/duckdb.node')).toBe('pinned bridge')
  expect(await readText(files, 'package/libduckdb.dylib')).toBe('pinned preview engine')
  expect(await readText(files, 'package/LICENSE')).toBe('pinned MIT bridge license')
  expect(await readText(files, 'package/DUCKDB_LICENSE')).toContain('Permission is hereby granted')
  expect(provenance.engine.sourceRevision).toBe(manifest.engine.sourceRevision)
  expect(provenance.nodeBindingsVersion).toBe(manifest.nodeBindingsVersion)
})

test('package output is deterministic and contains normalized ownership and timestamps', async () => {
  const input = await fixture()
  const first = await buildPlatformPackage(input)
  const second = await buildPlatformPackage(input)
  expect(first.bytes).toEqual(second.bytes)
  expect(first.sha256).toBe(hashDistributionInput(second.bytes))
  const tar = gunzipSync(first.bytes)
  expect(tar.subarray(108, 115).toString()).toBe('0000000')
  expect(tar.subarray(116, 123).toString()).toBe('0000000')
  expect(tar.subarray(136, 147).toString()).toBe('00000000000')
  expect(createDeterministicTarball({'package/b': bytes('b'), 'package/a': bytes('a')})).toEqual(
    createDeterministicTarball({'package/a': bytes('a'), 'package/b': bytes('b')}),
  )
})

test('a patched candidate records its native origin without mutating the active package manifest', async () => {
  const originalManifest = structuredClone(manifest)
  const input = await fixture()
  const nativeBuild = {sourceRevision: manifest.engine.sourceRevision, patches: [{sha256: 'f'.repeat(64)}]}
  const distribution = {
    ...manifest,
    distributionVersion: '2.0.0-alpha40881.forska.2',
    engine: {...manifest.engine, sourceId: 'ffffffffff', nativeBuild},
  }
  const first = await buildPlatformPackage({...input, distribution, platform: {...input.platform, nativeBuild}})
  const second = await buildPlatformPackage({...input, distribution, platform: {...input.platform, nativeBuild}})
  const files = await new Archive(first.bytes).files()
  const provenance = JSON.parse(await readText(files, 'package/FORSKA_DUCKDB_PROVENANCE.json')) as {
    distributionVersion: string
    engine: {sourceId: string}
    nativeBuild: typeof nativeBuild
  }
  expect(first.bytes).toEqual(second.bytes)
  expect(provenance.distributionVersion).toBe(distribution.distributionVersion)
  expect(provenance.engine.sourceId).toBe('ffffffffff')
  expect(provenance.nativeBuild).toEqual(nativeBuild)
  expect(manifest).toEqual(originalManifest)
})

test('distribution rejects corrupt native inputs before unpacking', async () => {
  const input = await fixture()
  expect(await getFailureMessage({...input, nativeArchive: bytes('corrupt archive')})).toContain('checksum mismatch')
})

test('distribution rejects a bridge whose npm integrity differs from the pinned registry metadata', async () => {
  const input = await fixture()
  input.platform.bridge.integrity = 'sha512-invalid'
  expect(await getFailureMessage(input)).toContain('bridge npm integrity mismatch')
})

test('distribution rejects an unexpected bridge package identity or architecture', async () => {
  expect(await getFailureMessage(await fixture({name: 'unexpected'}))).toContain('bridge package name mismatch')
  expect(await getFailureMessage(await fixture({cpu: ['x64']}))).toContain('bridge architecture mismatch')
})

test('distribution refuses install scripts and alternate engine dependencies', async () => {
  expect(await getFailureMessage(await fixture({scripts: {postinstall: 'compile'}}))).toContain('installation scripts')
  expect(await getFailureMessage(await fixture({optionalDependencies: {fallback: '*'}}))).toContain('fallback engine')
})

test('distribution fails when unpacked native contents do not match the pinned file digest', async () => {
  const input = await fixture()
  input.platform.native.sha256 = '0'.repeat(64)
  expect(await getFailureMessage(input)).toContain('DuckDB engine library: checksum mismatch')
})

test('tar creation refuses paths escaping the package and nested installation files', () => {
  expect(() => {
    return createDeterministicTarball({'../escape': bytes('bad')})
  }).toThrow('flat regular files')
  expect(() => {
    return createDeterministicTarball({'package/../escape': bytes('bad')})
  }).toThrow('flat regular files')
})

test('manifest covers every supported upstream bridge with pinned engine and bridge input hashes', () => {
  expect(
    manifest.platforms
      .map(({platform, arch}) => {
        return `${platform}-${arch}`
      })
      .sort(),
  ).toEqual(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'])
  expect(
    manifest.platforms.every((platform) => {
      return /^[a-f0-9]{64}$/.test(platform.artifact.sha256)
    }),
  ).toBe(true)
  expect(
    manifest.platforms.every((platform) => {
      return /^[a-f0-9]{64}$/.test(platform.bridge.binarySha256)
    }),
  ).toBe(true)
  expect(
    manifest.platforms.every((platform) => {
      return /^[a-f0-9]{64}$/.test(platform.native.sha256)
    }),
  ).toBe(true)
})
