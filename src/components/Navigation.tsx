import {useQuery} from '@tanstack/solid-query'
import {Link, useLocation} from '@tanstack/solid-router'
import {createMemo, createSignal, onCleanup, onMount, Show} from 'solid-js'

import {duckdbOwnerConnectionsQueryKey, fetchDuckdbOwnerConnections} from '../utils/duckdbOwnerConnectionsQuery'
import type {LlmMetricsSummary, LlmStatusResponse} from '../utils/llmStatusQuery'
import {
  fetchLlmStatus,
  getLlmMetricsSummary,
  getLlmStatusRefetchInterval,
  llmStatusQueryKey,
} from '../utils/llmStatusQuery'

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
    ? 'Runtime-only LLM waiting / running requests across all workers'
    : 'Runtime-only LLM waiting / running requests across all workers (no metrics update in last 3m)'
}

const getLlmMetricsRefetchInterval = (pathname: string, response: LlmStatusResponse | undefined) => {
  return pathname.startsWith('/admin/llm') ? false : getLlmStatusRefetchInterval(response?.rows ?? [])
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
  const location = useLocation()

  const llmMetricsQuery = useQuery(() => {
    return {
      queryKey: llmStatusQueryKey,
      queryFn: fetchLlmStatus,
      refetchInterval: (query) => {
        return getLlmMetricsRefetchInterval(location().pathname, query.state.data ?? undefined)
      },
      suspense: false,
    }
  })

  const defaultLlmStatusResponse: LlmStatusResponse = {rows: [], hasMetricsCompatibleJob: false}

  const llmMetrics = () => {
    return getLlmMetricsSummary(llmMetricsQuery.data ?? defaultLlmStatusResponse)
  }

  const duckdbOwnerConnectionsQuery = useQuery(() => {
    return {
      queryKey: duckdbOwnerConnectionsQueryKey,
      queryFn: fetchDuckdbOwnerConnections,
      refetchInterval: 15_000,
      refetchOnReconnect: true,
      refetchOnWindowFocus: true,
      suspense: false,
    }
  })

  const llmMetricsIndicator = createMemo(() => {
    return getLlmMetricsIndicator(llmMetrics(), Date.now())
  })

  const duckdbOwnerWarning = createMemo(() => {
    return (
      duckdbOwnerConnectionsQuery.data?.warnings.find((warning) => {
        return warning.kind !== 'write-failure'
      }) ?? null
    )
  })

  const duckdbOwnerWarningClass = createMemo(() => {
    return duckdbOwnerWarning()?.severity === 'error'
      ? 'border-red-200 bg-red-50 text-red-800'
      : 'border-amber-200 bg-amber-50 text-amber-800'
  })

  const closeAdminMenu = () => {
    setIsAdminMenuOpen(false)
  }

  const toggleAdminMenu = () => {
    setIsAdminMenuOpen((previous) => {
      return !previous
    })
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
    <nav class="relative border-b border-gray-200 bg-white shadow-sm">
      <Show when={duckdbOwnerWarning()}>
        {(warning) => {
          return (
            <div class={`border-b px-4 py-2 text-sm ${duckdbOwnerWarningClass()}`}>
              <div class="mx-auto flex max-w-7xl items-center justify-between gap-4 sm:px-2 lg:px-4">
                <div>{warning().message}</div>
                <Link to="/admin/duckdb-owner-connections" class="shrink-0 font-semibold underline underline-offset-2">
                  Owner status
                </Link>
              </div>
            </div>
          )
        }}
      </Show>
      <div class="px-4 sm:px-6 lg:px-8">
        <div class="flex min-h-16 flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2 sm:h-16 sm:flex-nowrap sm:py-0">
          <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 sm:flex-nowrap sm:gap-x-8">
            <Link
              to="/"
              class="px-2 py-2 text-sm font-medium text-gray-900 hover:text-blue-600 sm:px-3 [&.active]:font-semibold [&.active]:text-blue-600"
            >
              Home
            </Link>
            <Link
              to="/prompts"
              class="px-2 py-2 text-sm font-medium text-gray-900 hover:text-blue-600 sm:px-3 [&.active]:font-semibold [&.active]:text-blue-600"
            >
              Prompts
            </Link>
            <Link
              to="/compare-judgments"
              class="px-2 py-2 text-sm font-medium text-gray-900 hover:text-blue-600 sm:px-3 [&.active]:font-semibold [&.active]:text-blue-600"
            >
              Compare Judgments
            </Link>
            <Link
              to="/articles"
              class="px-2 py-2 text-sm font-medium text-gray-900 hover:text-blue-600 sm:px-3 [&.active]:font-semibold [&.active]:text-blue-600"
            >
              Article Search
            </Link>
            <Link
              to="/settings"
              class="px-2 py-2 text-sm font-medium text-gray-900 hover:text-blue-600 sm:px-3 [&.active]:font-semibold [&.active]:text-blue-600"
            >
              Settings
            </Link>
          </div>
          <div class="flex shrink-0 items-center space-x-4">
            <Show when={llmMetrics()?.hasMetricsCompatibleJob}>
              <div
                class="flex flex-col items-end px-2 py-1"
                title={getLlmMetricsIndicatorTitle(llmMetricsIndicator().isFresh)}
              >
                <div class={`text-sm font-medium ${llmMetricsIndicator().isFresh ? 'text-gray-700' : 'text-red-600'}`}>
                  {llmMetricsIndicator().waiting}/{llmMetricsIndicator().running}
                </div>
                <div class={`text-xs ${llmMetricsIndicator().isFresh ? 'text-gray-400' : 'text-red-400'}`}>
                  Runtime waiting/running | {formatLastUpdate(llmMetricsIndicator().lastUpdate)}
                </div>
              </div>
            </Show>
            <div class="peer group relative -mx-2 flex h-full cursor-pointer select-none items-center px-2 sm:mr-4">
              <div aria-hidden="true" class="absolute left-0 right-0 top-full h-8" />
              <div
                class="relative z-10"
                role="button"
                tabIndex={0}
                aria-haspopup="true"
                aria-expanded={isAdminMenuOpen()}
                onClick={toggleAdminMenu}
              >
                <div
                  class={`rounded-md px-3 py-2 text-sm font-medium text-gray-700 group-hover:bg-stone-100 group-focus-within:bg-stone-100 group-hover:text-gray-900 group-focus-within:text-gray-900 ${
                    isAdminMenuOpen() ? 'bg-stone-100 text-gray-900' : ''
                  }`}
                >
                  Admin
                </div>
              </div>
            </div>
            <div
              class={`absolute left-0 right-0 top-full -mt-px z-50 border-t border-gray-200 bg-stone-100 opacity-0 shadow-sm transition-opacity delay-150 duration-100 hover:pointer-events-auto hover:visible hover:opacity-100 hover:delay-0 focus-within:pointer-events-auto focus-within:visible focus-within:opacity-100 focus-within:delay-0 peer-hover:pointer-events-auto peer-hover:visible peer-hover:opacity-100 peer-hover:delay-0 peer-focus-within:pointer-events-auto peer-focus-within:visible peer-focus-within:opacity-100 peer-focus-within:delay-0 ${
                isAdminMenuOpen()
                  ? 'pointer-events-auto visible opacity-100 delay-0'
                  : 'pointer-events-none invisible opacity-0 delay-150'
              }`}
            >
              <div class="px-4 py-6 sm:px-6 lg:px-8">
                <div class="flex min-h-64 flex-wrap items-stretch gap-6">
                  <div class="grid flex-1 grid-cols-1 gap-10 sm:grid-cols-2 lg:grid-cols-3">
                    <div class="flex flex-col gap-4">
                      <div class="text-xs font-semibold uppercase tracking-wide text-gray-500">Data</div>
                      <div class="flex flex-col gap-1">
                        <Link
                          to="/admin/assessments"
                          class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                          onClick={closeAdminMenu}
                        >
                          Human Assessments
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
                          to="/admin/setup_stats"
                          class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                          onClick={closeAdminMenu}
                        >
                          Setup/Stats
                        </Link>
                        <Link
                          to="/admin/duckdb-append"
                          class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                          onClick={closeAdminMenu}
                        >
                          DuckDB Append Metrics
                        </Link>
                        <Link
                          to="/settings"
                          class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                          onClick={closeAdminMenu}
                        >
                          Settings
                        </Link>
                      </div>
                    </div>
                    <div class="flex flex-col gap-4">
                      <div class="text-xs font-semibold uppercase tracking-wide text-gray-500">Admin</div>
                      <div class="flex flex-col gap-1">
                        <Link
                          to="/admin/datasources"
                          class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                          onClick={closeAdminMenu}
                        >
                          Data Sources
                        </Link>
                        <Link
                          to={'/providers' as never}
                          class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                          onClick={closeAdminMenu}
                        >
                          Providers
                        </Link>
                        <Link
                          to="/admin/duckdb-owner-connections"
                          class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                          onClick={closeAdminMenu}
                        >
                          DuckDB Owner Connections
                        </Link>
                        <Link
                          to="/admin/prompts/deduplicate"
                          class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                          onClick={closeAdminMenu}
                        >
                          Conflicting prompts and judgments
                        </Link>
                      </div>
                    </div>
                  </div>
                  <div class="flex flex-wrap items-stretch gap-4">
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
          </div>
        </div>
      </div>
    </nav>
  )
}
