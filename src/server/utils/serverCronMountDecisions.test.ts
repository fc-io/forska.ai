import {expect, test} from 'bun:test'

import {getServerCronMountDecisions} from './serverCronMountDecisions.ts'
import type {EffectiveServerRole} from './serverRole.ts'

const getDecisions = (params: {
  duckdbMemoryLimit: string
  serverRole: EffectiveServerRole
  shouldRunMutatingServerWork?: boolean
}) => {
  return getServerCronMountDecisions({
    shouldRunMutatingServerWork: params.shouldRunMutatingServerWork ?? true,
    ...params,
  })
}

test('low-memory maintenance owner mounts operational judgment crons but defers heavy maintenance', () => {
  expect(getDecisions({duckdbMemoryLimit: '6400MiB', serverRole: 'maintenance-worker'})).toEqual({
    shouldDeferHeavyMaintenanceCronsForLowMemoryOwner: true,
    shouldMountHeavyMaintenanceCrons: false,
    shouldMountImportOnlyJudgmentCrons: false,
    shouldMountJudgingCrons: false,
    shouldMountOperationalJudgmentCrons: true,
  })
})

test('maintenance owner above the low-memory threshold mounts operational and heavy maintenance crons', () => {
  expect(getDecisions({duckdbMemoryLimit: '8193MiB', serverRole: 'maintenance-worker'})).toEqual({
    shouldDeferHeavyMaintenanceCronsForLowMemoryOwner: false,
    shouldMountHeavyMaintenanceCrons: true,
    shouldMountImportOnlyJudgmentCrons: false,
    shouldMountJudgingCrons: false,
    shouldMountOperationalJudgmentCrons: true,
  })
})

test('dev-single avoids duplicate import-only mounting when operational and judging crons both mount', () => {
  expect(getDecisions({duckdbMemoryLimit: '6400MiB', serverRole: 'dev-single'})).toEqual({
    shouldDeferHeavyMaintenanceCronsForLowMemoryOwner: true,
    shouldMountHeavyMaintenanceCrons: false,
    shouldMountImportOnlyJudgmentCrons: false,
    shouldMountJudgingCrons: true,
    shouldMountOperationalJudgmentCrons: true,
  })
})

test('judge workers mount judging crons without owner-only import crons', () => {
  expect(getDecisions({duckdbMemoryLimit: '6400MiB', serverRole: 'judge-worker'})).toEqual({
    shouldDeferHeavyMaintenanceCronsForLowMemoryOwner: false,
    shouldMountHeavyMaintenanceCrons: false,
    shouldMountImportOnlyJudgmentCrons: false,
    shouldMountJudgingCrons: true,
    shouldMountOperationalJudgmentCrons: false,
  })
})

test('disabled mutation work prevents cron mounting', () => {
  expect(
    getDecisions({duckdbMemoryLimit: '6400MiB', serverRole: 'maintenance-worker', shouldRunMutatingServerWork: false}),
  ).toEqual({
    shouldDeferHeavyMaintenanceCronsForLowMemoryOwner: false,
    shouldMountHeavyMaintenanceCrons: false,
    shouldMountImportOnlyJudgmentCrons: false,
    shouldMountJudgingCrons: false,
    shouldMountOperationalJudgmentCrons: false,
  })
})
