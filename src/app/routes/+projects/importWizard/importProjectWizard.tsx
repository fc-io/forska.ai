import {createMutation, useQuery, useQueryClient} from '@tanstack/solid-query'
import {Link, useNavigate} from '@tanstack/solid-router'
import {createEffect, createMemo, createSignal, For, Match, Show, Switch} from 'solid-js'

import {Button} from '../../../../components/ui/button'
import {
  analyzeProjectImportSession,
  cancelProjectImportSession,
  commitProjectImportSession,
  createProjectImportSession,
  fetchProjectImportSession,
  type ProjectImportCompletion,
  type ProjectImportPackageWarning,
  type ProjectImportPlanArtifact,
  type ProjectImportPlanSummary,
  type ProjectImportProgress,
  type ProjectImportResolveDependenciesRequest,
  type ProjectImportSession,
  projectImportSessionQueryKey,
  type ProjectImportSessionState,
  resolveProjectImportDependencies,
  uploadProjectImportPackage,
} from './projectImportClient.ts'

type SummaryField = {key: string; label: string}
type WarningDetailRow = {label: string; value: string}
type GroupedWarning = {count: number; detailRows: WarningDetailRow[]; key: string; message: string}

const overlapSummaryFields: SummaryField[] = [
  {key: 'reusedArticleCount', label: 'Reused articles'},
  {key: 'newArticleCount', label: 'New articles'},
  {key: 'reusedArticleUpdateCount', label: 'Reused-article update plan'},
  {key: 'reusedArticleFieldFillCount', label: 'Reused-article field fills'},
  {key: 'reusedArticleAssetPromotionCount', label: 'Reused-article asset promotions'},
  {key: 'reusedJudgmentCount', label: 'Reused judgments'},
  {key: 'dirtiedExistingProjectCount', label: 'Projects dirtied by reused articles'},
  {key: 'omittedRouteLinkCount', label: 'Route-link omissions'},
  {key: 'omittedArticleRouteLinkCount', label: 'Article route-link omissions'},
  {key: 'routeArticleSnapshotLinkCount', label: 'Snapshot project-article links'},
  {key: 'duplicateImportMatchCount', label: 'Duplicate package matches'},
  {key: 'storedSignatureJudgmentCount', label: 'Stored judgment signature provenance'},
  {key: 'snapshotVerifiedJudgmentCount', label: 'Snapshot-verified judgment provenance'},
  {key: 'currentReviewRowsSignatureJudgmentCount', label: 'Current review-row judgment provenance'},
  {key: 'storedSignatureHumanReviewCount', label: 'Stored human/review signature provenance'},
  {key: 'currentReviewRowsSignatureHumanReviewCount', label: 'Current review-row human/review provenance'},
]

const conflictSummaryFields: SummaryField[] = [
  {key: 'packageContractConflictCount', label: 'Package-contract conflicts'},
  {key: 'articleConflictCount', label: 'Article conflicts'},
  {key: 'projectPromptConflictCount', label: 'Project prompt conflicts'},
  {key: 'judgmentConflictCount', label: 'Judgment conflicts'},
  {key: 'humanReviewFidelityConflictCount', label: 'Human/review fidelity conflicts'},
]

const activeSessionStates = new Set<ProjectImportSessionState>([
  'uploading',
  'queued',
  'extracting',
  'analyzing',
  'committing',
])
const terminalSessionStates = new Set<ProjectImportSessionState>(['cancelled', 'completed', 'expired', 'failed'])

const getInitialSessionId = () => {
  if (typeof window === 'undefined') {
    return null
  }

  const value = new URLSearchParams(window.location.search).get('sessionId')?.trim() ?? ''

  return value.length > 0 ? value : null
}

const setSessionSearchParam = (sessionId: string | null) => {
  if (typeof window === 'undefined') {
    return
  }

  const url = new URL(window.location.href)

  if (sessionId === null) {
    url.searchParams.delete('sessionId')
  } else {
    url.searchParams.set('sessionId', sessionId)
  }

  window.history.replaceState(null, '', url.pathname + url.search)
}

const getSessionUpdatedAtTime = (session: ProjectImportSession) => {
  const time = new Date(session.updatedAt).getTime()

  return Number.isNaN(time) ? 0 : time
}

const shouldReplaceSessionOverride = ({
  current,
  next,
}: {
  current: ProjectImportSession | null
  next: ProjectImportSession
}) => {
  return current === null || current.id !== next.id || getSessionUpdatedAtTime(next) >= getSessionUpdatedAtTime(current)
}

const formatCount = (value: number | null | undefined) => {
  return Number.isFinite(value) ? Number(value).toLocaleString() : '0'
}

const formatBytes = (value: number | null | undefined) => {
  const bytes = value ?? 0
  const units = ['B', 'KB', 'MB', 'GB']
  const unitIndex = bytes >= 1024 * 1024 * 1024 ? 3 : bytes >= 1024 * 1024 ? 2 : bytes >= 1024 ? 1 : 0
  const divisor = unitIndex === 0 ? 1 : 1024 ** unitIndex

  return `${(bytes / divisor).toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

const formatLabel = (value: string) => {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_:-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const getStatusClasses = (status: string | null | undefined) => {
  return status === 'resolved' || status === 'not_required' || status === 'clear'
    ? 'border-green-200 bg-green-50 text-green-700'
    : status === 'blocked' || status === 'missing' || status === 'failed'
      ? 'border-red-200 bg-red-50 text-red-700'
      : 'border-amber-200 bg-amber-50 text-amber-700'
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const getStringField = (value: unknown, field: string) => {
  return isRecord(value) && typeof value[field] === 'string' ? value[field] : null
}

const getBooleanField = (value: unknown, field: string) => {
  return isRecord(value) && typeof value[field] === 'boolean' ? value[field] : false
}

const getPlanArray = (plan: ProjectImportPlanArtifact | null, key: keyof ProjectImportPlanArtifact['targetPlan']) => {
  const value = plan?.targetPlan[key]

  return Array.isArray(value) ? value : []
}

const getJsonPreview = (value: unknown) => {
  return JSON.stringify(value, null, 2)
}

const getOmittedRoutes = (plan: ProjectImportPlanArtifact | null) => {
  return getPlanArray(plan, 'projectRoutePlan').filter((entry) => {
    return getStringField(entry, 'action') === 'omit'
  })
}

const getOmittedArticleRoutes = (plan: ProjectImportPlanArtifact | null) => {
  return getPlanArray(plan, 'articleRoutePlan').filter((entry) => {
    return getStringField(entry, 'action') === 'omit'
  })
}

const getSnapshotArticleRoutes = (plan: ProjectImportPlanArtifact | null) => {
  return getPlanArray(plan, 'articleRoutePlan').filter((entry) => {
    return getBooleanField(entry, 'snapshotProjectArticleLink')
  })
}

const getProvenanceCounts = (entries: unknown[]) => {
  return entries.reduce<Record<string, number>>((counts, entry) => {
    const kind = getStringField(entry, 'provenanceKind') ?? 'not recorded'

    return {...counts, [kind]: (counts[kind] ?? 0) + 1}
  }, {})
}

const getDuplicateWarnings = (session: ProjectImportSession | null) => {
  const warnings = session?.planSummary?.packageWarnings ?? []

  return warnings.filter((warning) => {
    return `${warning.code ?? ''} ${warning.message}`.toLowerCase().includes('duplicate')
  })
}

const getPostImportWarnings = (completion: ProjectImportCompletion | null): ProjectImportPackageWarning[] => {
  return completion?.importWarnings ?? []
}

const warningDetailFields: Array<{key: string; label: string}> = [
  {key: 'sourceRowId', label: 'Source row'},
  {key: 'triggeringField', label: 'Field'},
  {key: 'field', label: 'Field'},
  {key: 'dependencyReason', label: 'Dependency reason'},
  {key: 'omittedParentRef', label: 'Omitted parent'},
  {key: 'reason', label: 'Reason'},
]

const getStableJsonValue = (value: unknown): unknown => {
  return Array.isArray(value)
    ? value.map(getStableJsonValue)
    : isRecord(value)
      ? Object.keys(value)
          .sort()
          .reduce<Record<string, unknown>>((stable, key) => {
            return {...stable, [key]: getStableJsonValue(value[key])}
          }, {})
      : value
}

const getWarningDetailRows = (warning: ProjectImportPackageWarning) => {
  const details = warning.details
  const detailRows = warningDetailFields.reduce<WarningDetailRow[]>((rows, field) => {
    const value = getStringField(details, field.key)
    const hasExistingLabel = rows.some((row) => {
      return row.label === field.label
    })

    return value === null || hasExistingLabel ? rows : [...rows, {label: field.label, value}]
  }, [])
  const sourceRef = typeof warning.scope === 'string' && warning.scope.trim().length > 0 ? warning.scope.trim() : null

  return sourceRef === null ? detailRows : [...detailRows, {label: 'Scope', value: sourceRef}]
}

const getWarningGroupingKey = (warning: ProjectImportPackageWarning) => {
  return JSON.stringify({
    action: warning.action ?? null,
    code: warning.code ?? null,
    details: getStableJsonValue(warning.details ?? null),
    message: warning.message.trim(),
    scope: warning.scope ?? null,
  })
}

const getGroupedWarningMessages = (warnings: ProjectImportPackageWarning[]) => {
  return warnings.reduce<GroupedWarning[]>((grouped, warning) => {
    const message = warning.message.trim()
    const key = getWarningGroupingKey(warning)
    const existing = grouped.find((entry) => {
      return entry.key === key
    })

    return existing === undefined
      ? [...grouped, {count: 1, detailRows: getWarningDetailRows(warning), key, message}]
      : grouped.map((entry) => {
          return entry.key === key ? {...entry, count: entry.count + 1} : entry
        })
  }, [])
}

const formatGroupedWarningMessage = (warning: GroupedWarning) => {
  return warning.count > 1 ? `${warning.message} (x${warning.count})` : warning.message
}

const WarningListItem = (props: {warning: GroupedWarning}) => {
  return (
    <li>
      <div>{formatGroupedWarningMessage(props.warning)}</div>
      <Show when={props.warning.detailRows.length > 0}>
        <dl class="mt-1 grid gap-x-3 gap-y-1 text-xs text-amber-950 sm:grid-cols-[max-content_1fr]">
          <For each={props.warning.detailRows}>
            {(row) => {
              return (
                <>
                  <dt class="font-medium">{row.label}</dt>
                  <dd class="break-all">{row.value}</dd>
                </>
              )
            }}
          </For>
        </dl>
      </Show>
    </li>
  )
}

const getCompletedProjectId = (completion: ProjectImportCompletion | null) => {
  return completion?.targetProjectId ?? completion?.projectId ?? null
}

const getProgressPercent = (session: ProjectImportSession | null, uploadPercent: number | null) => {
  const progressPercent = session?.progress?.percent

  return typeof progressPercent === 'number' ? Math.round(progressPercent) : uploadPercent
}

const hasUnresolvedDependencies = (session: ProjectImportSession | null) => {
  return Object.values(session?.planSummary?.dependencyStatuses ?? {}).some((status) => {
    return status !== 'resolved' && status !== 'not_required'
  })
}

const shouldPollSession = (session: ProjectImportSession | undefined) => {
  return session !== undefined && activeSessionStates.has(session.state)
}

const getSessionPhaseLabel = (session: ProjectImportSession | null) => {
  const phase = session?.progress?.phase ?? session?.state ?? 'not started'
  const status = session?.progress?.status ?? 'pending'
  const phaseLabel = formatLabel(phase)
  const statusLabel = formatLabel(status)

  return `${phaseLabel.charAt(0).toUpperCase()}${phaseLabel.slice(1)} (${statusLabel})`
}

const hasNumber = (value: number | null | undefined): value is number => {
  return typeof value === 'number' && Number.isFinite(value)
}

const getProgressByteValues = (progress: ProjectImportProgress | null | undefined) => {
  const processed = progress?.bytesProcessed ?? progress?.completedBytes ?? null
  const total = progress?.bytesTotal ?? progress?.totalBytes ?? null

  return hasNumber(processed) && hasNumber(total) ? {processed, total} : null
}

const getProgressRowValues = (progress: ProjectImportProgress | null | undefined) => {
  const processed = progress?.rowCountProcessed ?? progress?.completedRows ?? null
  const total = progress?.rowCountTotal ?? progress?.totalRows ?? null

  return hasNumber(processed) && hasNumber(total) ? {processed, total} : null
}

const getProgressDetailRows = (session: ProjectImportSession | null, uploadPercent: number | null) => {
  const progress = session?.progress
  const byteValues = getProgressByteValues(progress)
  const rowValues = getProgressRowValues(progress)
  const upload = session?.upload
  const uploadLabel =
    upload === null || upload === undefined
      ? uploadPercent === null
        ? 'Awaiting package'
        : `${formatCount(uploadPercent)}%`
      : `${upload.fileName} (${formatBytes(upload.byteLength)})`
  const baseRows = [
    {label: 'Upload', value: uploadLabel},
    {label: 'Plan revision', value: formatCount(session?.planRevision ?? 0)},
  ]
  const byteRow =
    byteValues === null
      ? []
      : [{label: 'Bytes', value: `${formatBytes(byteValues.processed)} of ${formatBytes(byteValues.total)}`}]
  const rowRow =
    rowValues === null
      ? []
      : [{label: 'Rows', value: `${formatCount(rowValues.processed)} of ${formatCount(rowValues.total)}`}]
  const warningRow = hasNumber(progress?.warningCount)
    ? [{label: 'Warnings', value: formatCount(progress?.warningCount)}]
    : []

  return [...baseRows, ...byteRow, ...rowRow, ...warningRow]
}

const getStalePlanReasonEntries = (session: ProjectImportSession | null) => {
  const reasons = session?.planSummary?.stalePlanReasons ?? session?.plan?.stalePlanReasons ?? {}

  return Object.entries(reasons).flatMap(([surface, entries]) => {
    return (entries ?? []).map((entry) => {
      const surfaces = entry.targetStateSurfaces.length > 0 ? entry.targetStateSurfaces.join(', ') : 'target state'

      return {reason: entry.reason, surface, surfaces}
    })
  })
}

const getCommitUnavailableReason = (session: ProjectImportSession | null) => {
  return session?.state === 'completed'
    ? 'Import completed.'
    : session?.state === 'committing'
      ? 'Commit is writing the imported project.'
      : session?.stalePlan
        ? 'Review the refreshed plan before committing.'
        : session?.canCommit
          ? 'Plan is ready to commit.'
          : 'Resolve blockers and dependencies before committing this plan.'
}

const SummaryTable = (props: {
  fields: readonly SummaryField[]
  title: string
  values: Record<string, number> | null | undefined
}) => {
  return (
    <section class="rounded-lg border border-gray-200 bg-white p-4">
      <h2 class="text-base font-semibold text-gray-900">{props.title}</h2>
      <div class="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        <For each={props.fields}>
          {(field) => {
            return (
              <div class="rounded-md border border-gray-200 bg-gray-50 px-3 py-2">
                <div class="text-xs font-medium text-gray-500">{field.label}</div>
                <div class="mt-1 text-lg font-semibold text-gray-900">{formatCount(props.values?.[field.key])}</div>
              </div>
            )
          }}
        </For>
      </div>
    </section>
  )
}

const StatusBadge = (props: {status: string}) => {
  return (
    <span class={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${getStatusClasses(props.status)}`}>
      {formatLabel(props.status)}
    </span>
  )
}

const ProgressPanel = (props: {session: ProjectImportSession | null; uploadPercent: number | null}) => {
  const percent = createMemo(() => {
    return getProgressPercent(props.session, props.uploadPercent)
  })
  const detailRows = createMemo(() => {
    return getProgressDetailRows(props.session, props.uploadPercent)
  })

  return (
    <section class="rounded-lg border border-gray-200 bg-white p-4">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="text-base font-semibold text-gray-900">Import progress</h2>
          <p class="mt-1 text-sm text-gray-500">{getSessionPhaseLabel(props.session)}</p>
        </div>
        <Show when={props.session}>
          {(session) => {
            return <StatusBadge status={session().state} />
          }}
        </Show>
      </div>
      <Show
        when={percent() !== null}
        fallback={<p class="mt-4 text-sm text-gray-500">No determinate percentage for this phase.</p>}
      >
        <div class="mt-4 space-y-2">
          <div class="h-2 overflow-hidden rounded-full bg-gray-100">
            <div
              class="h-full rounded-full bg-blue-600 transition-all"
              style={{width: `${Math.max(0, Math.min(100, percent() ?? 0))}%`}}
            />
          </div>
          <p class="text-xs text-gray-500">{formatCount(percent())}%</p>
        </div>
      </Show>
      <div class="mt-3 grid gap-3 text-sm text-gray-700 md:grid-cols-3">
        <For each={detailRows()}>
          {(row) => {
            return (
              <div>
                <span class="font-medium text-gray-900">{row.label}:</span> {row.value}
              </div>
            )
          }}
        </For>
      </div>
    </section>
  )
}

const PackageReviewPanel = (props: {session: ProjectImportSession | null}) => {
  const warnings = createMemo(() => {
    return props.session?.planSummary?.packageWarnings ?? []
  })
  const groupedWarnings = createMemo(() => {
    return getGroupedWarningMessages(warnings())
  })
  const duplicateWarnings = createMemo(() => {
    return getDuplicateWarnings(props.session)
  })
  const groupedDuplicateWarnings = createMemo(() => {
    return getGroupedWarningMessages(duplicateWarnings())
  })
  const counts = createMemo(() => {
    return Object.entries(props.session?.planSummary?.packageCounts ?? {})
  })

  return (
    <section class="rounded-lg border border-gray-200 bg-white p-4">
      <h2 class="text-base font-semibold text-gray-900">Package review</h2>
      <div class="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <For each={counts()}>
          {([key, value]) => {
            return (
              <div class="rounded-md border border-gray-200 bg-gray-50 px-3 py-2">
                <div class="text-xs font-medium text-gray-500">{formatLabel(key)}</div>
                <div class="mt-1 text-lg font-semibold text-gray-900">{formatCount(value)}</div>
              </div>
            )
          }}
        </For>
      </div>
      <Show when={counts().length === 0}>
        <p class="mt-3 text-sm text-gray-500">Upload and analyze a package to inspect its counts and warnings.</p>
      </Show>
      <div class="mt-4 grid gap-3 lg:grid-cols-2">
        <div class="rounded-md border border-amber-200 bg-amber-50 p-3">
          <div class="text-sm font-medium text-amber-900">Warnings</div>
          <Show when={groupedWarnings().length > 0} fallback={<p class="mt-2 text-sm text-amber-800">No warnings.</p>}>
            <ul class="mt-2 space-y-2 text-sm text-amber-900">
              <For each={groupedWarnings()}>
                {(warning) => {
                  return <WarningListItem warning={warning} />
                }}
              </For>
            </ul>
          </Show>
        </div>
        <div class="rounded-md border border-amber-200 bg-amber-50 p-3">
          <div class="text-sm font-medium text-amber-900">Duplicate warnings</div>
          <Show
            when={groupedDuplicateWarnings().length > 0}
            fallback={<p class="mt-2 text-sm text-amber-800">No duplicate package warnings.</p>}
          >
            <ul class="mt-2 space-y-2 text-sm text-amber-900">
              <For each={groupedDuplicateWarnings()}>
                {(warning) => {
                  return <WarningListItem warning={warning} />
                }}
              </For>
            </ul>
          </Show>
        </div>
      </div>
    </section>
  )
}

const StalePlanReasonsPanel = (props: {session: ProjectImportSession | null}) => {
  const entries = createMemo(() => {
    return getStalePlanReasonEntries(props.session)
  })

  return (
    <Show when={props.session?.stalePlan && entries().length > 0}>
      <section class="rounded-lg border border-amber-200 bg-amber-50 p-4">
        <h2 class="text-base font-semibold text-amber-950">Plan revalidation details</h2>
        <ul class="mt-3 space-y-2 text-sm text-amber-900">
          <For each={entries()}>
            {(entry) => {
              return (
                <li class="rounded-md border border-amber-200 bg-white/70 px-3 py-2">
                  <span class="font-medium">{formatLabel(entry.surface)}:</span> {formatLabel(entry.reason)}
                  <span class="block text-xs text-amber-800">Surfaces: {entry.surfaces}</span>
                </li>
              )
            }}
          </For>
        </ul>
      </section>
    </Show>
  )
}

const PostImportWarningsPanel = (props: {session: ProjectImportSession | null}) => {
  const warnings = createMemo(() => {
    return getPostImportWarnings(props.session?.completion ?? null)
  })
  const groupedWarnings = createMemo(() => {
    return getGroupedWarningMessages(warnings())
  })

  return (
    <Show when={props.session?.state === 'completed' && groupedWarnings().length > 0}>
      <section class="rounded-lg border border-amber-200 bg-amber-50 p-4">
        <h2 class="text-base font-semibold text-amber-950">Post-import warnings</h2>
        <ul class="mt-3 space-y-2 text-sm text-amber-900">
          <For each={groupedWarnings()}>
            {(warning) => {
              return <WarningListItem warning={warning} />
            }}
          </For>
        </ul>
      </section>
    </Show>
  )
}

const BlockersPanel = (props: {summary: ProjectImportPlanSummary | null}) => {
  const blockers = createMemo(() => {
    return props.summary?.blockers ?? []
  })

  return (
    <section class="rounded-lg border border-gray-200 bg-white p-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="text-base font-semibold text-gray-900">Blockers</h2>
        <span class="text-sm text-gray-500">{formatCount(props.summary?.blockerCount)} total</span>
      </div>
      <Show when={blockers().length > 0} fallback={<p class="mt-3 text-sm text-gray-500">No blockers in the plan.</p>}>
        <div class="mt-3 overflow-x-auto">
          <table class="min-w-full divide-y divide-gray-200 text-sm">
            <thead class="bg-gray-50 text-left text-xs font-medium uppercase text-gray-500">
              <tr>
                <th class="px-3 py-2">Code</th>
                <th class="px-3 py-2">Scope</th>
                <th class="px-3 py-2">Resolution kind</th>
                <th class="px-3 py-2">Message</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100">
              <For each={blockers()}>
                {(blocker) => {
                  return (
                    <tr>
                      <td class="px-3 py-2 font-mono text-xs text-gray-700">{blocker.code}</td>
                      <td class="px-3 py-2 font-mono text-xs text-gray-700">{blocker.scope}</td>
                      <td class="px-3 py-2">
                        <StatusBadge status={blocker.resolutionKind} />
                      </td>
                      <td class="px-3 py-2 text-gray-700">{blocker.message}</td>
                    </tr>
                  )
                }}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </section>
  )
}

const PlanDetailList = (props: {emptyLabel: string; entries: unknown[]; title: string}) => {
  return (
    <details class="rounded-lg border border-gray-200 bg-white p-4" open>
      <summary class="cursor-pointer text-base font-semibold text-gray-900">{props.title}</summary>
      <Show when={props.entries.length > 0} fallback={<p class="mt-3 text-sm text-gray-500">{props.emptyLabel}</p>}>
        <div class="mt-3 space-y-3">
          <For each={props.entries}>
            {(entry) => {
              return (
                <pre class="max-h-56 overflow-auto rounded-md border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700">
                  {getJsonPreview(entry)}
                </pre>
              )
            }}
          </For>
        </div>
      </Show>
    </details>
  )
}

const MappingPanel = (props: {mapping: Record<string, string> | null | undefined; title: string}) => {
  const entries = createMemo(() => {
    return Object.entries(props.mapping ?? {})
  })

  return (
    <section class="rounded-lg border border-gray-200 bg-white p-4">
      <h2 class="text-base font-semibold text-gray-900">{props.title}</h2>
      <Show when={entries().length > 0} fallback={<p class="mt-3 text-sm text-gray-500">No mappings recorded.</p>}>
        <div class="mt-3 overflow-x-auto">
          <table class="min-w-full divide-y divide-gray-200 text-sm">
            <thead class="bg-gray-50 text-left text-xs font-medium uppercase text-gray-500">
              <tr>
                <th class="px-3 py-2">Source</th>
                <th class="px-3 py-2">Target</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100">
              <For each={entries()}>
                {([sourceId, targetId]) => {
                  return (
                    <tr>
                      <td class="px-3 py-2 font-mono text-xs text-gray-700">{sourceId}</td>
                      <td class="px-3 py-2 font-mono text-xs text-gray-700">{targetId}</td>
                    </tr>
                  )
                }}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </section>
  )
}

const ProvenancePanel = (props: {description: string; entries: unknown[]; title: string}) => {
  const counts = createMemo(() => {
    return Object.entries(getProvenanceCounts(props.entries))
  })

  return (
    <section class="rounded-lg border border-gray-200 bg-white p-4">
      <h2 class="text-base font-semibold text-gray-900">{props.title}</h2>
      <p class="mt-1 text-sm text-gray-500">{props.description}</p>
      <Show when={counts().length > 0} fallback={<p class="mt-3 text-sm text-gray-500">No provenance rows.</p>}>
        <div class="mt-3 grid gap-2 sm:grid-cols-2">
          <For each={counts()}>
            {([kind, count]) => {
              return (
                <div class="rounded-md border border-gray-200 bg-gray-50 px-3 py-2">
                  <div class="text-xs font-medium text-gray-500">{formatLabel(kind)}</div>
                  <div class="mt-1 text-lg font-semibold text-gray-900">{formatCount(count)}</div>
                </div>
              )
            }}
          </For>
        </div>
      </Show>
    </section>
  )
}

const DependencyStatusTable = (props: {session: ProjectImportSession | null}) => {
  const entries = createMemo(() => {
    return Object.entries(props.session?.planSummary?.dependencyStatuses ?? {})
  })

  return (
    <section class="rounded-lg border border-gray-200 bg-white p-4">
      <h2 class="text-base font-semibold text-gray-900">Dependency status</h2>
      <Show when={entries().length > 0} fallback={<p class="mt-3 text-sm text-gray-500">No dependencies listed.</p>}>
        <div class="mt-3 overflow-x-auto">
          <table class="min-w-full divide-y divide-gray-200 text-sm">
            <thead class="bg-gray-50 text-left text-xs font-medium uppercase text-gray-500">
              <tr>
                <th class="px-3 py-2">Dependency</th>
                <th class="px-3 py-2">Source id</th>
                <th class="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100">
              <For each={entries()}>
                {([key, status]) => {
                  const [kind, ...sourceParts] = key.split(':')

                  return (
                    <tr>
                      <td class="px-3 py-2 text-gray-700">{formatLabel(kind ?? 'dependency')}</td>
                      <td class="px-3 py-2 font-mono text-xs text-gray-700">{sourceParts.join(':')}</td>
                      <td class="px-3 py-2">
                        <StatusBadge status={status} />
                      </td>
                    </tr>
                  )
                }}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </section>
  )
}

export const ImportProjectWizard = () => {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [sessionId, setSessionId] = createSignal<string | null>(getInitialSessionId())
  const [sessionOverride, setSessionOverride] = createSignal<ProjectImportSession | null>(null)
  const [navigatedProjectId, setNavigatedProjectId] = createSignal<string | null>(null)
  const [autoResolvedRevisionKey, setAutoResolvedRevisionKey] = createSignal<string | null>(null)
  const [selectedFile, setSelectedFile] = createSignal<File | null>(null)
  const [uploadPercent, setUploadPercent] = createSignal<number | null>(null)
  const [pageError, setPageError] = createSignal('')
  const [pageMessage, setPageMessage] = createSignal('')

  const sessionQuery = useQuery(() => {
    const id = sessionId()

    return {
      enabled: id !== null,
      queryFn: () => {
        return fetchProjectImportSession(id ?? '')
      },
      queryKey: projectImportSessionQueryKey(id),
      refetchInterval: (query: {state: {data?: ProjectImportSession}}) => {
        return shouldPollSession(query.state.data) ? 1_500 : false
      },
      suspense: false,
    }
  })
  const currentSession = createMemo(() => {
    const override = sessionOverride()
    const id = sessionId()

    return id === null ? null : override?.id === id ? override : (sessionQuery.data ?? null)
  })
  const planSummary = createMemo(() => {
    return currentSession()?.planSummary ?? null
  })
  const plan = createMemo(() => {
    return currentSession()?.plan ?? null
  })
  const setActiveSession = (session: ProjectImportSession) => {
    setSessionId(session.id)
    setSessionSearchParam(session.id)
    queryClient.setQueryData(projectImportSessionQueryKey(session.id), session)
    setSessionOverride(session)
  }
  const setResolveResult = (session: ProjectImportSession) => {
    setActiveSession(session)
    setPageMessage(session.stalePlan ? 'Plan revision was stale; refreshed latest plan.' : 'Dependency plan updated.')
  }
  const navigateToCompletedProject = (session: ProjectImportSession) => {
    const projectId = getCompletedProjectId(session.completion)

    if (projectId !== null && navigatedProjectId() !== projectId) {
      setNavigatedProjectId(projectId)
      void navigate({params: {id: projectId} as never, to: '/projects/$id'})
    }
  }
  const setCommitResult = (session: ProjectImportSession) => {
    setActiveSession(session)

    if (session.stalePlan) {
      setPageMessage('Plan revision was stale; review the refreshed plan before committing.')
      return
    }

    if (session.state === 'committing') {
      setPageMessage('Commit started. Progress will update here.')
      return
    }

    if (session.state === 'completed') {
      const warningCount = getPostImportWarnings(session.completion).length

      setPageMessage(
        warningCount > 0
          ? `Import committed with ${formatCount(warningCount)} post-import warning(s).`
          : 'Import committed.',
      )
      navigateToCompletedProject(session)
    }
  }
  const getCurrentSessionOrError = () => {
    const session = currentSession()

    if (session === null) {
      setPageError('Create or load an import session first.')
    }

    return session
  }
  const resolveWithCurrentRevision = (request: Omit<ProjectImportResolveDependenciesRequest, 'planRevision'>) => {
    const session = getCurrentSessionOrError()

    if (session !== null) {
      setPageError('')
      resolveMutation.mutate({...request, planRevision: session.planRevision, sessionId: session.id})
    }
  }

  const createSessionMutation = createMutation(() => {
    return {mutationFn: createProjectImportSession, onSuccess: setActiveSession}
  })
  const uploadMutation = createMutation(() => {
    return {
      mutationFn: (input: {file: File; sessionId: string}) => {
        return uploadProjectImportPackage({file: input.file, onProgress: setUploadPercent, sessionId: input.sessionId})
      },
      onSuccess: setActiveSession,
    }
  })
  const analyzeMutation = createMutation(() => {
    return {mutationFn: analyzeProjectImportSession, onSuccess: setActiveSession}
  })
  const resolveMutation = createMutation(() => {
    return {
      mutationFn: resolveProjectImportDependencies,
      onError: (error: unknown) => {
        setPageError(error instanceof Error ? error.message : 'Failed to resolve dependencies')
      },
      onSuccess: setResolveResult,
    }
  })
  const commitMutation = createMutation(() => {
    return {
      mutationFn: commitProjectImportSession,
      onError: (error: unknown) => {
        setPageError(error instanceof Error ? error.message : 'Failed to commit import')
      },
      onSuccess: setCommitResult,
    }
  })
  const cancelMutation = createMutation(() => {
    return {
      mutationFn: cancelProjectImportSession,
      onError: (error: unknown) => {
        setPageError(error instanceof Error ? error.message : 'Failed to cancel import')
      },
      onSuccess: (session: ProjectImportSession) => {
        setActiveSession(session)
        setPageMessage('Import session cancelled.')
      },
    }
  })
  const isBusy = createMemo(() => {
    return (
      createSessionMutation.isPending
      || uploadMutation.isPending
      || analyzeMutation.isPending
      || resolveMutation.isPending
      || commitMutation.isPending
      || cancelMutation.isPending
    )
  })
  const startDisabled = createMemo(() => {
    return selectedFile() === null || isBusy()
  })
  const canAnalyze = createMemo(() => {
    return currentSession()?.state === 'queued' && !isBusy()
  })
  const canCancel = createMemo(() => {
    const state = currentSession()?.state

    return (
      state !== undefined && !terminalSessionStates.has(state) && state !== 'committing' && !cancelMutation.isPending
    )
  })
  const canCommit = createMemo(() => {
    const session = currentSession()

    return (
      session?.canCommit === true
      && session.state === 'ready_to_commit'
      && session.stalePlan !== true
      && !commitMutation.isPending
    )
  })
  const shouldShowDependencyResolution = createMemo(() => {
    const session = currentSession()

    return session !== null && hasUnresolvedDependencies(session)
  })
  const commitmentState = createMemo(() => {
    const session = currentSession()

    return session?.state === 'completed'
      ? 'Completed'
      : session?.state === 'committing'
        ? 'Committing'
        : session?.canCommit
          ? 'Plan ready'
          : 'Not ready'
  })

  createEffect(() => {
    const session = sessionQuery.data

    if (
      session
      && session.id === sessionId()
      && shouldReplaceSessionOverride({current: sessionOverride(), next: session})
    ) {
      setSessionOverride(session)
    }
  })

  createEffect(() => {
    const session = currentSession()

    if (session?.state === 'completed') {
      navigateToCompletedProject(session)
    }
  })

  createEffect(() => {
    const session = currentSession()
    const revisionKey = session ? `${session.id}:${session.planRevision}` : null

    if (
      session === null
      || session.state !== 'awaiting_resolution'
      || !hasUnresolvedDependencies(session)
      || resolveMutation.isPending
      || autoResolvedRevisionKey() === revisionKey
    ) {
      return
    }

    setAutoResolvedRevisionKey(revisionKey)
    setPageError('')
    resolveMutation.mutate({autoResolve: true, planRevision: session.planRevision, sessionId: session.id})
  })

  const handleFileChange = (event: Event) => {
    const file = event.currentTarget instanceof HTMLInputElement ? (event.currentTarget.files?.[0] ?? null) : null

    setSelectedFile(file)
    setUploadPercent(null)
    setPageError('')
    setPageMessage('')
  }
  const handleStartImport = () => {
    const file = selectedFile()

    if (file === null) {
      setPageError('Choose a project transfer package first.')
      return
    }

    setPageError('')
    setPageMessage('')
    setUploadPercent(0)
    void createSessionMutation
      .mutateAsync()
      .then((session) => {
        return uploadMutation.mutateAsync({file, sessionId: session.id})
      })
      .then((session) => {
        return analyzeMutation.mutateAsync({expectedPlanRevision: session.planRevision, sessionId: session.id})
      })
      .catch((error) => {
        setPageError(error instanceof Error ? error.message : 'Failed to import package')
      })
  }
  const handleAnalyze = () => {
    const session = getCurrentSessionOrError()

    if (session !== null) {
      setPageError('')
      analyzeMutation.mutate({expectedPlanRevision: session.planRevision, sessionId: session.id})
    }
  }
  const handleCancel = () => {
    const session = getCurrentSessionOrError()

    if (session !== null) {
      setPageError('')
      cancelMutation.mutate(session.id)
    }
  }
  const handleAutoResolve = () => {
    resolveWithCurrentRevision({autoResolve: true})
  }
  const handleCommit = () => {
    const session = getCurrentSessionOrError()

    if (session !== null) {
      setPageError('')
      setPageMessage('')
      commitMutation.mutate({planRevision: session.planRevision, sessionId: session.id})
    }
  }
  const judgmentPlan = createMemo(() => {
    return getPlanArray(plan(), 'judgmentPlan')
  })
  const humanReviewPlan = createMemo(() => {
    return getPlanArray(plan(), 'humanReviewPlan')
  })

  return (
    <main class="min-h-screen bg-gray-50 p-6">
      <div class="mx-auto max-w-7xl space-y-6">
        <header class="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 class="text-2xl font-bold text-gray-900">Import Project</h1>
            <p class="mt-1 text-sm text-gray-600">
              Upload a transfer package, resolve target dependencies, review the plan, and commit the imported project.
            </p>
          </div>
          <Button as={Link} to="/projects" variant="outline">
            Back to Projects
          </Button>
        </header>

        <Show when={pageError()}>
          <div class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
            {pageError()}
          </div>
        </Show>
        <Show when={pageMessage()}>
          <div class="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700">
            {pageMessage()}
          </div>
        </Show>
        <Show when={currentSession()?.stalePlan}>
          <div class="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Plan revision changed. Review the refreshed plan before applying more changes.
          </div>
        </Show>

        <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <div class="space-y-6">
            <section class="rounded-lg border border-gray-200 bg-white p-4">
              <div class="flex flex-wrap items-end gap-4">
                <label class="min-w-72 flex-1 text-sm font-medium text-gray-700">
                  <span>Project transfer package</span>
                  <input
                    accept=".zip,application/zip"
                    class="mt-2 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-blue-50 file:px-3 file:py-2 file:text-blue-700"
                    onChange={handleFileChange}
                    type="file"
                  />
                </label>
                <Button disabled={startDisabled()} onClick={handleStartImport} type="button">
                  <Switch>
                    <Match when={createSessionMutation.isPending}>Creating session...</Match>
                    <Match when={uploadMutation.isPending}>Uploading...</Match>
                    <Match when={analyzeMutation.isPending}>Analyzing...</Match>
                    <Match when={true}>Start import review</Match>
                  </Switch>
                </Button>
                <Button disabled={!canAnalyze()} onClick={handleAnalyze} type="button" variant="outline">
                  Analyze queued upload
                </Button>
                <Button disabled={!canCancel()} onClick={handleCancel} type="button" variant="outline">
                  Cancel
                </Button>
              </div>
              <Show when={selectedFile()}>
                {(file) => {
                  return (
                    <p class="mt-3 text-sm text-gray-500">
                      Selected: {file().name} ({formatBytes(file().size)})
                    </p>
                  )
                }}
              </Show>
            </section>

            <ProgressPanel session={currentSession()} uploadPercent={uploadPercent()} />
            <PackageReviewPanel session={currentSession()} />
            <StalePlanReasonsPanel session={currentSession()} />
            <PostImportWarningsPanel session={currentSession()} />
            <SummaryTable fields={overlapSummaryFields} title="Overlap summary" values={planSummary()?.overlapCounts} />
            <SummaryTable
              fields={conflictSummaryFields}
              title="Conflict summary"
              values={planSummary()?.conflictCounts}
            />
            <DependencyStatusTable session={currentSession()} />
            <BlockersPanel summary={planSummary()} />

            <Show when={shouldShowDependencyResolution()}>
              <section class="rounded-lg border border-gray-200 bg-white p-4">
                <div class="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 class="text-base font-semibold text-gray-900">Dependency resolution</h2>
                    <p class="mt-1 text-sm text-gray-500">
                      Existing connections stay unchanged. New connections and model rows are created explicitly.
                    </p>
                  </div>
                  <Button
                    disabled={!currentSession() || resolveMutation.isPending}
                    onClick={handleAutoResolve}
                    type="button"
                  >
                    Auto-resolve
                  </Button>
                </div>

                <p class="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">
                  Provider and model dependencies resolve to imported source snapshots. Exact prior imported snapshots
                  are reused by fingerprint; otherwise the import creates disabled snapshot rows during commit.
                </p>
              </section>
            </Show>

            <section class="rounded-lg border border-gray-200 bg-white p-4">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 class="text-base font-semibold text-gray-900">Project</h2>
                  <p class="mt-1 text-sm text-gray-500">{getCommitUnavailableReason(currentSession())}</p>
                </div>
                <div class="flex items-center gap-3">
                  <StatusBadge status={commitmentState()} />
                  <Button disabled={!canCommit()} onClick={handleCommit} type="button">
                    <Switch>
                      <Match when={commitMutation.isPending}>Committing...</Match>
                      <Match when={currentSession()?.state === 'committing'}>Commit running</Match>
                      <Match when={currentSession()?.state === 'completed'}>Committed</Match>
                      <Match when={true}>Create project from import</Match>
                    </Switch>
                  </Button>
                </div>
              </div>
            </section>

            <details class="rounded-lg border border-gray-200 bg-white p-4">
              <summary class="cursor-pointer text-base font-semibold text-gray-900">Debug</summary>
              <div class="mt-4 space-y-4">
                <div class="grid gap-4 lg:grid-cols-2">
                  <MappingPanel
                    mapping={plan()?.dependencyResolution?.providerTargetBySourceId}
                    title="Final provider mappings"
                  />
                  <MappingPanel
                    mapping={plan()?.dependencyResolution?.modelTargetBySourceId}
                    title="Final model mappings"
                  />
                </div>
                <div class="grid gap-4 lg:grid-cols-2">
                  <ProvenancePanel
                    description="Shows where the judgment comparison signature came from when import checks whether an existing target judgment already matches."
                    entries={judgmentPlan()}
                    title="Judgment comparison signature source"
                  />
                  <ProvenancePanel
                    description="Shows where the human/review comparison signature came from when import checks whether existing human judgment or review state already matches."
                    entries={humanReviewPlan()}
                    title="Human/review comparison signature source"
                  />
                </div>
                <PlanDetailList
                  emptyLabel="No reused-article updates are planned."
                  entries={getPlanArray(plan(), 'articleUpdatePlan')}
                  title="Reused-article update plan"
                />
                <PlanDetailList
                  emptyLabel="No omitted project route links."
                  entries={getOmittedRoutes(plan())}
                  title="Route-link omissions"
                />
                <PlanDetailList
                  emptyLabel="No omitted article route links."
                  entries={getOmittedArticleRoutes(plan())}
                  title="Article route-link omissions"
                />
                <PlanDetailList
                  emptyLabel="No snapshot project-article links."
                  entries={getSnapshotArticleRoutes(plan())}
                  title="Snapshot project-article links"
                />
                <PlanDetailList
                  emptyLabel="No judgment plan rows."
                  entries={judgmentPlan()}
                  title="Judgment plan rows"
                />
                <PlanDetailList
                  emptyLabel="No human/review plan rows."
                  entries={humanReviewPlan()}
                  title="Human/review plan rows"
                />
              </div>
            </details>
          </div>

          <aside class="space-y-4">
            <section class="rounded-lg border border-gray-200 bg-white p-4">
              <h2 class="text-base font-semibold text-gray-900">Session</h2>
              <dl class="mt-3 space-y-2 text-sm">
                <div>
                  <dt class="text-gray-500">Session id</dt>
                  <dd class="break-all font-mono text-xs text-gray-900">{currentSession()?.id ?? 'Not created'}</dd>
                </div>
                <div>
                  <dt class="text-gray-500">State</dt>
                  <dd class="text-gray-900">{currentSession()?.state ?? 'Not started'}</dd>
                </div>
                <div>
                  <dt class="text-gray-500">Revision</dt>
                  <dd class="text-gray-900">{currentSession()?.planRevision ?? 0}</dd>
                </div>
                <div>
                  <dt class="text-gray-500">Package fingerprint</dt>
                  <dd class="break-all font-mono text-xs text-gray-900">
                    {currentSession()?.packageFingerprint ?? planSummary()?.packageFingerprint ?? 'Unavailable'}
                  </dd>
                </div>
                <div>
                  <dt class="text-gray-500">Can commit</dt>
                  <dd class="text-gray-900">{currentSession()?.canCommit ? 'Yes' : 'No'}</dd>
                </div>
              </dl>
            </section>
            <section class="rounded-lg border border-gray-200 bg-white p-4">
              <h2 class="text-base font-semibold text-gray-900">Read paths</h2>
              <div class="mt-3 space-y-2 text-sm text-gray-600">
                <p>Normal session reads and dependency mutations use Eden and TanStack Query.</p>
                <p>Package upload uses the desktop-safe API origin resolved by getApiRequestUrl.</p>
              </div>
            </section>
          </aside>
        </div>
      </div>
    </main>
  )
}
