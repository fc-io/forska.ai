import assert from 'node:assert/strict'

import type {NativeBuild} from '../stagePatchedDuckdbDistribution/readNativeBuild'
import {nativeConsoleCases} from './nativeConsoleCases'
import type {NativeConsoleJob} from './nativeConsoleJob'

export const assertNativeConsoleEvidence = (log: Uint8Array, metadata: Uint8Array, build: NativeBuild) => {
  const job = JSON.parse(new TextDecoder().decode(metadata)) as NativeConsoleJob
  assert.equal(build.platform, 'linux', 'Console representation is reserved for the Linux container retention gap')
  assert.ok(Number.isSafeInteger(job.id) && job.id > 0)
  assert.equal(String(job.run_id), build.workflow.runId)
  assert.equal(String(job.run_attempt), build.workflow.runAttempt)
  assert.match(job.head_sha, /^[a-f0-9]{40}$/)
  assert.match(build.workflow.commit ?? '', /^[a-f0-9]{40}$/)
  assert.equal(job.name, `native-${build.platform}-${build.arch}`)
  assert.equal(job.status, 'completed')
  assert.equal(job.run_url, `https://api.github.com/repos/${build.workflow.repository}/actions/runs/${job.run_id}`)
  assert.equal(job.url, `https://api.github.com/repos/${build.workflow.repository}/actions/jobs/${job.id}`)
  const gates = [
    'Build pinned source and run native regressions',
    'Stage immutable native package with official Node bridge',
    'Verify real predicates, UPDATE, WAL and low-memory checkpoint',
  ].map((name) => {
    const steps = job.steps.filter((step) => {
      return step.name === name
    })
    assert.equal(steps.length, 1, 'Required native job step is missing or duplicated')
    assert.equal(steps[0]?.status, 'completed')
    assert.equal(steps[0]?.conclusion, 'success', 'Required native gate failed or was skipped')
    return job.steps.indexOf(steps[0])
  })
  assert.deepEqual(
    gates,
    gates.toSorted((a, b) => {
      return a - b
    }),
    'Native gates are out of order',
  )
  const failures = job.steps.filter((step) => {
    return step.conclusion === 'failure'
  })
  assert.ok(
    failures.every((step) => {
      return (
        step.name === 'Run actions/upload-artifact@v4'
        && step.status === 'completed'
        && job.steps.indexOf(step) > Math.max(...gates)
      )
    }),
    'Non-retention job failure',
  )
  assert.equal(job.conclusion, failures.length > 0 ? 'failure' : 'success')
  const lines = new TextDecoder()
    .decode(log)
    .split('\n')
    .map((line) => {
      return line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, '')
    })
  const checkout = lines.findIndex((line) => {
    return line.endsWith('git log -1 --format=%H')
  })
  assert.ok(checkout >= 0, 'Missing checked-out commit evidence')
  assert.equal(lines[checkout + 1], build.workflow.commit)
  assert.ok(
    job.head_sha === build.workflow.commit
      || lines.some((line) => {
        return line.includes(`Merge ${job.head_sha} into `)
      }),
    'Job head commit is absent from checkout evidence',
  )
  const records = lines.filter((line) => {
    return line.startsWith('{"schemaVersion":1,"distributionVersion":')
  })
  assert.equal(records.length, 1, 'Missing or duplicated successful native build attestation')
  assert.deepEqual(JSON.parse(records[0] ?? ''), build, 'Console native provenance differs from original package')
  const start = lines.findIndex((line) => {
    return line.startsWith('[0/18] (0%):')
  })
  const end = lines.indexOf(records[0] ?? '')
  assert.ok(start > checkout && end > start, 'Native results must precede successful build attestation')
  const results = lines.slice(start + 1, end).filter((line) => {
    return line.trim() !== ''
  })
  assert.equal(results.length, 18, 'Expected exactly 18 completed native results without failure/skip output')
  const cases = results
    .map((line, index) => {
      const match = /^\[(\d+)\/18\] \(\d+%\): (.+) took \d+(?:\.\d+)?s$/.exec(line)
      assert.ok(match, 'Invalid, failed or skipped native result')
      assert.equal(Number(match[1]), index + 1, 'Missing or duplicated native result')
      assert.ok(match[2])
      return match[2]
    })
    .sort()
  assert.deepEqual(cases, nativeConsoleCases.toSorted(), 'Native console inventory differs from exact 18-case gate')
  return {cases, jobId: job.id, runId: job.run_id, headCommit: job.head_sha, buildCommit: build.workflow.commit}
}
