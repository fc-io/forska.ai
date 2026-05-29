import {createMutation, useQuery, useQueryClient} from '@tanstack/solid-query'
import {Link, useNavigate} from '@tanstack/solid-router'
import {createEffect, createMemo, createSignal, For, Match, Show, Switch} from 'solid-js'

import {Button} from '../../../../components/ui/button'
import {getProviderModelThinkingOption, type ProviderModelOptions} from '../../../../utils/providerModelOptions.ts'
import {
  addManualProviderModel,
  beginProviderAuthLifecycle,
  createProviderConnection,
  fetchCodexStatus,
  fetchProviderConnectionDiscoveredModels,
  fetchProviderConnections,
  finishProviderAuthLifecycle,
  type ProviderCatalogEntry,
  type ProviderConnection,
  type ProviderListedModel,
  type ProviderModel,
  startCodexLogin,
  syncProviderConnectionModels,
  testProviderConnectionApi,
} from '../../+admin/+models/providerConnectionsClient.ts'
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
  type ProjectImportResolveDependenciesRequest,
  type ProjectImportSession,
  projectImportSessionQueryKey,
  type ProjectImportSessionState,
  resolveProjectImportDependencies,
  uploadProjectImportPackage,
} from './projectImportClient.ts'

type SummaryField = {key: string; label: string}
type ConnectionDraft = {apiKey: string; baseURL: string; label: string; providerKind: string}
type ModelMaterializationDraft = {
  displayName: string
  remoteModelId: string
  sourceModelId: string
  targetProviderConnectionId: string
  variant: string
}
type AuthDraft = {connectionId: string; providerKind: string; secretValue: string}

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

const getDependencySourceIds = (summary: ProjectImportPlanSummary | null, prefix: 'model:' | 'provider:') => {
  return Object.keys(summary?.dependencyStatuses ?? {})
    .filter((key) => {
      return key.startsWith(prefix)
    })
    .map((key) => {
      return key.slice(prefix.length)
    })
}

const getDependencyStatus = (
  summary: ProjectImportPlanSummary | null,
  prefix: 'model:' | 'provider:',
  sourceId: string,
) => {
  return summary?.dependencyStatuses[`${prefix}${sourceId}`] ?? 'missing'
}

const getEnabledConnections = (connections: readonly ProviderConnection[]) => {
  return connections.filter((connection) => {
    return connection.enabled && (connection.config as {archived?: boolean}).archived !== true
  })
}

const getProviderModels = (connections: readonly ProviderConnection[]) => {
  return connections.flatMap((connection) => {
    return connection.models
      .filter((model) => {
        return model.enabled && model.providerConnectionId === connection.id
      })
      .map((model) => {
        return {...model, connectionLabel: connection.label}
      })
  })
}

const getProviderLabel = (catalog: readonly ProviderCatalogEntry[], kind: string) => {
  return (
    catalog.find((entry) => {
      return entry.kind === kind
    })?.label ?? formatLabel(kind)
  )
}

const getSafePrefill = (value: string) => {
  const normalized = value
    .replace(/[^A-Za-z0-9 _.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return normalized.length > 0 ? normalized.slice(0, 80) : 'Imported provider'
}

const getFirstProviderKind = (catalog: readonly ProviderCatalogEntry[]) => {
  return catalog[0]?.kind ?? 'openai-compatible'
}

const getExistingSelectionOrFirst = (selectedId: string, availableIds: readonly string[]) => {
  return selectedId && availableIds.includes(selectedId) ? selectedId : (availableIds[0] ?? '')
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

const getCompletedProjectId = (completion: ProjectImportCompletion | null) => {
  return completion?.targetProjectId ?? completion?.projectId ?? null
}

const getProgressPercent = (session: ProjectImportSession | null, uploadPercent: number | null) => {
  const progressPercent = session?.progress?.percent

  return typeof progressPercent === 'number' ? Math.round(progressPercent) : uploadPercent
}

const shouldPollSession = (session: ProjectImportSession | undefined) => {
  return session !== undefined && activeSessionStates.has(session.state)
}

const getSessionPhaseLabel = (session: ProjectImportSession | null) => {
  const phase = session?.progress?.phase ?? session?.state ?? 'not started'
  const status = session?.progress?.status ?? 'pending'

  return `${formatLabel(phase)} (${formatLabel(status)})`
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

const getCreateConnectionInput = (draft: ConnectionDraft) => {
  return {
    apiKey: draft.apiKey.trim() || undefined,
    baseURL: draft.baseURL.trim() || undefined,
    label: draft.label.trim() || undefined,
    providerKind: draft.providerKind,
  }
}

const getMaterializationModelOptions = (variant: string): ProviderModelOptions | undefined => {
  const thinking = getProviderModelThinkingOption(variant)

  return thinking ? {thinking} : undefined
}

const getProviderConnectionForId = (connections: readonly ProviderConnection[], connectionId: string) => {
  return (
    connections.find((connection) => {
      return connection.id === connectionId
    }) ?? null
  )
}

const getModelForId = (models: Array<ProviderModel & {connectionLabel: string}>, modelId: string) => {
  return (
    models.find((model) => {
      return model.id === modelId
    }) ?? null
  )
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
      <div class="mt-4 h-2 overflow-hidden rounded-full bg-gray-100">
        <div
          class="h-full rounded-full bg-blue-600 transition-all"
          style={{width: `${Math.max(0, Math.min(100, percent() ?? 0))}%`}}
        />
      </div>
      <div class="mt-3 grid gap-3 text-sm text-gray-700 md:grid-cols-3">
        <div>
          <span class="font-medium text-gray-900">Upload:</span>{' '}
          <Show when={props.session?.upload} fallback="Awaiting package">
            {(upload) => {
              return `${upload().fileName} (${formatBytes(upload().byteLength)})`
            }}
          </Show>
        </div>
        <div>
          <span class="font-medium text-gray-900">Extract/analyze:</span>{' '}
          <Show when={props.session?.progress} fallback="Not started">
            {(progress) => {
              return progress().phase === 'extract' || progress().phase === 'analyze'
                ? formatLabel(progress().status)
                : 'Waiting'
            }}
          </Show>
        </div>
        <div>
          <span class="font-medium text-gray-900">Plan revision:</span> {props.session?.planRevision ?? 0}
        </div>
      </div>
    </section>
  )
}

const PackageReviewPanel = (props: {session: ProjectImportSession | null}) => {
  const warnings = createMemo(() => {
    return props.session?.planSummary?.packageWarnings ?? []
  })
  const duplicateWarnings = createMemo(() => {
    return getDuplicateWarnings(props.session)
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
          <Show when={warnings().length > 0} fallback={<p class="mt-2 text-sm text-amber-800">No warnings.</p>}>
            <ul class="mt-2 space-y-2 text-sm text-amber-900">
              <For each={warnings()}>
                {(warning) => {
                  return <li>{warning.message}</li>
                }}
              </For>
            </ul>
          </Show>
        </div>
        <div class="rounded-md border border-amber-200 bg-amber-50 p-3">
          <div class="text-sm font-medium text-amber-900">Duplicate warnings</div>
          <Show
            when={duplicateWarnings().length > 0}
            fallback={<p class="mt-2 text-sm text-amber-800">No duplicate package warnings.</p>}
          >
            <ul class="mt-2 space-y-2 text-sm text-amber-900">
              <For each={duplicateWarnings()}>
                {(warning) => {
                  return <li>{warning.message}</li>
                }}
              </For>
            </ul>
          </Show>
        </div>
      </div>
    </section>
  )
}

const PostImportWarningsPanel = (props: {session: ProjectImportSession | null}) => {
  const warnings = createMemo(() => {
    return getPostImportWarnings(props.session?.completion ?? null)
  })

  return (
    <Show when={props.session?.state === 'completed' && warnings().length > 0}>
      <section class="rounded-lg border border-amber-200 bg-amber-50 p-4">
        <h2 class="text-base font-semibold text-amber-950">Post-import warnings</h2>
        <ul class="mt-3 space-y-2 text-sm text-amber-900">
          <For each={warnings()}>
            {(warning) => {
              return <li>{warning.message}</li>
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

const ProvenancePanel = (props: {entries: unknown[]; title: string}) => {
  const counts = createMemo(() => {
    return Object.entries(getProvenanceCounts(props.entries))
  })

  return (
    <section class="rounded-lg border border-gray-200 bg-white p-4">
      <h2 class="text-base font-semibold text-gray-900">{props.title}</h2>
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
  const [selectedFile, setSelectedFile] = createSignal<File | null>(null)
  const [uploadPercent, setUploadPercent] = createSignal<number | null>(null)
  const [pageError, setPageError] = createSignal('')
  const [pageMessage, setPageMessage] = createSignal('')
  const [selectedProviderSourceId, setSelectedProviderSourceId] = createSignal('')
  const [selectedTargetProviderConnectionId, setSelectedTargetProviderConnectionId] = createSignal('')
  const [selectedModelSourceId, setSelectedModelSourceId] = createSignal('')
  const [selectedTargetModelId, setSelectedTargetModelId] = createSignal('')
  const [acceptSubstituteModel, setAcceptSubstituteModel] = createSignal(false)
  const [connectionDraft, setConnectionDraft] = createSignal<ConnectionDraft>({
    apiKey: '',
    baseURL: '',
    label: '',
    providerKind: 'openai-compatible',
  })
  const [materializationDraft, setMaterializationDraft] = createSignal<ModelMaterializationDraft>({
    displayName: '',
    remoteModelId: '',
    sourceModelId: '',
    targetProviderConnectionId: '',
    variant: '',
  })
  const [authDraft, setAuthDraft] = createSignal<AuthDraft>({connectionId: '', providerKind: '', secretValue: ''})
  const [authMessage, setAuthMessage] = createSignal('')
  const [discoveredModels, setDiscoveredModels] = createSignal<ProviderListedModel[]>([])

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
  const providerConnectionsQuery = useQuery(() => {
    return {
      queryFn: fetchProviderConnections,
      queryKey: ['provider-connections', 'project-import'],
      staleTime: 60_000,
      suspense: false,
    }
  })
  const codexStatusQuery = useQuery(() => {
    return {
      queryFn: fetchCodexStatus,
      queryKey: ['codex-status', 'project-import'],
      refetchInterval: false,
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
  const connections = createMemo(() => {
    return providerConnectionsQuery.data?.connections ?? []
  })
  const catalog = createMemo(() => {
    return providerConnectionsQuery.data?.catalog ?? []
  })
  const enabledConnections = createMemo(() => {
    return getEnabledConnections(connections())
  })
  const selectableModels = createMemo(() => {
    return getProviderModels(enabledConnections())
  })
  const providerSourceIds = createMemo(() => {
    return getDependencySourceIds(planSummary(), 'provider:')
  })
  const modelSourceIds = createMemo(() => {
    return getDependencySourceIds(planSummary(), 'model:')
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
  const createConnectionMutation = createMutation(() => {
    return {
      mutationFn: createProviderConnection,
      onError: (error: unknown) => {
        setPageError(error instanceof Error ? error.message : 'Failed to create provider connection')
      },
      onSuccess: (connection: ProviderConnection) => {
        const sourceProviderConnectionId = selectedProviderSourceId()

        setSelectedTargetProviderConnectionId(connection.id)
        setAuthDraft({connectionId: connection.id, providerKind: connection.providerKind, secretValue: ''})
        void providerConnectionsQuery.refetch()

        if (sourceProviderConnectionId) {
          resolveWithCurrentRevision({
            createdProviderConnections: [
              {
                setupState: connection.hasSecret ? 'connection_test_pending' : 'auth_pending',
                sourceProviderConnectionId,
                targetProviderConnectionId: connection.id,
              },
            ],
          })
        }
      },
    }
  })
  const testConnectionMutation = createMutation(() => {
    return {
      mutationFn: testProviderConnectionApi,
      onError: (error: unknown) => {
        setPageError(error instanceof Error ? error.message : 'Failed to test provider connection')
      },
      onSuccess: (result: {message: string}) => {
        setPageMessage(result.message)
      },
    }
  })
  const discoverModelsMutation = createMutation(() => {
    return {
      mutationFn: fetchProviderConnectionDiscoveredModels,
      onError: (error: unknown) => {
        setPageError(error instanceof Error ? error.message : 'Failed to discover provider models')
      },
      onSuccess: setDiscoveredModels,
    }
  })
  const syncModelsMutation = createMutation(() => {
    return {
      mutationFn: syncProviderConnectionModels,
      onError: (error: unknown) => {
        setPageError(error instanceof Error ? error.message : 'Failed to sync provider models')
      },
      onSuccess: (result: {count: number}) => {
        setPageMessage(`Synced ${result.count} models`)
        void providerConnectionsQuery.refetch()
      },
    }
  })
  const beginAuthMutation = createMutation(() => {
    return {
      mutationFn: beginProviderAuthLifecycle,
      onError: (error: unknown) => {
        setPageError(error instanceof Error ? error.message : 'Failed to begin provider auth')
      },
      onSuccess: (result: {message: string; status: string}) => {
        setAuthMessage(`${result.status}: ${result.message}`)
      },
    }
  })
  const finishAuthMutation = createMutation(() => {
    return {
      mutationFn: finishProviderAuthLifecycle,
      onError: (error: unknown) => {
        setPageError(error instanceof Error ? error.message : 'Failed to finish provider auth')
      },
      onSuccess: (result: {message: string; status: string}) => {
        setAuthMessage(`${result.status}: ${result.message}`)
        void providerConnectionsQuery.refetch()
      },
    }
  })
  const codexLoginMutation = createMutation(() => {
    return {
      mutationFn: startCodexLogin,
      onError: (error: unknown) => {
        setPageError(error instanceof Error ? error.message : 'Failed to start Codex login')
      },
      onSuccess: (result: {message: string}) => {
        setPageMessage(result.message)
        void codexStatusQuery.refetch()
      },
    }
  })
  const materializeModelMutation = createMutation(() => {
    return {
      mutationFn: async (draft: ModelMaterializationDraft) => {
        const options = getMaterializationModelOptions(draft.variant)
        const result = await addManualProviderModel({
          displayName: draft.displayName.trim() || undefined,
          id: draft.targetProviderConnectionId,
          options,
          remoteModelId: draft.remoteModelId.trim(),
          variant: draft.variant.trim() || undefined,
        })

        return {draft, modelId: result.modelId}
      },
      onError: (error: unknown) => {
        setPageError(error instanceof Error ? error.message : 'Failed to materialize model')
      },
      onSuccess: ({draft, modelId}: {draft: ModelMaterializationDraft; modelId: string}) => {
        const options = getMaterializationModelOptions(draft.variant)

        void providerConnectionsQuery.refetch()
        resolveWithCurrentRevision({
          materializedModels: [
            {
              sourceModelId: draft.sourceModelId,
              targetModelId: modelId,
              targetProviderConnectionId: draft.targetProviderConnectionId,
            },
          ],
          modelMaterializationRequests: [
            {
              displayName: draft.displayName.trim() || undefined,
              options,
              remoteModelId: draft.remoteModelId.trim(),
              sourceModelId: draft.sourceModelId,
              targetProviderConnectionId: draft.targetProviderConnectionId,
              variant: draft.variant.trim() || undefined,
            },
          ],
        })
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
    const providerSources = providerSourceIds()
    const modelSources = modelSourceIds()
    const enabledConnectionIds = enabledConnections().map((connection) => {
      return connection.id
    })
    const selectableModelIds = selectableModels().map((model) => {
      return model.id
    })
    const nextProviderSourceId = getExistingSelectionOrFirst(selectedProviderSourceId(), providerSources)
    const nextModelSourceId = getExistingSelectionOrFirst(selectedModelSourceId(), modelSources)
    const nextConnectionId = getExistingSelectionOrFirst(selectedTargetProviderConnectionId(), enabledConnectionIds)
    const nextModelId = getExistingSelectionOrFirst(selectedTargetModelId(), selectableModelIds)
    const nextProviderKind = connectionDraft().providerKind || getFirstProviderKind(catalog())
    const currentConnectionDraft = connectionDraft()
    const currentMaterializationDraft = materializationDraft()

    setSelectedProviderSourceId(nextProviderSourceId)
    setSelectedModelSourceId(nextModelSourceId)
    setSelectedTargetProviderConnectionId(nextConnectionId)
    setSelectedTargetModelId(nextModelId)
    const nextConnectionLabel =
      currentConnectionDraft.label || (nextProviderSourceId ? `Imported ${getSafePrefill(nextProviderSourceId)}` : '')

    if (
      currentConnectionDraft.label !== nextConnectionLabel
      || currentConnectionDraft.providerKind !== nextProviderKind
    ) {
      setConnectionDraft({...currentConnectionDraft, label: nextConnectionLabel, providerKind: nextProviderKind})
    }

    const nextMaterializationDraft = {
      ...currentMaterializationDraft,
      sourceModelId: getExistingSelectionOrFirst(currentMaterializationDraft.sourceModelId, modelSources),
      targetProviderConnectionId: getExistingSelectionOrFirst(
        currentMaterializationDraft.targetProviderConnectionId,
        enabledConnectionIds,
      ),
    }

    if (
      currentMaterializationDraft.sourceModelId !== nextMaterializationDraft.sourceModelId
      || currentMaterializationDraft.targetProviderConnectionId !== nextMaterializationDraft.targetProviderConnectionId
    ) {
      setMaterializationDraft(nextMaterializationDraft)
    }
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
  const handleUseSelectedProvider = () => {
    const sourceProviderConnectionId = selectedProviderSourceId()
    const targetProviderConnectionId = selectedTargetProviderConnectionId()

    if (!sourceProviderConnectionId || !targetProviderConnectionId) {
      setPageError('Select a source provider and target connection first.')
      return
    }

    resolveWithCurrentRevision({
      selectedProviderConnections: [{sourceProviderConnectionId, targetProviderConnectionId}],
    })
  }
  const handleUseSelectedModel = () => {
    const sourceModelId = selectedModelSourceId()
    const targetModelId = selectedTargetModelId()

    if (!sourceModelId || !targetModelId) {
      setPageError('Select a source model and target model first.')
      return
    }

    resolveWithCurrentRevision({
      selectedModels: [{acceptSubstitute: acceptSubstituteModel(), sourceModelId, targetModelId}],
    })
  }
  const handleCreateConnection = () => {
    const draft = connectionDraft()

    if (!draft.providerKind) {
      setPageError('Select a provider kind before creating a connection.')
      return
    }

    setPageError('')
    createConnectionMutation.mutate(getCreateConnectionInput(draft))
  }
  const selectedAuthConnectionId = createMemo(() => {
    return authDraft().connectionId || selectedTargetProviderConnectionId()
  })
  const selectedAuthProviderKind = createMemo(() => {
    const draft = authDraft()
    const connection = getProviderConnectionForId(connections(), selectedAuthConnectionId())

    return draft.providerKind || connection?.providerKind || ''
  })
  const handleBeginAuth = () => {
    const connectionId = selectedAuthConnectionId()
    const providerKind = selectedAuthProviderKind()

    if (!providerKind) {
      setPageError('Select a provider kind before starting auth.')
      return
    }

    beginAuthMutation.mutate({connectionId: connectionId || undefined, providerKind})
  }
  const handleFinishAuth = () => {
    const draft = authDraft()
    const connectionId = selectedAuthConnectionId()
    const providerKind = selectedAuthProviderKind()

    if (!providerKind) {
      setPageError('Select a provider kind before finishing auth.')
      return
    }

    finishAuthMutation.mutate({
      connectionId: connectionId || undefined,
      payload: {authMode: null, secretValue: draft.secretValue || null},
      providerKind,
    })
  }
  const handleMaterializeModel = () => {
    const draft = materializationDraft()

    if (!draft.sourceModelId || !draft.targetProviderConnectionId || !draft.remoteModelId.trim()) {
      setPageError('Select a source model, provider connection, and remote model id first.')
      return
    }

    materializeModelMutation.mutate(draft)
  }
  const handleMarkProviderUnresolved = () => {
    const sourceProviderConnectionId = selectedProviderSourceId()

    if (sourceProviderConnectionId) {
      resolveWithCurrentRevision({unresolvedProviders: [{sourceProviderConnectionId, status: 'missing'}]})
    }
  }
  const handleMarkModelUnresolved = () => {
    const sourceModelId = selectedModelSourceId()

    if (sourceModelId) {
      resolveWithCurrentRevision({unresolvedModels: [{sourceModelId, status: 'missing'}]})
    }
  }
  const selectedConnection = createMemo(() => {
    return getProviderConnectionForId(connections(), selectedTargetProviderConnectionId())
  })
  const selectedTargetModel = createMemo(() => {
    return getModelForId(selectableModels(), selectedTargetModelId())
  })
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
            <PostImportWarningsPanel session={currentSession()} />
            <SummaryTable fields={overlapSummaryFields} title="Overlap summary" values={planSummary()?.overlapCounts} />
            <SummaryTable
              fields={conflictSummaryFields}
              title="Conflict summary"
              values={planSummary()?.conflictCounts}
            />
            <DependencyStatusTable session={currentSession()} />
            <BlockersPanel summary={planSummary()} />

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

              <div class="mt-4 grid gap-4 lg:grid-cols-2">
                <div class="rounded-lg border border-gray-200 bg-gray-50 p-4">
                  <h3 class="text-sm font-semibold text-gray-900">Provider mapping</h3>
                  <div class="mt-3 space-y-3">
                    <label class="block text-sm font-medium text-gray-700">
                      <span>Source provider</span>
                      <select
                        class="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
                        onChange={(event) => {
                          setSelectedProviderSourceId(event.currentTarget.value)
                        }}
                        value={selectedProviderSourceId()}
                      >
                        <For each={providerSourceIds()}>
                          {(sourceId) => {
                            return (
                              <option value={sourceId}>
                                {sourceId} ({getDependencyStatus(planSummary(), 'provider:', sourceId)})
                              </option>
                            )
                          }}
                        </For>
                      </select>
                    </label>
                    <label class="block text-sm font-medium text-gray-700">
                      <span>Existing enabled target connection</span>
                      <select
                        class="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
                        onChange={(event) => {
                          setSelectedTargetProviderConnectionId(event.currentTarget.value)
                        }}
                        value={selectedTargetProviderConnectionId()}
                      >
                        <For each={enabledConnections()}>
                          {(connection) => {
                            return (
                              <option value={connection.id}>
                                {connection.label} ({getProviderLabel(catalog(), connection.providerKind)})
                              </option>
                            )
                          }}
                        </For>
                      </select>
                    </label>
                    <div class="flex flex-wrap gap-2">
                      <Button
                        disabled={!selectedProviderSourceId() || !selectedTargetProviderConnectionId()}
                        onClick={handleUseSelectedProvider}
                        type="button"
                      >
                        Use connection
                      </Button>
                      <Button
                        disabled={!selectedProviderSourceId()}
                        onClick={handleMarkProviderUnresolved}
                        type="button"
                        variant="outline"
                      >
                        Mark unresolved
                      </Button>
                    </div>
                  </div>
                </div>

                <div class="rounded-lg border border-gray-200 bg-gray-50 p-4">
                  <h3 class="text-sm font-semibold text-gray-900">Create target connection</h3>
                  <div class="mt-3 grid gap-3">
                    <label class="block text-sm font-medium text-gray-700">
                      <span>Provider kind</span>
                      <select
                        class="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
                        onChange={(event) => {
                          setConnectionDraft((draft) => {
                            return {...draft, providerKind: event.currentTarget.value}
                          })
                        }}
                        value={connectionDraft().providerKind}
                      >
                        <For each={catalog()}>
                          {(entry) => {
                            return <option value={entry.kind}>{entry.label}</option>
                          }}
                        </For>
                      </select>
                    </label>
                    <label class="block text-sm font-medium text-gray-700">
                      <span>Connection label</span>
                      <input
                        class="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                        onInput={(event) => {
                          setConnectionDraft((draft) => {
                            return {...draft, label: event.currentTarget.value}
                          })
                        }}
                        value={connectionDraft().label}
                      />
                    </label>
                    <label class="block text-sm font-medium text-gray-700">
                      <span>Base URL</span>
                      <input
                        class="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                        onInput={(event) => {
                          setConnectionDraft((draft) => {
                            return {...draft, baseURL: event.currentTarget.value}
                          })
                        }}
                        placeholder="Optional"
                        value={connectionDraft().baseURL}
                      />
                    </label>
                    <label class="block text-sm font-medium text-gray-700">
                      <span>API key</span>
                      <input
                        class="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                        onInput={(event) => {
                          setConnectionDraft((draft) => {
                            return {...draft, apiKey: event.currentTarget.value}
                          })
                        }}
                        placeholder="Optional or managed auth"
                        type="password"
                        value={connectionDraft().apiKey}
                      />
                    </label>
                    <Button
                      disabled={createConnectionMutation.isPending}
                      onClick={handleCreateConnection}
                      type="button"
                    >
                      Create connection
                    </Button>
                  </div>
                </div>
              </div>

              <div class="mt-4 grid gap-4 lg:grid-cols-2">
                <div class="rounded-lg border border-gray-200 bg-gray-50 p-4">
                  <h3 class="text-sm font-semibold text-gray-900">Managed auth and discovery</h3>
                  <div class="mt-3 grid gap-3">
                    <label class="block text-sm font-medium text-gray-700">
                      <span>Connection</span>
                      <select
                        class="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
                        onChange={(event) => {
                          const connection = getProviderConnectionForId(connections(), event.currentTarget.value)

                          setAuthDraft({
                            connectionId: event.currentTarget.value,
                            providerKind: connection?.providerKind ?? authDraft().providerKind,
                            secretValue: '',
                          })
                        }}
                        value={selectedAuthConnectionId()}
                      >
                        <For each={enabledConnections()}>
                          {(connection) => {
                            return <option value={connection.id}>{connection.label}</option>
                          }}
                        </For>
                      </select>
                    </label>
                    <input
                      class="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                      onInput={(event) => {
                        setAuthDraft((draft) => {
                          return {...draft, secretValue: event.currentTarget.value}
                        })
                      }}
                      placeholder="Managed auth secret, when requested"
                      type="password"
                      value={authDraft().secretValue}
                    />
                    <div class="flex flex-wrap gap-2">
                      <Button
                        disabled={beginAuthMutation.isPending}
                        onClick={handleBeginAuth}
                        type="button"
                        variant="outline"
                      >
                        Begin auth
                      </Button>
                      <Button
                        disabled={finishAuthMutation.isPending}
                        onClick={handleFinishAuth}
                        type="button"
                        variant="outline"
                      >
                        Finish auth
                      </Button>
                      <Button
                        disabled={!selectedAuthConnectionId() || testConnectionMutation.isPending}
                        onClick={() => {
                          testConnectionMutation.mutate(selectedAuthConnectionId())
                        }}
                        type="button"
                        variant="outline"
                      >
                        Test
                      </Button>
                      <Button
                        disabled={!selectedAuthConnectionId() || discoverModelsMutation.isPending}
                        onClick={() => {
                          discoverModelsMutation.mutate(selectedAuthConnectionId())
                        }}
                        type="button"
                        variant="outline"
                      >
                        Discover
                      </Button>
                      <Button
                        disabled={!selectedAuthConnectionId() || syncModelsMutation.isPending}
                        onClick={() => {
                          syncModelsMutation.mutate(selectedAuthConnectionId())
                        }}
                        type="button"
                        variant="outline"
                      >
                        Sync models
                      </Button>
                    </div>
                    <Show when={authMessage()}>
                      <p class="text-sm text-gray-600">{authMessage()}</p>
                    </Show>
                    <Show when={discoveredModels().length > 0}>
                      <div class="rounded-md border border-gray-200 bg-white p-3 text-sm text-gray-700">
                        <div class="font-medium text-gray-900">Discovered models</div>
                        <ul class="mt-2 space-y-1">
                          <For each={discoveredModels()}>
                            {(model) => {
                              return <li>{model.displayName || model.modelName}</li>
                            }}
                          </For>
                        </ul>
                      </div>
                    </Show>
                  </div>
                </div>

                <div class="rounded-lg border border-gray-200 bg-gray-50 p-4">
                  <h3 class="text-sm font-semibold text-gray-900">Codex status and login</h3>
                  <div class="mt-3 space-y-3 text-sm text-gray-700">
                    <Show when={codexStatusQuery.data} fallback={<p>Codex status has not loaded yet.</p>}>
                      {(status) => {
                        return (
                          <div class="space-y-2">
                            <div>
                              CLI:{' '}
                              <span
                                class={
                                  status().cli.loggedIn ? 'font-medium text-green-700' : 'font-medium text-amber-700'
                                }
                              >
                                {status().cli.loggedIn ? 'Logged in' : 'Login required'}
                              </span>
                            </div>
                            <div>
                              App server:{' '}
                              <span
                                class={
                                  status().appServerReady ? 'font-medium text-green-700' : 'font-medium text-amber-700'
                                }
                              >
                                {status().appServerReady ? 'Ready' : 'Not ready'}
                              </span>
                            </div>
                            <p class="break-words text-gray-500">{status().message}</p>
                          </div>
                        )
                      }}
                    </Show>
                    <div class="flex flex-wrap gap-2">
                      <Button
                        disabled={codexStatusQuery.isFetching}
                        onClick={() => {
                          void codexStatusQuery.refetch()
                        }}
                        type="button"
                        variant="outline"
                      >
                        Refresh status
                      </Button>
                      <Button
                        disabled={codexLoginMutation.isPending}
                        onClick={() => {
                          return codexLoginMutation.mutate()
                        }}
                        type="button"
                      >
                        Start login
                      </Button>
                      <Button
                        disabled={!currentSession()}
                        onClick={() => {
                          resolveWithCurrentRevision({codexSetupState: 'complete'})
                        }}
                        type="button"
                        variant="outline"
                      >
                        Mark Codex complete
                      </Button>
                    </div>
                  </div>
                </div>
              </div>

              <div class="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
                <h3 class="text-sm font-semibold text-gray-900">Model mapping and materialization</h3>
                <div class="mt-3 grid gap-3 lg:grid-cols-2">
                  <label class="block text-sm font-medium text-gray-700">
                    <span>Source model</span>
                    <select
                      class="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
                      onChange={(event) => {
                        setSelectedModelSourceId(event.currentTarget.value)
                        setMaterializationDraft((draft) => {
                          return {...draft, sourceModelId: event.currentTarget.value}
                        })
                      }}
                      value={selectedModelSourceId()}
                    >
                      <For each={modelSourceIds()}>
                        {(sourceId) => {
                          return (
                            <option value={sourceId}>
                              {sourceId} ({getDependencyStatus(planSummary(), 'model:', sourceId)})
                            </option>
                          )
                        }}
                      </For>
                    </select>
                  </label>
                  <label class="block text-sm font-medium text-gray-700">
                    <span>Existing enabled target model</span>
                    <select
                      class="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
                      onChange={(event) => {
                        setSelectedTargetModelId(event.currentTarget.value)
                      }}
                      value={selectedTargetModelId()}
                    >
                      <For each={selectableModels()}>
                        {(model) => {
                          return (
                            <option value={model.id}>
                              {model.displayName ?? model.name} ({model.connectionLabel})
                            </option>
                          )
                        }}
                      </For>
                    </select>
                  </label>
                </div>
                <div class="mt-3 flex flex-wrap items-center gap-2">
                  <label class="inline-flex items-center gap-2 text-sm text-gray-700">
                    <input
                      checked={acceptSubstituteModel()}
                      onChange={(event) => {
                        setAcceptSubstituteModel(event.currentTarget.checked)
                      }}
                      type="checkbox"
                    />
                    Accept substitute only when no imported judgments reference this model
                  </label>
                  <Button
                    disabled={!selectedModelSourceId() || !selectedTargetModelId()}
                    onClick={handleUseSelectedModel}
                    type="button"
                  >
                    Use model
                  </Button>
                  <Button
                    disabled={!selectedModelSourceId()}
                    onClick={handleMarkModelUnresolved}
                    type="button"
                    variant="outline"
                  >
                    Mark unresolved
                  </Button>
                </div>
                <div class="mt-4 grid gap-3 lg:grid-cols-4">
                  <input
                    class="rounded-md border border-gray-300 px-3 py-2 text-sm"
                    onInput={(event) => {
                      setMaterializationDraft((draft) => {
                        return {...draft, remoteModelId: event.currentTarget.value}
                      })
                    }}
                    placeholder="Remote model id"
                    value={materializationDraft().remoteModelId}
                  />
                  <input
                    class="rounded-md border border-gray-300 px-3 py-2 text-sm"
                    onInput={(event) => {
                      setMaterializationDraft((draft) => {
                        return {...draft, displayName: event.currentTarget.value}
                      })
                    }}
                    placeholder="Display name"
                    value={materializationDraft().displayName}
                  />
                  <input
                    class="rounded-md border border-gray-300 px-3 py-2 text-sm"
                    onInput={(event) => {
                      setMaterializationDraft((draft) => {
                        return {...draft, variant: event.currentTarget.value}
                      })
                    }}
                    placeholder="Variant"
                    value={materializationDraft().variant}
                  />
                  <Button disabled={materializeModelMutation.isPending} onClick={handleMaterializeModel} type="button">
                    Materialize model
                  </Button>
                </div>
                <Show when={selectedConnection()}>
                  {(connection) => {
                    return (
                      <p class="mt-3 text-xs text-gray-500">
                        Selected connection: {connection().label} ({connection().id})
                      </p>
                    )
                  }}
                </Show>
                <Show when={selectedTargetModel()}>
                  {(model) => {
                    return (
                      <p class="mt-1 text-xs text-gray-500">
                        Selected model: {model().displayName ?? model().name} ({model().id})
                      </p>
                    )
                  }}
                </Show>
              </div>
            </section>

            <section class="rounded-lg border border-gray-200 bg-white p-4">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 class="text-base font-semibold text-gray-900">Plan review</h2>
                  <p class="mt-1 text-sm text-gray-500">{getCommitUnavailableReason(currentSession())}</p>
                </div>
                <div class="flex items-center gap-3">
                  <StatusBadge status={commitmentState()} />
                  <Button disabled={!canCommit()} onClick={handleCommit} type="button">
                    <Switch>
                      <Match when={commitMutation.isPending}>Committing...</Match>
                      <Match when={currentSession()?.state === 'committing'}>Commit running</Match>
                      <Match when={currentSession()?.state === 'completed'}>Committed</Match>
                      <Match when={true}>Commit import</Match>
                    </Switch>
                  </Button>
                </div>
              </div>
            </section>

            <div class="grid gap-4 lg:grid-cols-2">
              <MappingPanel
                mapping={plan()?.dependencyResolution?.providerTargetBySourceId}
                title="Final provider mappings"
              />
              <MappingPanel
                mapping={plan()?.dependencyResolution?.modelTargetBySourceId}
                title="Final model mappings"
              />
              <ProvenancePanel entries={judgmentPlan()} title="Judgment signature provenance" />
              <ProvenancePanel entries={humanReviewPlan()} title="Human/review signature provenance" />
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
            <PlanDetailList emptyLabel="No judgment plan rows." entries={judgmentPlan()} title="Judgment plan rows" />
            <PlanDetailList
              emptyLabel="No human/review plan rows."
              entries={humanReviewPlan()}
              title="Human/review plan rows"
            />
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
