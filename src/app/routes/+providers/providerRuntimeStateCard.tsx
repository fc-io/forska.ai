import {For, Show} from 'solid-js'

import type {ProviderConnection} from '../+admin/+models/providerConnectionsClient.ts'

const getRuntimeStatusClasses = (
  status: ProviderConnection['runtimeState'] extends infer T ? (T extends {status: infer S} ? S : never) : never,
) => {
  return status === 'matched'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
    : status === 'manual-only'
      ? 'border-slate-200 bg-slate-100 text-slate-700'
      : status === 'ambiguous'
        ? 'border-amber-200 bg-amber-50 text-amber-900'
        : 'border-rose-200 bg-rose-50 text-rose-800'
}

const getRuntimeSourceSummary = (connection: ProviderConnection) => {
  const sourceMetadata = connection.runtimeState?.sourceMetadata

  if (!sourceMetadata) {
    return null
  }

  return [
    sourceMetadata.kind === 'launcher' ? sourceMetadata.label : `source ${sourceMetadata.label}`,
    sourceMetadata.cluster ? `cluster ${sourceMetadata.cluster}` : null,
    sourceMetadata.jobId ? `job ${sourceMetadata.jobId}` : null,
    sourceMetadata.sshJumpHost ? `ssh ${sourceMetadata.sshJumpHost}` : null,
  ].filter((value): value is string => {
    return Boolean(value)
  })
}

const getUniqueRuntimeReasons = (connection: ProviderConnection) => {
  const reasonLabels = connection.runtimeState?.reasonLabels ?? []

  return Array.from(new Set(reasonLabels))
}

type ProviderRuntimeStateCardProps = {connection: ProviderConnection; title: string}

export const ProviderRuntimeStateCard = (props: ProviderRuntimeStateCardProps) => {
  const runtimeState = () => {
    return props.connection.runtimeState
  }
  const sourceSummary = () => {
    return getRuntimeSourceSummary(props.connection)
  }
  const reasonLabels = () => {
    return getUniqueRuntimeReasons(props.connection)
  }

  return (
    <div class="rounded-lg border border-gray-200 bg-white/70 p-4">
      <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h3 class="text-sm font-semibold text-gray-900">{props.title}</h3>
          <p class="mt-1 text-sm text-gray-600">{runtimeState()?.reasonLabel ?? 'No runtime state available.'}</p>
        </div>
        <Show when={runtimeState()}>
          {(state) => {
            return (
              <span
                class={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${getRuntimeStatusClasses(state().status)}`}
              >
                {state().statusLabel}
              </span>
            )
          }}
        </Show>
      </div>

      <div class="mt-4 grid gap-3 text-sm text-gray-600 sm:grid-cols-2">
        <div>
          <div class="font-medium text-gray-700">Effective runtime URL</div>
          <div class="mt-1 break-all">{runtimeState()?.effectiveBaseURL ?? 'None'}</div>
        </div>
        <div>
          <div class="font-medium text-gray-700">Effective worker URLs</div>
          <Show when={(runtimeState()?.effectiveWorkerUrls.length ?? 0) > 0} fallback={<div class="mt-1">None</div>}>
            <div class="mt-1 space-y-1 break-all">
              <For each={runtimeState()?.effectiveWorkerUrls ?? []}>
                {(url) => {
                  return <div>{url}</div>
                }}
              </For>
            </div>
          </Show>
        </div>
        <div>
          <div class="font-medium text-gray-700">Detected served models</div>
          <Show
            when={(runtimeState()?.detectedModelNames.length ?? 0) > 0}
            fallback={<div class="mt-1">None detected</div>}
          >
            <div class="mt-1 flex flex-wrap gap-1.5">
              <For each={runtimeState()?.detectedModelNames ?? []}>
                {(modelName) => {
                  return (
                    <span class="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-800">
                      {modelName}
                    </span>
                  )
                }}
              </For>
            </div>
          </Show>
        </div>
        <div>
          <div class="font-medium text-gray-700">Match source</div>
          <Show when={(sourceSummary()?.length ?? 0) > 0} fallback={<div class="mt-1">Saved manual settings only</div>}>
            <div class="mt-1 space-y-1">
              <For each={sourceSummary() ?? []}>
                {(item) => {
                  return <div>{item}</div>
                }}
              </For>
            </div>
          </Show>
        </div>
      </div>

      <div class="mt-4">
        <div class="font-medium text-gray-700">Match reasons</div>
        <div class="mt-2 space-y-2 text-sm text-gray-600">
          <For each={reasonLabels()}>
            {(reasonLabel) => {
              return <div class="rounded-md bg-gray-50 px-3 py-2">{reasonLabel}</div>
            }}
          </For>
        </div>
      </div>
    </div>
  )
}
