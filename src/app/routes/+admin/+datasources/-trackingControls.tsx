import type {Accessor} from 'solid-js'
import {For, Show} from 'solid-js'

import {
  type DataSourceTrackingState,
  defaultTrackingReconcileScheduleMonths,
  formatTrackingDateTime,
  getTrackingAvailability,
  getTrackingRangeLabel,
  getTrackingRunKindLabel,
  getTrackingScheduleLabel,
  isTrackingSupportedImportRoute,
} from './-trackingShared.ts'

type TrackingOptionsFieldProps = {
  dateFrom: Accessor<string>
  disabled?: Accessor<boolean>
  id?: string
  importRoute: Accessor<string | null>
  onScheduleMonthsChange: (months: number[]) => void
  onTrackingEnabledChange: (enabled: boolean) => void
  scheduleMonths: Accessor<number[]>
  trackingEnabled: Accessor<boolean>
}

type TrackingStatusPanelProps = {
  dataSourceId: Accessor<string>
  importRoute: Accessor<string | null | undefined>
  isRunningFullReconciliation: Accessor<boolean>
  onRunFullReconciliation: () => void
  scheduleMonths: Accessor<number[]>
  trackingEnabled: Accessor<boolean>
  trackingState: Accessor<DataSourceTrackingState | null>
}

const formatOptionalNumber = (value: number | null | undefined) => {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : 'Not reported'
}

const getActiveWorkLabel = (state: DataSourceTrackingState | null) => {
  if (!state?.activeRunKind) {
    return 'Not active'
  }

  const runKindLabel = getTrackingRunKindLabel(state.activeRunKind)
  if (typeof state.activeReconciliationAgeMonths === 'number') {
    return `${runKindLabel}, ${state.activeReconciliationAgeMonths} month bucket`
  }

  return runKindLabel
}

const hasNumber = (value: number | null | undefined) => {
  return typeof value === 'number' && Number.isFinite(value)
}

const getTrackingStatusRows = (params: {
  enabled: boolean
  scheduleMonths: number[]
  state: DataSourceTrackingState | null
}) => {
  const state = params.state
  const rows = [
    {label: 'Enabled', value: params.enabled ? 'Enabled' : 'Disabled'},
    {label: 'Granularity', value: state?.granularity ?? 'Not initialized'},
    {label: 'Last success', value: formatTrackingDateTime(state?.lastSuccessAt)},
    {label: 'High water', value: formatTrackingDateTime(state?.highWaterCompletedAt)},
    {label: 'Next run', value: formatTrackingDateTime(state?.nextRunAfter)},
    {label: 'Last reconciliation', value: formatTrackingDateTime(state?.lastReconciliationCompletedAt)},
    {label: 'Active window', value: getTrackingRangeLabel(state?.activeWindowStart, state?.activeWindowEnd)},
    {label: 'Active work', value: getActiveWorkLabel(state)},
    {label: 'Pending reconciliation', value: formatOptionalNumber(state?.pendingReconciliationCount)},
    {label: 'Schedule', value: getTrackingScheduleLabel(params.scheduleMonths)},
  ]

  if (hasNumber(state?.readySpoolWindowCount)) {
    rows.push({label: 'Ready spool windows', value: formatOptionalNumber(state?.readySpoolWindowCount)})
  }

  if (hasNumber(state?.pendingSpoolPageCount)) {
    rows.push({label: 'Pending spool pages', value: formatOptionalNumber(state?.pendingSpoolPageCount)})
  }

  if (state?.activeCursor) {
    rows.push({label: 'Active cursor', value: state.activeCursor})
  }

  return rows
}

export const TrackingOptionsField = (props: TrackingOptionsFieldProps) => {
  const fieldId = () => {
    return props.id ?? 'data-source-tracking-enabled'
  }
  const availability = () => {
    return getTrackingAvailability({dateFrom: props.dateFrom(), importRoute: props.importRoute()})
  }
  const isDisabled = () => {
    return Boolean(props.disabled?.()) || !availability().canEnable
  }
  const isScheduleMonthChecked = (month: number) => {
    return props.scheduleMonths().includes(month)
  }
  const updateScheduleMonth = (month: number, checked: boolean) => {
    const currentMonths = props.scheduleMonths()
    const nextMonths = checked
      ? [...currentMonths, month]
      : currentMonths.filter((currentMonth) => {
          return currentMonth !== month
        })

    props.onScheduleMonthsChange(
      nextMonths.sort((a, b) => {
        return a - b
      }),
    )
  }

  return (
    <section class="rounded-md border border-gray-200 bg-gray-50 p-4 space-y-3">
      <div class="flex items-start gap-3">
        <input
          id={fieldId()}
          type="checkbox"
          checked={props.trackingEnabled()}
          disabled={isDisabled()}
          onChange={(event) => {
            props.onTrackingEnabledChange(event.currentTarget.checked)
          }}
          class="mt-1 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
        />
        <div class="min-w-0 flex-1">
          <label for={fieldId()} class="block text-sm font-medium text-gray-900">
            Continuous tracking
          </label>
          <p class={`mt-1 text-sm ${availability().canEnable ? 'text-gray-500' : 'text-amber-700'}`}>
            {availability().helperText}
          </p>
        </div>
      </div>

      <Show when={props.trackingEnabled() && availability().canEnable}>
        <div class="border-t border-gray-200 pt-3">
          <p class="mb-2 text-sm font-medium text-gray-700">Reconciliation schedule</p>
          <div class="flex flex-wrap gap-2">
            <For each={[...defaultTrackingReconcileScheduleMonths]}>
              {(month) => {
                return (
                  <label class="inline-flex items-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={isScheduleMonthChecked(month)}
                      disabled={isScheduleMonthChecked(month) && props.scheduleMonths().length <= 1}
                      onChange={(event) => {
                        updateScheduleMonth(month, event.currentTarget.checked)
                      }}
                      class="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
                    />
                    <span>{month} months</span>
                  </label>
                )
              }}
            </For>
          </div>
        </div>
      </Show>
    </section>
  )
}

export const TrackingStatusPanel = (props: TrackingStatusPanelProps) => {
  const canRunFullReconciliation = () => {
    return props.trackingEnabled() && isTrackingSupportedImportRoute(props.importRoute())
  }
  const changesHref = () => {
    return `/admin/datasources/${props.dataSourceId()}/changes`
  }

  return (
    <section class="rounded-md border border-gray-200 bg-white p-4 space-y-4">
      <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 class="text-lg font-semibold text-gray-900">Tracking status</h2>
          <p class="mt-1 text-sm text-gray-500">Current source tracking state and reconciliation backlog.</p>
        </div>
        <div class="flex flex-wrap gap-2">
          <a
            href={changesHref()}
            class="px-3 py-1.5 rounded-md border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
          >
            View changes
          </a>
          <button
            type="button"
            disabled={!canRunFullReconciliation() || props.isRunningFullReconciliation()}
            onClick={() => {
              props.onRunFullReconciliation()
            }}
            class="px-3 py-1.5 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {props.isRunningFullReconciliation() ? 'Starting...' : 'Run full reconciliation'}
          </button>
        </div>
      </div>

      <dl class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <For
          each={getTrackingStatusRows({
            enabled: props.trackingEnabled(),
            scheduleMonths: props.scheduleMonths(),
            state: props.trackingState(),
          })}
        >
          {(row) => {
            return (
              <div class="rounded-md border border-gray-100 bg-gray-50 px-3 py-2">
                <dt class="text-xs font-medium uppercase text-gray-500">{row.label}</dt>
                <dd class="mt-1 break-words text-sm text-gray-900">{row.value}</dd>
              </div>
            )
          }}
        </For>
      </dl>

      <Show when={props.trackingState()?.lastError} fallback={<p class="text-sm text-gray-500">No tracking error.</p>}>
        {(lastError) => {
          return (
            <div class="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              <span class="font-medium">Last error:</span> {lastError()}
            </div>
          )
        }}
      </Show>
    </section>
  )
}
