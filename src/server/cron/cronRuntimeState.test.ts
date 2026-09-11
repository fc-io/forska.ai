import {expect, test} from 'bun:test'

import {
  buildCronRuntimeDiagnostics,
  recordCronRuntimeClassState,
  resetCronRuntimeStateForTests,
} from './cronRuntimeState.ts'

test('cron runtime diagnostics keep operational judgment crons active under a low-memory maintenance owner', () => {
  resetCronRuntimeStateForTests()

  const diagnostics = buildCronRuntimeDiagnostics({
    duckdbMemoryLimit: '6400MiB',
    mutationWorkEnabled: true,
    serverRole: 'maintenance-worker',
  })

  expect(diagnostics.lowMemoryOwner).toBe(true)
  expect(diagnostics.operationalJudgmentCrons).toMatchObject({active: true, reason: null})
  expect(diagnostics.heavyMaintenanceCrons).toMatchObject({active: false, reason: 'deferred-low-memory-owner'})
  expect(diagnostics.lowMemoryThresholdMiB).toBe(8192)
})

test('cron runtime diagnostics expose full maintenance crons above the low-memory threshold', () => {
  resetCronRuntimeStateForTests()

  const diagnostics = buildCronRuntimeDiagnostics({
    duckdbMemoryLimit: '8193MiB',
    mutationWorkEnabled: true,
    serverRole: 'maintenance-worker',
  })

  expect(diagnostics.lowMemoryOwner).toBe(false)
  expect(diagnostics.operationalJudgmentCrons.active).toBe(true)
  expect(diagnostics.heavyMaintenanceCrons).toMatchObject({active: true, reason: null})
})

test('cron runtime diagnostics keep owner-only import under operational judgment crons', () => {
  resetCronRuntimeStateForTests()

  expect(
    buildCronRuntimeDiagnostics({duckdbMemoryLimit: '6400MiB', mutationWorkEnabled: true, serverRole: 'judge-worker'})
      .importOnlyCrons,
  ).toMatchObject({active: false, reason: 'role-not-maintenance-capable'})
  expect(
    buildCronRuntimeDiagnostics({duckdbMemoryLimit: '6400MiB', mutationWorkEnabled: true, serverRole: 'dev-single'})
      .importOnlyCrons,
  ).toMatchObject({active: false, reason: 'covered-by-operational-judgment-crons'})
})

test('reported cron class state can add live tick metadata', () => {
  resetCronRuntimeStateForTests()
  recordCronRuntimeClassState('operationalJudgmentCrons', {
    lastSuccessAt: '2026-09-11T05:00:01.000Z',
    lastTickAt: '2026-09-11T05:00:00.000Z',
  })

  const diagnostics = buildCronRuntimeDiagnostics({
    duckdbMemoryLimit: '6400MiB',
    mutationWorkEnabled: true,
    serverRole: 'maintenance-worker',
  })

  expect(diagnostics.operationalJudgmentCrons).toMatchObject({
    active: true,
    lastSuccessAt: '2026-09-11T05:00:01.000Z',
    lastTickAt: '2026-09-11T05:00:00.000Z',
    source: 'reported',
  })
})
