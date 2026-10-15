import {afterEach, expect, test} from 'bun:test'

import {
  type DuckdbWorkloadContext,
  getDuckdbInFlightWorkloadsSnapshot,
  runMeasuredDuckdbJsonWorkload,
} from '../../utils/duckdbService.ts'
import {
  getProjectTransferExclusiveWorkActiveMaintenance,
  resetDuckdbExclusiveWorkForTests,
  runWithDuckdbExclusiveWork,
} from './projectTransferDuckdbExclusiveWork.ts'

const projectorContext: DuckdbWorkloadContext = {
  fallbackIntent: 'async',
  routeOrJobKey: 'reviewServing.projector.worker',
  workloadClass: 'reviewProjector',
}

const sessionContext: DuckdbWorkloadContext = {
  fallbackIntent: 'reject',
  routeOrJobKey: 'projectTransfer.session',
  workloadClass: 'projectTransfer',
}

const comparisonServingContext: DuckdbWorkloadContext = {
  fallbackIntent: 'async',
  routeOrJobKey: 'comparisonServing.rebuild',
  workloadClass: 'comparisonServing',
}

const providerListContext: DuckdbWorkloadContext = {
  fallbackIntent: 'reject',
  routeOrJobKey: 'providers.connections.list',
  workloadClass: 'providers',
}

const operationByQueue = {append: 'appendQuery', background: 'backgroundQuery', main: 'mainQuery'} as const

const getGate = () => {
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })

  return {gate, release}
}

const runGatedWorkload = ({
  context,
  gate,
  queue,
}: {
  context?: DuckdbWorkloadContext
  gate: Promise<void>
  queue: keyof typeof operationByQueue
}) => {
  return runMeasuredDuckdbJsonWorkload({
    operation: operationByQueue[queue],
    queue,
    queueDepthAtStart: 0,
    workloadContext: context,
    work: async () => {
      await gate
      return []
    },
  })
}

afterEach(() => {
  resetDuckdbExclusiveWorkForTests()
})

test('project transfer readiness reports in-flight maintenance on every owner lane until it settles', async () => {
  const {gate, release} = getGate()
  const workloads = [
    runGatedWorkload({context: projectorContext, gate, queue: 'background'}),
    runGatedWorkload({context: comparisonServingContext, gate, queue: 'main'}),
    runGatedWorkload({context: projectorContext, gate, queue: 'append'}),
    runGatedWorkload({context: sessionContext, gate, queue: 'main'}),
  ]
  const inFlight = getDuckdbInFlightWorkloadsSnapshot()
  const activeMaintenance = getProjectTransferExclusiveWorkActiveMaintenance()

  release()
  await Promise.all(workloads)

  expect(
    inFlight.map(({exclusiveWorkCompatible, operation, queue, routeOrJobKey}) => {
      return {exclusiveWorkCompatible, operation, queue, routeOrJobKey}
    }),
  ).toEqual([
    {
      exclusiveWorkCompatible: false,
      operation: 'backgroundQuery',
      queue: 'background',
      routeOrJobKey: 'reviewServing.projector.worker',
    },
    {exclusiveWorkCompatible: false, operation: 'mainQuery', queue: 'main', routeOrJobKey: 'comparisonServing.rebuild'},
    {
      exclusiveWorkCompatible: false,
      operation: 'appendQuery',
      queue: 'append',
      routeOrJobKey: 'reviewServing.projector.worker',
    },
    {exclusiveWorkCompatible: true, operation: 'mainQuery', queue: 'main', routeOrJobKey: 'projectTransfer.session'},
  ])
  expect(
    activeMaintenance.map((description) => {
      return description.slice(0, description.lastIndexOf(' for '))
    }),
  ).toEqual([
    'background backgroundQuery reviewServing.projector.worker',
    'main mainQuery comparisonServing.rebuild',
    'append appendQuery reviewServing.projector.worker',
  ])
  expect(getDuckdbInFlightWorkloadsSnapshot()).toEqual([])
  expect(getProjectTransferExclusiveWorkActiveMaintenance()).toEqual([])
})

test('project transfer readiness drops settled workloads after failures', async () => {
  const failure = await runMeasuredDuckdbJsonWorkload({
    operation: 'backgroundQuery',
    queue: 'background',
    queueDepthAtStart: 0,
    workloadContext: projectorContext,
    work: async () => {
      throw new Error('maintenance query failed')
    },
  }).then(
    () => {
      return null
    },
    (error: unknown) => {
      return error instanceof Error ? error.message : String(error)
    },
  )

  expect(failure).toBe('maintenance query failed')
  expect(getProjectTransferExclusiveWorkActiveMaintenance()).toEqual([])
})

test('project transfer exclusive work admits its own contextual DuckDB work without counting it as maintenance', async () => {
  const observed = await runWithDuckdbExclusiveWork(
    {kind: 'project_transfer_import', phase: 'commit', sessionId: 'exclusive-owner-session'},
    async () => {
      let activeMaintenanceDuringOwnWork: string[] = []
      const rows = await runMeasuredDuckdbJsonWorkload({
        operation: 'mainQuery',
        queue: 'main',
        queueDepthAtStart: 0,
        workloadContext: providerListContext,
        work: async () => {
          activeMaintenanceDuringOwnWork = getProjectTransferExclusiveWorkActiveMaintenance()
          return [{connectionCount: 1}]
        },
      })

      return {activeMaintenanceDuringOwnWork, rows}
    },
  )

  expect(observed).toEqual({activeMaintenanceDuringOwnWork: [], rows: [{connectionCount: 1}]})
})
