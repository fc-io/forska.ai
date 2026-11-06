import {formatDate} from 'date-fns'
import {For, Show} from 'solid-js'

export type JobProviderQuotaHeadline = {
  label: string
  limitKind: string
  observedAt: string
  resetsAt: string | null
  utilizationPercent: number
}

export type JobProviderQuota = {
  headlines: JobProviderQuotaHeadline[]
  providerConnectionId: string
  providerKind: string
}

const formatQuotaTime = (value: string): string => {
  return formatDate(new Date(value), 'EEE d MMM HH:mm')
}

const formatQuotaPercent = (value: number): string => {
  return String(Math.round(value * 10) / 10)
}

export const formatProviderQuotaHeadline = (headline: JobProviderQuotaHeadline): string => {
  const resets = headline.resetsAt ? `, resets ${formatQuotaTime(headline.resetsAt)}` : ''

  return `${headline.label} ${formatQuotaPercent(headline.utilizationPercent)} %${resets}`
}

export const JobProviderQuotaNotice = (props: {quota: JobProviderQuota | null | undefined}) => {
  return (
    <Show when={props.quota}>
      {(quota) => {
        return (
          <div
            class="min-w-0 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-800"
            data-testid="job-provider-quota"
          >
            <Show
              when={quota().headlines.length > 0}
              fallback={<p class="text-gray-500">No subscription quota reading in the last 24 hours.</p>}
            >
              <ul class="space-y-1">
                <For each={quota().headlines}>
                  {(headline) => {
                    return (
                      <li class="break-words">
                        <span class="font-medium">{formatProviderQuotaHeadline(headline)}</span>
                        <span class="ml-2 text-xs text-gray-500">read {formatQuotaTime(headline.observedAt)}</span>
                      </li>
                    )
                  }}
                </For>
              </ul>
            </Show>
          </div>
        )
      }}
    </Show>
  )
}
