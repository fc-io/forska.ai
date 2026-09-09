import assert from 'node:assert/strict'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {join, resolve} from 'node:path'
import {parseArgs} from 'node:util'

import {file} from 'bun'
import {Effect} from 'effect'

import manifest from '../vendor/duckdb/manifest.json'
import {acquireDistributionInput} from './buildDuckdbDistribution/acquireDistributionInput'
import {buildPlatformPackage} from './buildDuckdbDistribution/buildPlatformPackage'
import type {DistributionManifest} from './buildDuckdbDistribution/distributionManifest'

export const buildDuckdbDistribution = (options: {
  inputDir: string
  outputDir: string
  platform?: string
  offline: boolean
  upstream?: boolean
  distribution?: DistributionManifest
}) => {
  return Effect.gen(function* () {
    const {inputDir, outputDir, offline} = options
    const distribution = options.distribution ?? manifest
    assert.notEqual(resolve(inputDir), resolve(outputDir), 'Inputs and outputs must be separate directories')
    const platforms = distribution.platforms.filter((item) => {
      return !options.platform || `${item.platform}-${item.arch}` === options.platform
    })
    assert.ok(platforms.length > 0, `Unsupported distribution platform: ${options.platform}`)
    yield* Effect.tryPromise(() => {
      return Promise.all([mkdir(inputDir, {recursive: true}), mkdir(outputDir, {recursive: true})])
    })
    const source = <T extends {filename: string}>(input: T) => {
      return {
        ...input,
        mirrorUrl: options.upstream ? undefined : new URL(input.filename, distribution.release.baseUrl).href,
      }
    }
    const nativeLicense = yield* acquireDistributionInput(source(distribution.nativeLicense), inputDir, offline)
    const results = yield* Effect.forEach(platforms, (platform) => {
      return Effect.gen(function* () {
        const bridgeArchive = yield* acquireDistributionInput(source(platform.bridge), inputDir, offline)
        const nativeArchive = yield* acquireDistributionInput(source(platform.artifact), inputDir, offline)
        const built = yield* Effect.tryPromise(() => {
          return buildPlatformPackage({platform, bridgeArchive, nativeArchive, nativeLicense, distribution})
        })
        assert.equal(built.sha256, platform.sha256, `${platform.filename}: distribution is not reproducible`)
        assert.equal(built.integrity, platform.integrity, `${platform.filename}: distribution integrity mismatch`)
        const destination = join(outputDir, platform.filename)
        yield* Effect.tryPromise(async () => {
          if (await file(destination).exists()) {
            assert.deepEqual(
              new Uint8Array(await readFile(destination)),
              new Uint8Array(built.bytes),
              'Refusing to overwrite different release artifact',
            )
          } else {
            await writeFile(destination, built.bytes, {flag: 'wx'})
          }
        })
        const result = {
          filename: platform.filename,
          sha256: built.sha256,
          integrity: built.integrity,
          bytes: built.bytes.length,
        }
        console.log(JSON.stringify(result))
        return result
      })
    })
    const checksums = results
      .map((result) => {
        return `${result.sha256}  ${result.filename}`
      })
      .join('\n')
    yield* Effect.tryPromise(() => {
      return writeFile(join(outputDir, 'SHA256SUMS'), `${checksums}\n`)
    })
    return results
  })
}

if (import.meta.main) {
  const {values} = parseArgs({
    args: process.argv.slice(2),
    options: {
      'input-dir': {type: 'string', default: '.tmp/duckdb-distribution-inputs'},
      'output-dir': {type: 'string', default: '.tmp/duckdb-distribution'},
      platform: {type: 'string'},
      offline: {type: 'boolean', default: false},
      upstream: {type: 'boolean', default: false},
      manifest: {type: 'string'},
    },
    strict: true,
  })
  await Effect.runPromise(
    buildDuckdbDistribution({
      inputDir: values['input-dir'],
      outputDir: values['output-dir'],
      platform: values.platform,
      offline: values.offline,
      upstream: values.upstream,
      distribution: values.manifest ? ((await file(values.manifest).json()) as DistributionManifest) : undefined,
    }),
  )
}
