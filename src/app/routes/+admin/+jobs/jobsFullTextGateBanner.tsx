import {useQuery} from '@tanstack/solid-query'
import {Link} from '@tanstack/solid-router'
import {createMemo, For, Show} from 'solid-js'

import {
  buildJobsFullTextGateBanner,
  formatStatus,
  getJudgmentsJobsQuery,
  getProviderHealthToneClass,
  getStatusColor,
} from './jobsPageShared'

export const JobsFullTextGateBanner = () => {
  const jobs = useQuery(getJudgmentsJobsQuery)
  const banner = createMemo(() => {
    return buildJobsFullTextGateBanner(jobs.data)
  })

  return (
    <Show when={banner()}>
      {(currentBanner) => {
        return (
          <div
            role="alert"
            class={`mb-6 rounded-lg border p-4 ${getProviderHealthToneClass(currentBanner().tone)}`}
            data-testid="jobs-full-text-gate-banner"
          >
            <p class="font-medium">{currentBanner().title}</p>
            <div class="mt-3 space-y-4">
              <For each={currentBanner().groups}>
                {(group) => {
                  return (
                    <div class="min-w-0 text-sm" data-tone={group.tone}>
                      <p class="break-words [overflow-wrap:anywhere]">
                        <span class="font-medium">{group.tone === 'rose' ? 'Blocks judging: ' : 'Warning: '}</span>
                        {group.message}
                      </p>
                      <div class="mt-2 flex flex-wrap items-center gap-2">
                        <span class="text-xs font-medium">Affected jobs:</span>
                        <For each={group.jobs}>
                          {(affectedJob) => {
                            return (
                              <Link
                                to="/admin/jobs/$id"
                                params={{id: affectedJob.id}}
                                class="inline-flex items-center gap-2 rounded-md bg-white/70 px-2 py-1 text-xs font-medium hover:underline"
                              >
                                <span>{affectedJob.projectName}</span>
                                <span
                                  class={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${getStatusColor(
                                    affectedJob.status,
                                  )}`}
                                >
                                  {formatStatus(affectedJob.status)}
                                </span>
                              </Link>
                            )
                          }}
                        </For>
                      </div>
                    </div>
                  )
                }}
              </For>
            </div>
          </div>
        )
      }}
    </Show>
  )
}
