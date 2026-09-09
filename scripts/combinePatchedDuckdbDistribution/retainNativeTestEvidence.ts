import assert from 'node:assert/strict'

import {hashDistributionInput} from '../buildDuckdbDistribution/hashDistributionInput'
import {assertNativeTestReport} from '../buildPatchedDuckdb/assertNativeTestReport'
import {assertNativeConsoleEvidence} from './assertNativeConsoleEvidence'
import type {NativeVerificationEvidence} from './nativeVerificationEvidence'

export const retainNativeTestEvidence = (entry: NativeVerificationEvidence, files: Record<string, Uint8Array>) => {
  const target = `${entry.build.platform}-${entry.build.arch}`
  const filename = `${target}-native-tests.xml`
  const consoleFilename = `${target}-native-console.log`
  assert.ok(!files[filename] && !files[consoleFilename], 'Duplicate native verification target')
  if (entry.nativeConsole) {
    assert.equal(entry.nativeXml, undefined, 'Native evidence must have exactly one representation')
    const {log, job} = entry.nativeConsole
    const result = assertNativeConsoleEvidence(log, job, entry.build)
    const jobFilename = `${target}-native-job.json`
    files[consoleFilename] = log
    files[jobFilename] = job
    return {
      ...result,
      format: 'github-actions-console',
      xmlRetained: false,
      passed: 18,
      failed: 0,
      skipped: 0,
      filename: consoleFilename,
      sha256: hashDistributionInput(log),
      job: {filename: jobFilename, sha256: hashDistributionInput(job)},
    }
  }
  assert.ok(entry.nativeXml)
  const xml = new TextDecoder().decode(entry.nativeXml)
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
  files[filename] = entry.nativeXml
  return {
    cases,
    format: 'junit-xml',
    xmlRetained: true,
    passed: cases.length,
    failed: 0,
    skipped: 0,
    filename,
    sha256: hashDistributionInput(entry.nativeXml),
  }
}
