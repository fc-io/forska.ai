import assert from 'node:assert/strict'
import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'

import {createDeterministicTarball} from '../buildDuckdbDistribution/createDeterministicTarball'
import {hashDistributionInput} from '../buildDuckdbDistribution/hashDistributionInput'
import {assertNativeTestReport} from '../buildPatchedDuckdb/assertNativeTestReport'
import {
  expectedNativeVerificationPhases as expectedPhases,
  type NativeVerificationEvidence,
} from './nativeVerificationEvidence'

export const retainNativeVerificationEvidence = async (entries: NativeVerificationEvidence[], output: string) => {
  const first = entries[0]
  assert.ok(first, 'Native verification evidence is required')
  const files: Record<string, Uint8Array> = {}
  const targets = entries
    .map(({build, platform, engine, nativeXml, verification}) => {
      const target = `${platform.platform}-${platform.arch}`
      assert.match(target, /^(darwin|linux|win32)-(arm64|x64)$/)
      assert.equal(build.distributionVersion, first.build.distributionVersion)
      assert.equal(build.sourceId, engine.sourceId)
      assert.equal(build.engineVersion, engine.version)
      assert.equal(build.library.sha256, platform.native.sha256)
      const xml = new TextDecoder().decode(nativeXml)
      const cases = [...xml.matchAll(/<testcase\b[^>]*\bname="([^"]+)"/g)]
        .map((match) => {
          assert.ok(match[1])
          return match[1]
        })
        .sort()
      assertNativeTestReport(
        xml,
        cases
          .filter((name) => {
            return name.startsWith('test/sql/')
          })
          .join(','),
      )
      const result = JSON.parse(new TextDecoder().decode(verification)) as Record<string, unknown>
      assert.equal(result.passed, true)
      assert.equal(result.platform, target)
      assert.equal(result.distributionVersion, build.distributionVersion)
      assert.deepEqual(result.engine, engine)
      assert.deepEqual(result.phases, expectedPhases, 'Incomplete native package semantic verification')
      assert.equal(result.checkpointMemoryMiB, 32)
      const xmlFilename = `${target}-native-tests.xml`
      const resultFilename = `${target}-verification.json`
      assert.ok(!files[xmlFilename], 'Duplicate native verification target')
      files[xmlFilename] = nativeXml
      files[resultFilename] = verification
      return {
        target,
        sourceId: build.sourceId,
        engineVersion: build.engineVersion,
        library: build.library,
        package: {filename: platform.filename, sha256: platform.sha256, integrity: platform.integrity},
        workflow: build.workflow,
        native: {
          cases,
          passed: cases.length,
          failed: 0,
          skipped: 0,
          filename: xmlFilename,
          sha256: hashDistributionInput(nativeXml),
        },
        semantic: {
          phases: expectedPhases,
          checkpointMemoryMiB: 32,
          passed: true,
          filename: resultFilename,
          sha256: hashDistributionInput(verification),
        },
      }
    })
    .sort((left, right) => {
      return left.target.localeCompare(right.target, 'en')
    })
  const report = {
    schemaVersion: 1,
    distributionVersion: first.build.distributionVersion,
    targetCount: targets.length,
    targets,
  }
  const reportBytes = new TextEncoder().encode(`${JSON.stringify(report, null, 2)}\n`)
  files['NATIVE_VERIFICATION.json'] = reportBytes
  const bytes = createDeterministicTarball(files)
  const filename = `duckdb-native-verification-${first.build.distributionVersion}.tar.gz`
  await writeFile(join(output, filename), bytes, {flag: 'wx'})
  await writeFile(join(output, 'NATIVE_VERIFICATION.json'), reportBytes, {flag: 'wx'})
  return {filename, sha256: hashDistributionInput(bytes)}
}
