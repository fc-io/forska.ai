import {expect, test} from 'bun:test'

import {assertNativeConsoleEvidence} from './assertNativeConsoleEvidence'
import {nativeConsoleFixture} from './nativeConsoleFixture'
import {retainNativeTestEvidence} from './retainNativeTestEvidence'

test('retained Actions console proves exact native inventory and original identities without synthesizing XML', () => {
  const {source, build, job, log} = nativeConsoleFixture()
  const logBytes = Buffer.from(log)
  const jobBytes = Buffer.from(JSON.stringify(job))
  expect(assertNativeConsoleEvidence(logBytes, jobBytes, build).cases).toHaveLength(18)
  const files: Record<string, Uint8Array> = {}
  const {nativeXml: _nativeXml, ...other} = source
  const proof = retainNativeTestEvidence({...other, build, nativeConsole: {log: logBytes, job: jobBytes}}, files)
  expect(proof).toMatchObject({format: 'github-actions-console', xmlRetained: false, passed: 18, failed: 0, skipped: 0})
  expect(
    Object.keys(files).some((name) => {
      return name.endsWith('.xml')
    }),
  ).toBe(false)
  expect(files['linux-arm64-native-console.log']).toBe(logBytes)
  expect(files['linux-arm64-native-job.json']).toBe(jobBytes)
})

test('console evidence rejects missing, duplicate, wrong, failed and skipped results or native gates', () => {
  const {build, job, log} = nativeConsoleFixture()
  const metadata = Buffer.from(JSON.stringify(job))
  for (const altered of [
    log.replace(/^.*\[18\/18\].*\n/m, ''),
    log.replace('[18/18]', '[17/18]'),
    log.replace('test/sql/storage/truncated_string_max_update.test took', 'test/sql/storage/unrelated.test took'),
    log.replace('took 0.001s', 'FAILED'),
    log.replace('took 0.001s', 'skipped'),
    log.replace(/\n[^\n]+\{"schemaVersion".*$/, ''),
    log.replace(`"sourceId":"${build.sourceId}"`, '"sourceId":"different"'),
  ]) {
    expect(() => {
      return assertNativeConsoleEvidence(Buffer.from(altered), metadata, build)
    }).toThrow()
  }
  for (const altered of [
    {...job, run_id: 999},
    {...job, name: 'native-linux-x64'},
    {...job, head_sha: '9'.repeat(40)},
    {
      ...job,
      steps: job.steps.map((step) => {
        return {...step, conclusion: 'skipped'}
      }),
    },
    {...job, steps: [...job.steps, {name: 'Compile', status: 'completed', conclusion: 'failure'}]},
  ]) {
    expect(() => {
      return assertNativeConsoleEvidence(Buffer.from(log), Buffer.from(JSON.stringify(altered)), build)
    }).toThrow()
  }
})

test('console accepts only a later retention failure, preserving original successful gate proof', () => {
  const {build, job, log} = nativeConsoleFixture()
  const metadata = {
    ...job,
    conclusion: 'failure',
    steps: [...job.steps, {name: 'Run actions/upload-artifact@v4', status: 'completed', conclusion: 'failure'}],
  }
  expect(
    assertNativeConsoleEvidence(Buffer.from(log), Buffer.from(JSON.stringify(metadata)), build).cases,
  ).toHaveLength(18)
  const earlier = {...metadata, steps: [metadata.steps.at(-1), ...job.steps]}
  expect(() => {
    return assertNativeConsoleEvidence(Buffer.from(log), Buffer.from(JSON.stringify(earlier)), build)
  }).toThrow('Non-retention job failure')
})
