import {useQuery} from '@tanstack/solid-query'
import {Match, Show, splitProps, Switch} from 'solid-js'

import {apiClient} from '../../../services/apiClient'
import {handleApiResponse} from '../../../services/utils/handleApiResponse'

export type FullTextModelRole = 'figure_description' | 'pdf_conversion'

type FullTextModelHealthState = 'disabled' | 'failed' | 'healthy' | 'unverified'

type FullTextModelCapabilityState = 'missing' | 'unverified' | 'verified'

export type FullTextModelStatus = {
  capability: {detail: string; label: string; state: FullTextModelCapabilityState}
  health: {detail: string; lastCheckedAt: string | null; lastError: string | null; state: FullTextModelHealthState}
  modelId: string
  modelLabel: string
  providerConnectionId: string
  providerKind: string | null
  providerLabel: string
  role: FullTextModelRole
}

type FullTextModelStatusResponse = {data: FullTextModelStatus | null}

const healthStateLabels: Record<FullTextModelHealthState, string> = {
  disabled: 'Disabled',
  failed: 'Health check failed',
  healthy: 'Healthy',
  unverified: 'Unverified',
}

const healthStateClasses: Record<FullTextModelHealthState, string> = {
  disabled: 'text-red-700',
  failed: 'text-red-700',
  healthy: 'text-emerald-700',
  unverified: 'text-amber-700',
}

const capabilityStateLabels: Record<FullTextModelCapabilityState, string> = {
  missing: 'Missing',
  unverified: 'Unverified',
  verified: 'Verified',
}

const capabilityStateClasses: Record<FullTextModelCapabilityState, string> = {
  missing: 'text-red-700',
  unverified: 'text-amber-700',
  verified: 'text-emerald-700',
}

const fetchFullTextModelStatus = async (modelId: string, role: FullTextModelRole) => {
  const response = await apiClient.api.users['full-text-model-status'].get({query: {modelId, role}})

  return handleApiResponse<FullTextModelStatusResponse>(response, 'Failed to load the model status').data
}

const getQueryErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : 'Failed to load the model status'
}

export const FullTextModelStatusNotice = (props: {modelId: string; role: FullTextModelRole}) => {
  const [local] = splitProps(props, ['modelId', 'role'])
  const statusQuery = useQuery(() => {
    return {
      enabled: local.modelId !== '',
      queryFn: () => {
        return fetchFullTextModelStatus(local.modelId, local.role)
      },
      queryKey: ['users', 'full-text-model-status', local.role, local.modelId],
      staleTime: 30_000,
      suspense: false,
    }
  })

  return (
    <Show when={local.modelId !== ''}>
      <div class="mt-2 space-y-1 text-xs" data-testid={`full-text-model-status-${local.role}`}>
        <Switch>
          <Match when={statusQuery.isLoading}>
            <p class="text-gray-500">Checking provider health…</p>
          </Match>
          <Match when={statusQuery.isError}>
            <p class="text-red-700">{getQueryErrorMessage(statusQuery.error)}</p>
          </Match>
          <Match when={statusQuery.isSuccess && !statusQuery.data}>
            <p class="text-red-700">The selected model no longer exists.</p>
          </Match>
          <Match when={statusQuery.data}>
            {(status) => {
              return (
                <>
                  <p data-testid="full-text-model-health">
                    <span class={`font-medium ${healthStateClasses[status().health.state]}`}>
                      Provider health: {healthStateLabels[status().health.state]}.
                    </span>{' '}
                    <span class="text-gray-600">{status().health.detail}</span>
                  </p>
                  <p data-testid="full-text-model-capability">
                    <span class={`font-medium ${capabilityStateClasses[status().capability.state]}`}>
                      {status().capability.label}: {capabilityStateLabels[status().capability.state]}.
                    </span>{' '}
                    <span class="text-gray-600">{status().capability.detail}</span>
                  </p>
                </>
              )
            }}
          </Match>
        </Switch>
      </div>
    </Show>
  )
}
