import {existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, expect, test} from 'bun:test'

import {
  getJudgeWorkerCompletionReplayBarrierPaths,
  waitAtJudgeWorkerCompletionReplayBarrier,
} from './judgeWorkerCompletionReplayBarrier.ts'

const originalBarrierRoot = process.env.FORSKA_TEST_JUDGE_COMPLETION_BARRIER_ROOT

afterEach(() => {
  if (originalBarrierRoot === undefined) {
    delete process.env.FORSKA_TEST_JUDGE_COMPLETION_BARRIER_ROOT
    return
  }

  process.env.FORSKA_TEST_JUDGE_COMPLETION_BARRIER_ROOT = originalBarrierRoot
})

test('completion replay barrier is inert without its explicit test environment', async () => {
  delete process.env.FORSKA_TEST_JUDGE_COMPLETION_BARRIER_ROOT
  await waitAtJudgeWorkerCompletionReplayBarrier('claim-a')
})

test('completion replay barrier is inert without a matching claim control file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'f1-completion-replay-barrier-'))
  process.env.FORSKA_TEST_JUDGE_COMPLETION_BARRIER_ROOT = root
  await waitAtJudgeWorkerCompletionReplayBarrier('claim-a')
})

test('completion replay barrier atomically consumes once and signals before owner continuation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'f1-completion-replay-barrier-'))
  const paths = getJudgeWorkerCompletionReplayBarrierPaths({claimId: 'claim-a', root})
  mkdirSync(root, {recursive: true})
  writeFileSync(paths.controlPath, '')
  process.env.FORSKA_TEST_JUDGE_COMPLETION_BARRIER_ROOT = root

  const waiting = waitAtJudgeWorkerCompletionReplayBarrier('claim-a')
  await new Promise((resolveWait) => {
    setTimeout(resolveWait, 50)
  })

  expect(JSON.parse(readFileSync(paths.signalPath, 'utf8'))).toMatchObject({claimId: 'claim-a', pid: process.pid})
  expect(existsSync(paths.consumedPath)).toBe(true)
  expect(existsSync(paths.controlPath)).toBe(false)

  await waitAtJudgeWorkerCompletionReplayBarrier('claim-a')
  writeFileSync(paths.releasePath, '')
  await waiting
})
