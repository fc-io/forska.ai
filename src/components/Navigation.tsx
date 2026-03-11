import {useQuery} from '@tanstack/solid-query'
import {Link, useLocation} from '@tanstack/solid-router'
import {createMemo, createSignal, onCleanup, onMount, Show} from 'solid-js'

import {apiClient} from '../services/apiClient'

const isEventTargetWithinElement = (target: EventTarget | null, element: HTMLElement | undefined) => {
  return target instanceof Node && !!element && element.contains(target)
}

const isEditableTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  const tagName = target.tagName
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT' || target.isContentEditable
}

const isF13KeyDownEvent = (event: KeyboardEvent) => {
  return event.code === 'F13' || event.key === 'F13'
}

type LlmMetricsSummary = {waiting: number; running: number; lastUpdate: Date | null}

type LlmMetricsIndicator = {waiting: number; running: number; lastUpdate: Date | null; isFresh: boolean}

const llmMetricsFreshnessWindowMs = 3 * 60 * 1000

const getLlmMetricsIndicator = (metrics: LlmMetricsSummary | null, nowMs: number): LlmMetricsIndicator => {
  const lastUpdate = metrics?.lastUpdate ?? null
  const ageMs = lastUpdate ? Math.max(0, nowMs - lastUpdate.getTime()) : null
  const isFresh = ageMs !== null && ageMs <= llmMetricsFreshnessWindowMs
  const waiting = isFresh ? (metrics?.waiting ?? 0) : 0
  const running = isFresh ? (metrics?.running ?? 0) : 0
  return {waiting, running, lastUpdate, isFresh}
}

const getLlmMetricsIndicatorTitle = (isFresh: boolean) => {
  return isFresh
    ? 'Waiting / Running requests across all workers'
    : 'Waiting / Running requests across all workers (no metrics update in last 3m)'
}

const getLlmMetricsRefetchInterval = (_pathname: string) => {
  return 30 * 1000
}

const fetchLlmMetricsSummary = async (): Promise<LlmMetricsSummary | null> => {
  const response = await apiClient.api.llmstatus.get()
  if (response.error) {
    return null
  }
  const entries = response.data?.data ?? []
  const latestByInstance = new Map<string, {waiting: number; running: number; ts: Date | null}>()
  for (const row of entries) {
    const instanceId = typeof row.instanceId === 'string' ? row.instanceId : ''
    if (!latestByInstance.has(instanceId)) {
      const ts = row.ts ? new Date(row.ts as string | number | Date) : null
      latestByInstance.set(instanceId, {
        waiting: (row.numQueueReqs as number | null) ?? 0,
        running: (row.numRunningReqs as number | null) ?? 0,
        ts: ts && !isNaN(ts.getTime()) ? ts : null,
      })
    }
  }
  const values = [...latestByInstance.values()]
  const totalWaiting = values.reduce((sum, v) => {
    return sum + v.waiting
  }, 0)
  const totalRunning = values.reduce((sum, v) => {
    return sum + v.running
  }, 0)
  const timestamps = values
    .map((v) => {
      return v.ts
    })
    .filter((t): t is Date => {
      return t !== null
    })
  const lastUpdate =
    timestamps.length > 0
      ? new Date(
          Math.max(
            ...timestamps.map((t) => {
              return t.getTime()
            }),
          ),
        )
      : null
  return {waiting: totalWaiting, running: totalRunning, lastUpdate}
}

const formatLastUpdate = (date: Date | null): string => {
  if (!date) {
    return ''
  }
  const now = new Date()
  const isToday =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
  const time = date.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false})
  if (isToday) {
    return `Updated ${time}`
  }
  const dateStr = date.toLocaleDateString([], {month: 'short', day: 'numeric'})
  return `Updated ${dateStr} ${time}`
}

export const Navigation = () => {
  const [isAdminMenuOpen, setIsAdminMenuOpen] = createSignal(false)
  let adminMenuTriggerElement: HTMLDivElement | undefined
  let adminMenuElement: HTMLDivElement | undefined
  const location = useLocation()

  const llmMetricsQuery = useQuery(() => {
    return {
      queryKey: ['llm-metrics-summary'],
      queryFn: fetchLlmMetricsSummary,
      refetchInterval: getLlmMetricsRefetchInterval(location().pathname),
      enabled: true,
      suspense: false,
    }
  })

  const llmMetrics = () => {
    return llmMetricsQuery.data ?? null
  }

  const llmMetricsIndicator = createMemo(() => {
    return getLlmMetricsIndicator(llmMetrics(), Date.now())
  })

  const closeAdminMenu = () => {
    setIsAdminMenuOpen(false)
  }

  const openAdminMenu = () => {
    setIsAdminMenuOpen(true)
  }

  const toggleAdminMenu = () => {
    setIsAdminMenuOpen((previous) => {
      return !previous
    })
  }

  const handleAdminMenuTriggerPointerEnter = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') {
      openAdminMenu()
    }
  }

  const handleAdminMenuTriggerPointerLeave = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse') {
      return
    }

    if (!isEventTargetWithinElement(event.relatedTarget, adminMenuElement)) {
      closeAdminMenu()
    }
  }

  const handleAdminMenuPointerEnter = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') {
      openAdminMenu()
    }
  }

  const handleAdminMenuPointerLeave = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse') {
      return
    }

    if (!isEventTargetWithinElement(event.relatedTarget, adminMenuTriggerElement)) {
      closeAdminMenu()
    }
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (!isF13KeyDownEvent(event) || isEditableTarget(event.target)) {
      return
    }

    event.preventDefault()
    toggleAdminMenu()
  }

  onMount(() => {
    window.addEventListener('keydown', handleKeyDown)
  })

  onCleanup(() => {
    window.removeEventListener('keydown', handleKeyDown)
  })

  return (
    <nav class="relative bg-white shadow-sm border-b border-gray-200">
      <div class="px-4 sm:px-6 lg:px-8">
        <div class="flex justify-between h-16">
          <div class="flex items-center space-x-8">
            <Link
              to="/"
              class="text-gray-900 hover:text-blue-600 px-3 py-2 text-sm font-medium [&.active]:text-blue-600 [&.active]:font-semibold"
            >
              Home
            </Link>
            <Link
              to="/prompts"
              class="text-gray-900 hover:text-blue-600 px-3 py-2 text-sm font-medium [&.active]:text-blue-600 [&.active]:font-semibold"
            >
              Prompts
            </Link>
            <Link
              to="/compare-judgments"
              class="text-gray-900 hover:text-blue-600 px-3 py-2 text-sm font-medium [&.active]:text-blue-600 [&.active]:font-semibold"
            >
              Compare Judgments
            </Link>
            <Link
              to="/articles"
              class="text-gray-900 hover:text-blue-600 px-3 py-2 text-sm font-medium [&.active]:text-blue-600 [&.active]:font-semibold"
            >
              Article Search
            </Link>
            <Link
              to="/settings"
              class="text-gray-900 hover:text-blue-600 px-3 py-2 text-sm font-medium [&.active]:text-blue-600 [&.active]:font-semibold"
            >
              Settings
            </Link>
          </div>
          <div class="flex items-center space-x-4">
            <div
              class="flex flex-col items-end px-2 py-1"
              title={getLlmMetricsIndicatorTitle(llmMetricsIndicator().isFresh)}
            >
              <div class={`text-sm font-medium ${llmMetricsIndicator().isFresh ? 'text-gray-700' : 'text-red-600'}`}>
                {llmMetricsIndicator().waiting}/{llmMetricsIndicator().running}
              </div>
              <div class={`text-xs ${llmMetricsIndicator().isFresh ? 'text-gray-400' : 'text-red-400'}`}>
                {formatLastUpdate(llmMetricsIndicator().lastUpdate)}
              </div>
            </div>
            <div
              ref={(element) => {
                adminMenuTriggerElement = element
              }}
              class="group -mx-2 mr-4 flex h-full cursor-pointer select-none items-center px-2"
              role="button"
              tabIndex={0}
              aria-haspopup="true"
              aria-expanded={isAdminMenuOpen()}
              onPointerEnter={handleAdminMenuTriggerPointerEnter}
              onPointerLeave={handleAdminMenuTriggerPointerLeave}
              onClick={toggleAdminMenu}
            >
              <div
                class={`rounded-md px-3 py-2 text-sm font-medium text-gray-700 group-hover:bg-stone-100 group-hover:text-gray-900 ${
                  isAdminMenuOpen() ? 'bg-stone-100 text-gray-900' : ''
                }`}
              >
                Admin
              </div>
            </div>
          </div>
        </div>
      </div>
      <Show when={isAdminMenuOpen()}>
        <div
          ref={(element) => {
            adminMenuElement = element
          }}
          class="absolute left-0 right-0 top-full -mt-px z-50 border-t border-gray-200 bg-stone-100 shadow-sm"
          onPointerEnter={handleAdminMenuPointerEnter}
          onPointerLeave={handleAdminMenuPointerLeave}
        >
          <div class="px-4 sm:px-6 lg:px-8 py-6">
            <div class="flex items-stretch gap-6 min-h-64">
              <div class="grid flex-1 grid-cols-1 gap-10 sm:grid-cols-2 lg:grid-cols-3">
                <div class="flex flex-col gap-4">
                  <div class="text-xs font-semibold uppercase tracking-wide text-gray-500">Data</div>
                  <div class="flex flex-col gap-1">
                    <Link
                      to="/admin/assessments"
                      class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                      onClick={closeAdminMenu}
                    >
                      Assessments
                    </Link>
                    <Link
                      to="/admin/datasources"
                      class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                      onClick={closeAdminMenu}
                    >
                      Data Sources
                    </Link>
                    <Link
                      to="/admin/latest-articles"
                      class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                      onClick={closeAdminMenu}
                    >
                      Latest Articles
                    </Link>
                    <Link
                      to="/admin/import-route-stats"
                      class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                      onClick={closeAdminMenu}
                    >
                      Import Route Stats
                    </Link>
                    <Link
                      to="/admin/pdf-conversions"
                      class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                      onClick={closeAdminMenu}
                    >
                      PDF Conversions
                    </Link>
                    <Link
                      to="/admin/pdf-reset"
                      class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                      onClick={closeAdminMenu}
                    >
                      PDF Fetch Reset
                    </Link>
                    <Link
                      to="/admin/unexpected-answers"
                      class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                      onClick={closeAdminMenu}
                    >
                      Unexpected Answers
                    </Link>
                  </div>
                </div>
                <div class="flex flex-col gap-4">
                  <div class="text-xs font-semibold uppercase tracking-wide text-gray-500">System</div>
                  <div class="flex flex-col gap-1">
                    <Link
                      to="/admin/gpu"
                      class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                      onClick={closeAdminMenu}
                    >
                      GPU Metrics
                    </Link>
                    <Link
                      to="/admin/failed_requests"
                      class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                      onClick={closeAdminMenu}
                    >
                      Failed Requests
                    </Link>
                    <Link
                      to="/admin/sync-stats"
                      class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                      onClick={closeAdminMenu}
                    >
                      Sync Stats
                    </Link>
                    <Link
                      to="/admin/diagnose-unassessed"
                      class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                      onClick={closeAdminMenu}
                    >
                      Diagnose Unassessed
                    </Link>
                    <Link
                      to="/admin/setup_stats"
                      class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                      onClick={closeAdminMenu}
                    >
                      Setup/Stats
                    </Link>
                  </div>
                </div>
                <div class="flex flex-col gap-4">
                  <div class="text-xs font-semibold uppercase tracking-wide text-gray-500">Admin</div>
                  <div class="flex flex-col gap-1">
                    <Link
                      to="/admin/users"
                      class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                      onClick={closeAdminMenu}
                    >
                      Users
                    </Link>
                    <Link
                      to="/admin/prompts/deduplicate"
                      class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                      onClick={closeAdminMenu}
                    >
                      Prompts
                    </Link>
                    <Link
                      to="/admin/aa-models"
                      class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                      onClick={closeAdminMenu}
                    >
                      AI Models
                    </Link>
                  </div>
                </div>
              </div>
              <div class="flex items-stretch gap-4">
                <Link
                  to="/admin/jobs"
                  class="flex h-full w-44 sm:w-52 md:w-60 flex-col justify-between rounded-xl border border-stone-200 bg-white/60 px-6 py-6 font-semibold text-gray-900 hover:bg-white"
                  onClick={closeAdminMenu}
                >
                  <div class="text-lg font-semibold">Jobs</div>
                </Link>
                <Link
                  to="/admin/llm"
                  class="flex h-full w-44 sm:w-52 md:w-60 flex-col justify-between rounded-xl border border-stone-200 bg-white/60 px-6 py-6 font-semibold text-gray-900 hover:bg-white"
                  onClick={closeAdminMenu}
                >
                  <div class="text-lg font-semibold">LLM Metrics</div>
                </Link>
              </div>
            </div>
          </div>
        </div>
      </Show>
    </nav>
  )
}
