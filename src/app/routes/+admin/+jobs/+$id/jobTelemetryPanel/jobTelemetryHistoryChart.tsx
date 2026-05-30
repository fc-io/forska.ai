import {useQuery} from '@tanstack/solid-query'
import {createMemo, createSignal, For, type JSX, Match, Show, Switch} from 'solid-js'

import {
  fetchJudgmentJobProviderTelemetryHistory,
  type JudgmentJobProviderTelemetryHistory,
  type JudgmentJobProviderTelemetryHistoryBucket,
  type JudgmentJobProviderTelemetryHistoryQuery,
  type JudgmentJobProviderTelemetryHistoryRange,
} from '../../../../../../services/judgmentsJobsService'
import {
  formatTelemetryCount,
  formatTelemetryEnumValue,
  formatTelemetryRatio,
  formatTelemetryUtilization,
  getActionErrorMessage,
  getProviderTelemetryAdherenceStateLabel,
  getProviderTelemetryBottleneckSummaryLabel,
  getProviderTelemetryHistoryHasSamples,
  getProviderTelemetryHistoryRangeLabel,
  getProviderTelemetryHistoryUtilizationScaleMax,
  judgmentProviderTelemetryHistoryRanges,
} from '../../jobsPageShared'

type JobTelemetryHistoryChartProps = {jobId: string; providerKey?: string | null}
type TelemetryHistoryChartProps = {
  buckets: JudgmentJobProviderTelemetryHistoryBucket[]
  range: JudgmentJobProviderTelemetryHistoryRange
}
type TelemetryHistoryChartPoint = {
  avgY: number | null
  bucket: JudgmentJobProviderTelemetryHistoryBucket
  maxY: number | null
  minY: number | null
  x: number
}
type TelemetryHistoryTooltip = {bucket: JudgmentJobProviderTelemetryHistoryBucket; label: string; x: number; y: number}
type TelemetryHistoryBucketSummaryProps = {
  bucket: JudgmentJobProviderTelemetryHistoryBucket
  label: string
  range: JudgmentJobProviderTelemetryHistoryRange
}
type TelemetryHistoryDataPanelProps = {
  history: JudgmentJobProviderTelemetryHistory
  range: JudgmentJobProviderTelemetryHistoryRange
}
type TelemetryHistoryEmptyProps = {
  history: JudgmentJobProviderTelemetryHistory
  range: JudgmentJobProviderTelemetryHistoryRange
}
type TelemetryHistoryMetricProps = {label: string; value: string}
type TelemetryHistoryTooltipPanelProps = {tooltip: TelemetryHistoryTooltip}
type TelemetryHistoryTooltipRowProps = {label: string; value: string; valueClass?: string}

const chartDimensions = {bottom: 178, height: 210, left: 44, right: 16, top: 18, width: 920}

const shortTimeFormatter = new Intl.DateTimeFormat('en-US', {hour: '2-digit', minute: '2-digit', second: '2-digit'})
const dateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  month: 'short',
})

const getTrimmedProviderKey = (value: string | null | undefined) => {
  const trimmed = value?.trim() ?? ''

  return trimmed.length > 0 ? trimmed : null
}

const getTelemetryHistoryQueryInput = (params: {
  jobId: string
  providerKey?: string | null
  range: JudgmentJobProviderTelemetryHistoryRange
}): JudgmentJobProviderTelemetryHistoryQuery => {
  const providerKey = getTrimmedProviderKey(params.providerKey)

  return providerKey
    ? {jobId: params.jobId, providerKey, range: params.range}
    : {jobId: params.jobId, range: params.range}
}

const getRangeButtonClass = (active: boolean) => {
  return active
    ? 'border-blue-600 bg-blue-600 text-white shadow-sm'
    : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
}

const getAdherenceSvgColor = (adherenceState: JudgmentJobProviderTelemetryHistoryBucket['adherenceState']): string => {
  switch (adherenceState) {
    case 'atLimit':
      return 'rgb(217, 119, 6)'
    case 'overLimit':
      return 'rgb(225, 29, 72)'
    case 'withinLimit':
      return 'rgb(22, 163, 74)'
    default:
      return 'rgb(107, 114, 128)'
  }
}

const getAdherenceBadgeClass = (
  adherenceState: JudgmentJobProviderTelemetryHistoryBucket['adherenceState'],
): string => {
  switch (adherenceState) {
    case 'atLimit':
      return 'border-amber-200 bg-amber-50 text-amber-800'
    case 'overLimit':
      return 'border-rose-200 bg-rose-50 text-rose-800'
    case 'withinLimit':
      return 'border-green-200 bg-green-50 text-green-800'
    default:
      return 'border-gray-200 bg-gray-50 text-gray-700'
  }
}

const isWideRange = (range: JudgmentJobProviderTelemetryHistoryRange): boolean => {
  return range === '24h' || range === '3d'
}

const getBucketRangeLabel = (
  bucket: JudgmentJobProviderTelemetryHistoryBucket,
  range: JudgmentJobProviderTelemetryHistoryRange,
): string => {
  const formatter = isWideRange(range) ? dateTimeFormatter : shortTimeFormatter

  return `${formatter.format(new Date(bucket.bucketStart))} - ${formatter.format(new Date(bucket.bucketEnd))}`
}

const formatTelemetryBucketCount = (value: number | null | undefined): string => {
  return value === null || value === undefined ? 'N/A' : formatTelemetryCount(value)
}

const formatTelemetryBucketRatio = (value: number | null | undefined, target: number | null | undefined): string => {
  return value === null || value === undefined || target === null || target === undefined
    ? 'N/A'
    : formatTelemetryRatio(value, target)
}

const getPlotHeight = () => {
  return chartDimensions.bottom - chartDimensions.top
}

const getPlotWidth = () => {
  return chartDimensions.width - chartDimensions.left - chartDimensions.right
}

const getChartX = (index: number, count: number) => {
  const plotWidth = getPlotWidth()

  return count <= 1 ? chartDimensions.left + plotWidth / 2 : chartDimensions.left + (plotWidth * index) / (count - 1)
}

const getChartY = (value: number | null, scaleMax: number): number | null => {
  const normalizedValue = Number(value)
  const clampedValue = Math.max(0, Math.min(normalizedValue, scaleMax))

  return value === null || !Number.isFinite(normalizedValue)
    ? null
    : chartDimensions.bottom - (clampedValue / scaleMax) * getPlotHeight()
}

const getChartPoint = (
  bucket: JudgmentJobProviderTelemetryHistoryBucket,
  index: number,
  count: number,
  scaleMax: number,
): TelemetryHistoryChartPoint => {
  return {
    avgY: getChartY(bucket.avgUtilization, scaleMax),
    bucket,
    maxY: getChartY(bucket.maxUtilization, scaleMax),
    minY: getChartY(bucket.minUtilization, scaleMax),
    x: getChartX(index, count),
  }
}

const getChartPoints = (
  buckets: JudgmentJobProviderTelemetryHistoryBucket[],
  scaleMax: number,
): TelemetryHistoryChartPoint[] => {
  return buckets.map((bucket, index) => {
    return getChartPoint(bucket, index, buckets.length, scaleMax)
  })
}

const getChartPointHitbox = (params: {count: number; point: TelemetryHistoryChartPoint}) => {
  const plotWidth = getPlotWidth()
  const rawWidth = params.count <= 1 ? plotWidth : Math.max(18, plotWidth / (params.count - 1))
  const leftBound = chartDimensions.left
  const rightBound = chartDimensions.width - chartDimensions.right
  const x = Math.max(leftBound, params.point.x - rawWidth / 2)

  return {width: Math.min(rawWidth, rightBound - x), x}
}

const getTelemetryHistoryTooltipPosition = (params: {container: HTMLDivElement | undefined; event: PointerEvent}) => {
  const containerRect = params.container?.getBoundingClientRect()

  return containerRect
    ? {
        x: Math.min(Math.max(params.event.clientX - containerRect.left, 128), containerRect.width - 128),
        y: Math.max(params.event.clientY - containerRect.top, 24),
      }
    : null
}

const getAveragePolylinePointSegments = (points: TelemetryHistoryChartPoint[]): string[] => {
  const reduced = points.reduce<{current: string[]; segments: string[]}>(
    (state, point) => {
      if (point.avgY === null) {
        return state.current.length === 0
          ? state
          : {current: [], segments: [...state.segments, state.current.join(' ')]}
      }

      return {...state, current: [...state.current, `${point.x},${point.avgY}`]}
    },
    {current: [], segments: []},
  )

  return reduced.current.length === 0 ? reduced.segments : [...reduced.segments, reduced.current.join(' ')]
}

const getLatestSampledTelemetryBucket = (
  buckets: JudgmentJobProviderTelemetryHistoryBucket[],
): JudgmentJobProviderTelemetryHistoryBucket | null => {
  return buckets.reduce<JudgmentJobProviderTelemetryHistoryBucket | null>((latestBucket, bucket) => {
    return bucket.sampleCount > 0 ? bucket : latestBucket
  }, null)
}

const TelemetryHistoryMetric = (props: TelemetryHistoryMetricProps): JSX.Element => {
  return (
    <div class="min-w-0 rounded-md border border-gray-200 bg-gray-50 px-3 py-2">
      <p class="break-words text-xs font-medium uppercase text-gray-500">{props.label}</p>
      <p class="mt-1 break-words text-sm font-semibold text-gray-900">{props.value}</p>
    </div>
  )
}

const TelemetryHistoryTooltipRow = (props: TelemetryHistoryTooltipRowProps): JSX.Element => {
  return (
    <div class="flex items-start justify-between gap-5">
      <span class="shrink-0 text-gray-300">{props.label}</span>
      <span class={`min-w-0 break-words text-right font-medium tabular-nums text-white ${props.valueClass ?? ''}`}>
        {props.value}
      </span>
    </div>
  )
}

const TelemetryHistoryTooltipPanel = (props: TelemetryHistoryTooltipPanelProps): JSX.Element => {
  return (
    <div
      class="pointer-events-none absolute z-20 min-w-64 max-w-80 rounded-md bg-gray-950/90 px-3 py-2 text-xs text-white shadow-xl ring-1 ring-black/10 backdrop-blur-sm"
      style={{
        left: `${props.tooltip.x}px`,
        top: `${props.tooltip.y}px`,
        transform: 'translate(-50%, calc(-100% - 12px))',
      }}
    >
      <div class="mb-2 font-semibold leading-tight text-white">{props.tooltip.label}</div>
      <div class="space-y-1 text-gray-100">
        <TelemetryHistoryTooltipRow
          label="Average"
          value={formatTelemetryUtilization(props.tooltip.bucket.avgUtilization)}
        />
        <TelemetryHistoryTooltipRow
          label="Minimum"
          value={formatTelemetryUtilization(props.tooltip.bucket.minUtilization)}
        />
        <TelemetryHistoryTooltipRow
          label="Maximum"
          value={formatTelemetryUtilization(props.tooltip.bucket.maxUtilization)}
        />
      </div>
      <div class="mt-2 space-y-1 border-t border-white/20 pt-2 text-gray-100">
        <TelemetryHistoryTooltipRow
          label="Latest Requests"
          value={formatTelemetryBucketRatio(
            props.tooltip.bucket.latestProviderLeasedLiveRequests,
            props.tooltip.bucket.latestNormalRequestCapacity,
          )}
        />
        <TelemetryHistoryTooltipRow
          label="Provider Limit"
          value={formatTelemetryBucketCount(props.tooltip.bucket.latestProviderLimit)}
        />
        <TelemetryHistoryTooltipRow
          label="Physical Calls"
          value={formatTelemetryBucketRatio(
            props.tooltip.bucket.latestProviderLeasedPhysicalCalls,
            props.tooltip.bucket.latestProviderLimit,
          )}
        />
        <TelemetryHistoryTooltipRow label="Samples" value={formatTelemetryCount(props.tooltip.bucket.sampleCount)} />
        <TelemetryHistoryTooltipRow
          label="Adherence"
          value={getProviderTelemetryAdherenceStateLabel(props.tooltip.bucket.adherenceState)}
        />
        <TelemetryHistoryTooltipRow
          label="Bottleneck"
          value={getProviderTelemetryBottleneckSummaryLabel(props.tooltip.bucket)}
        />
        <Show when={props.tooltip.bucket.bottleneckSource}>
          {(source) => {
            return <TelemetryHistoryTooltipRow label="Source" value={source()} valueClass="break-all" />
          }}
        </Show>
        <Show when={props.tooltip.bucket.bottleneckSubreason}>
          {(subreason) => {
            return <TelemetryHistoryTooltipRow label="Subreason" value={formatTelemetryEnumValue(subreason())} />
          }}
        </Show>
      </div>
    </div>
  )
}

const TelemetryHistoryBucketSummary = (props: TelemetryHistoryBucketSummaryProps): JSX.Element => {
  return (
    <div class="min-w-0 rounded-md border border-gray-200 bg-white px-3 py-3">
      <div class="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div class="min-w-0">
          <p class="break-words text-xs font-medium uppercase text-gray-500">{props.label}</p>
          <p class="mt-1 break-words text-sm font-semibold text-gray-900">
            {getBucketRangeLabel(props.bucket, props.range)}
          </p>
        </div>
        <span
          class={`max-w-full self-start rounded-full border px-3 py-1 text-xs font-medium ${getAdherenceBadgeClass(
            props.bucket.adherenceState,
          )}`}
        >
          {getProviderTelemetryAdherenceStateLabel(props.bucket.adherenceState)}
        </span>
      </div>
      <div class="mt-3 grid min-w-0 gap-2 sm:grid-cols-3">
        <TelemetryHistoryMetric label="Average" value={formatTelemetryUtilization(props.bucket.avgUtilization)} />
        <TelemetryHistoryMetric label="Minimum" value={formatTelemetryUtilization(props.bucket.minUtilization)} />
        <TelemetryHistoryMetric label="Maximum" value={formatTelemetryUtilization(props.bucket.maxUtilization)} />
      </div>
      <div class="mt-3 grid min-w-0 gap-2 sm:grid-cols-3">
        <TelemetryHistoryMetric
          label="Latest Requests"
          value={formatTelemetryBucketRatio(
            props.bucket.latestProviderLeasedLiveRequests,
            props.bucket.latestNormalRequestCapacity,
          )}
        />
        <TelemetryHistoryMetric
          label="Provider Limit"
          value={formatTelemetryBucketCount(props.bucket.latestProviderLimit)}
        />
        <TelemetryHistoryMetric
          label="Physical Calls"
          value={formatTelemetryBucketRatio(
            props.bucket.latestProviderLeasedPhysicalCalls,
            props.bucket.latestProviderLimit,
          )}
        />
      </div>
      <div class="mt-3 min-w-0 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs leading-5 text-gray-600">
        <p class="break-words">
          <span class="font-medium text-gray-800">Bottleneck:</span>{' '}
          {getProviderTelemetryBottleneckSummaryLabel(props.bucket)}
        </p>
        <Show when={props.bucket.bottleneckSource}>
          {(source) => {
            return (
              <p class="mt-1 break-all">
                <span class="font-medium text-gray-800">Source:</span> {source()}
              </p>
            )
          }}
        </Show>
        <Show when={props.bucket.bottleneckSubreason}>
          {(subreason) => {
            return (
              <p class="mt-1 break-words">
                <span class="font-medium text-gray-800">Subreason:</span> {formatTelemetryEnumValue(subreason())}
              </p>
            )
          }}
        </Show>
      </div>
    </div>
  )
}

const TelemetryHistoryChart = (props: TelemetryHistoryChartProps): JSX.Element => {
  const [tooltip, setTooltip] = createSignal<TelemetryHistoryTooltip | null>(null)
  let chartContainer: HTMLDivElement | undefined
  const scaleMax = createMemo(() => {
    return getProviderTelemetryHistoryUtilizationScaleMax(props.buckets)
  })
  const chartPoints = createMemo(() => {
    return getChartPoints(props.buckets, scaleMax())
  })
  const averagePolylinePointSegments = createMemo(() => {
    return getAveragePolylinePointSegments(chartPoints())
  })

  const showPointTooltip = (point: TelemetryHistoryChartPoint, event: PointerEvent) => {
    const position = getTelemetryHistoryTooltipPosition({container: chartContainer, event})

    if (!position) {
      return
    }

    setTooltip({
      bucket: point.bucket,
      label: getBucketRangeLabel(point.bucket, props.range),
      x: position.x,
      y: position.y,
    })
  }

  return (
    <div
      ref={(element) => {
        chartContainer = element
      }}
      class="relative min-w-0 rounded-md border border-gray-200 bg-white"
    >
      <div class="grid grid-cols-[auto_1fr] gap-2 px-3 pt-3 text-xs text-gray-500">
        <span class="text-right">{formatTelemetryUtilization(scaleMax())}</span>
        <span class="border-t border-gray-200 pt-1">Scale maximum</span>
        <span class="text-right">100%</span>
        <span class="border-t border-dashed border-gray-200 pt-1">Provider limit reference</span>
      </div>
      <svg
        aria-label="Provider utilization history chart"
        class="block h-56 w-full max-w-full"
        onPointerLeave={() => {
          setTooltip(null)
        }}
        role="img"
        viewBox={`0 0 ${chartDimensions.width} ${chartDimensions.height}`}
      >
        <line
          shape-rendering="crispEdges"
          stroke="rgb(229, 231, 235)"
          vector-effect="non-scaling-stroke"
          x1={chartDimensions.left}
          x2={chartDimensions.width - chartDimensions.right}
          y1={chartDimensions.top}
          y2={chartDimensions.top}
        />
        <line
          shape-rendering="crispEdges"
          stroke="rgb(229, 231, 235)"
          vector-effect="non-scaling-stroke"
          x1={chartDimensions.left}
          x2={chartDimensions.width - chartDimensions.right}
          y1={chartDimensions.bottom}
          y2={chartDimensions.bottom}
        />
        <line
          shape-rendering="crispEdges"
          stroke="rgb(191, 219, 254)"
          stroke-dasharray="6 6"
          vector-effect="non-scaling-stroke"
          x1={chartDimensions.left}
          x2={chartDimensions.width - chartDimensions.right}
          y1={getChartY(100, scaleMax()) ?? chartDimensions.top}
          y2={getChartY(100, scaleMax()) ?? chartDimensions.top}
        />
        <For each={averagePolylinePointSegments()}>
          {(points) => {
            return (
              <polyline
                fill="none"
                points={points}
                stroke="rgb(37, 99, 235)"
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                vector-effect="non-scaling-stroke"
              />
            )
          }}
        </For>
        <For each={chartPoints()}>
          {(point) => {
            const hitbox = getChartPointHitbox({count: chartPoints().length, point})

            return (
              <g
                onPointerMove={(event) => {
                  return showPointTooltip(point, event)
                }}
              >
                <rect
                  fill="transparent"
                  height={getPlotHeight()}
                  pointer-events="all"
                  width={hitbox.width}
                  x={hitbox.x}
                  y={chartDimensions.top}
                />
                <Show when={point.minY !== null && point.maxY !== null}>
                  <line
                    stroke={getAdherenceSvgColor(point.bucket.adherenceState)}
                    stroke-linecap="round"
                    stroke-width="5"
                    vector-effect="non-scaling-stroke"
                    x1={point.x}
                    x2={point.x}
                    y1={point.maxY ?? chartDimensions.bottom}
                    y2={point.minY ?? chartDimensions.bottom}
                  />
                </Show>
                <Show when={point.avgY !== null}>
                  <circle
                    cx={point.x}
                    cy={point.avgY ?? chartDimensions.bottom}
                    fill="white"
                    r="4"
                    stroke={getAdherenceSvgColor(point.bucket.adherenceState)}
                    stroke-width="2"
                    vector-effect="non-scaling-stroke"
                  />
                </Show>
                <Show when={point.bucket.sampleCount > 0 && point.avgY === null}>
                  <rect
                    fill={getAdherenceSvgColor(point.bucket.adherenceState)}
                    height="7"
                    width="7"
                    x={point.x - 3.5}
                    y={chartDimensions.bottom - 3.5}
                  />
                </Show>
              </g>
            )
          }}
        </For>
      </svg>
      <Show when={tooltip()}>
        {(currentTooltip) => {
          return <TelemetryHistoryTooltipPanel tooltip={currentTooltip()} />
        }}
      </Show>
      <div class="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 border-t border-gray-200 px-3 py-2 text-xs text-gray-600">
        <span class="inline-flex items-center gap-1">
          <span class="h-2.5 w-5 rounded-full bg-blue-600" /> Average
        </span>
        <span class="inline-flex items-center gap-1">
          <span class="h-3 w-1 rounded-full bg-green-600" /> Min / max range
        </span>
        <span class="inline-flex items-center gap-1">
          <span class="h-3 w-3 rounded-full border-2 border-rose-600 bg-white" /> Limit adherence by color
        </span>
      </div>
    </div>
  )
}

const TelemetryHistoryDataPanel = (props: TelemetryHistoryDataPanelProps): JSX.Element => {
  const latestBucket = createMemo(() => {
    return getLatestSampledTelemetryBucket(props.history.buckets)
  })

  return (
    <div class="mt-4 min-w-0 space-y-4">
      <TelemetryHistoryChart buckets={props.history.buckets} range={props.range} />
      <Show when={latestBucket()}>
        {(bucket) => {
          return <TelemetryHistoryBucketSummary bucket={bucket()} label="Latest Sampled Bucket" range={props.range} />
        }}
      </Show>
    </div>
  )
}

const TelemetryHistoryEmpty = (props: TelemetryHistoryEmptyProps): JSX.Element => {
  return (
    <div class="mt-4 rounded-md border border-dashed border-gray-300 bg-gray-50 px-4 py-8 text-center text-sm text-gray-600">
      <p class="font-medium text-gray-900">
        No telemetry history samples for {getProviderTelemetryHistoryRangeLabel(props.range)}
      </p>
      <p class="mt-1 break-words">
        {formatTelemetryCount(props.history.buckets.length)} aligned buckets are available for this range, but none
        contain persisted samples yet.
      </p>
    </div>
  )
}

export const JobTelemetryHistoryChart = (props: JobTelemetryHistoryChartProps): JSX.Element => {
  const [selectedRange, setSelectedRange] = createSignal<JudgmentJobProviderTelemetryHistoryRange>('15m')
  const historyQuery = useQuery(() => {
    return {
      enabled: props.jobId.trim().length > 0,
      queryFn: () => {
        return fetchJudgmentJobProviderTelemetryHistory(
          getTelemetryHistoryQueryInput({jobId: props.jobId, providerKey: props.providerKey, range: selectedRange()}),
        )
      },
      queryKey: [
        'judgment-job-provider-telemetry-history',
        props.jobId,
        getTrimmedProviderKey(props.providerKey) ?? 'current-provider',
        selectedRange(),
      ],
      refetchInterval: 30_000,
      refetchOnWindowFocus: true,
      suspense: false,
    }
  })

  return (
    <section
      class="mb-6 min-w-0 rounded-lg border border-gray-200 bg-white p-4 shadow-sm sm:p-5"
      data-testid="provider-telemetry-history-chart"
    >
      <div class="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div class="min-w-0">
          <h2 class="text-lg font-semibold text-gray-900">Provider Utilization History</h2>
          <p class="mt-1 break-words text-sm text-gray-500">
            Average, minimum, and maximum request utilization from persisted provider telemetry buckets.
          </p>
          <Show when={historyQuery.data?.providerKey ?? getTrimmedProviderKey(props.providerKey)}>
            {(providerKey) => {
              return <p class="mt-1 break-all text-xs text-gray-500">Provider key: {providerKey()}</p>
            }}
          </Show>
        </div>
        <div class="flex max-w-full flex-wrap gap-1 rounded-md border border-gray-200 bg-gray-50 p-1">
          <For each={judgmentProviderTelemetryHistoryRanges}>
            {(range) => {
              return (
                <button
                  aria-pressed={selectedRange() === range}
                  class={`rounded px-3 py-1.5 text-xs font-medium transition ${getRangeButtonClass(
                    selectedRange() === range,
                  )}`}
                  onClick={() => {
                    return setSelectedRange(range)
                  }}
                  title={getProviderTelemetryHistoryRangeLabel(range)}
                  type="button"
                >
                  {range}
                </button>
              )
            }}
          </For>
        </div>
      </div>

      <div class="mt-3 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
        <span>{getProviderTelemetryHistoryRangeLabel(selectedRange())}</span>
        <Show when={historyQuery.data}>
          {(history) => {
            return (
              <>
                <span>{formatTelemetryCount(history().buckets.length)} buckets</span>
                <span>Bucket size {formatTelemetryCount(history().bucketSizeSeconds)}s</span>
              </>
            )
          }}
        </Show>
        <Show when={historyQuery.isFetching && !historyQuery.isLoading}>
          <span>Refreshing</span>
        </Show>
      </div>

      <Switch>
        <Match when={historyQuery.isLoading}>
          <div class="mt-4 rounded-md border border-gray-200 bg-gray-50 px-4 py-8 text-center text-sm text-gray-600">
            Loading telemetry history...
          </div>
        </Match>
        <Match when={historyQuery.isError}>
          <div class="mt-4 rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
            {getActionErrorMessage(historyQuery.error, 'Failed to load telemetry history')}
          </div>
        </Match>
        <Match when={historyQuery.data}>
          {(history) => {
            return (
              <Show
                fallback={<TelemetryHistoryEmpty history={history()} range={selectedRange()} />}
                when={getProviderTelemetryHistoryHasSamples(history().buckets)}
              >
                <TelemetryHistoryDataPanel history={history()} range={selectedRange()} />
              </Show>
            )
          }}
        </Match>
      </Switch>
    </section>
  )
}
