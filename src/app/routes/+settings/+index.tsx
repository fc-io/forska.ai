import {useQuery} from '@tanstack/solid-query'
import {createFileRoute} from '@tanstack/solid-router'
import {createEffect, createSignal, onCleanup, Show} from 'solid-js'

import {apiClient} from '../../../services/apiClient'
import {handleApiResponse} from '../../../services/utils/handleApiResponse'

type LocalUser = {id: string; name: string; email: string; role?: string | null; openalexMailto?: string | null}
type UsersResponse = {data: LocalUser[]}
type CodexCliStatus = {ok: boolean; loggedIn: boolean; method: 'chatgpt' | 'api-key' | null; raw: string}
type CodexStatus = {codexBin: string; cli: CodexCliStatus; appServerReady: boolean; message: string}
type CodexStatusResponse = {data: CodexStatus; error: null}
type CodexDeviceLoginJob = {
  id: string
  state: 'running' | 'completed' | 'failed'
  startedAt: string
  finishedAt: string | null
  exitCode: number | null
  signal: string | null
  output: string[]
  deviceUrl: string | null
  deviceCode: string | null
  error: string | null
}
type StartCodexLoginResponse = {data: {started: boolean; job: CodexDeviceLoginJob | null; message: string}; error: null}
type CodexLoginJobResponse = {data: CodexDeviceLoginJob; error: null}

const fetchLocalUser = async (): Promise<LocalUser | null> => {
  const response = await apiClient.api.users.get()
  const result = handleApiResponse<UsersResponse>(response, 'Failed to load local user')
  return result.data?.[0] ?? null
}

const Settings = () => {
  const [displayName, setDisplayName] = createSignal('')
  const [openalexMailto, setOpenalexMailto] = createSignal('')
  const localUserQuery = useQuery(() => {
    return {queryKey: ['local-user'], queryFn: fetchLocalUser, staleTime: 5 * 60 * 1000}
  })

  const codexStatusQuery = useQuery(() => {
    return {
      queryKey: ['codex-status'],
      queryFn: async () => {
        const response = await apiClient.api.models.codex.status.get()
        const result = handleApiResponse<CodexStatusResponse>(
          response as unknown as {data?: CodexStatusResponse; error?: unknown; status?: number},
          'Failed to load Codex status',
        )
        return result.data
      },
      staleTime: 60 * 1000,
      refetchOnWindowFocus: false,
    }
  })

  const [codexLoginJobId, setCodexLoginJobId] = createSignal<string | null>(null)
  const [codexLoginJob, setCodexLoginJob] = createSignal<CodexDeviceLoginJob | null>(null)
  const [isStartingCodexLogin, setIsStartingCodexLogin] = createSignal(false)
  const [codexLoginError, setCodexLoginError] = createSignal('')

  const fetchCodexLoginJob = async (jobId: string): Promise<CodexDeviceLoginJob> => {
    const response = await apiClient.api.models.codex.login({jobId}).get()
    const result = handleApiResponse<CodexLoginJobResponse>(
      response as unknown as {data?: CodexLoginJobResponse; error?: unknown; status?: number},
      'Failed to fetch Codex login job',
    )
    return result.data
  }

  createEffect(() => {
    const jobId = codexLoginJobId()
    const job = codexLoginJob()
    const isRunning = Boolean(jobId && job?.state === 'running')
    if (!jobId || !isRunning) return

    const interval = setInterval(() => {
      void fetchCodexLoginJob(jobId)
        .then((updated) => {
          setCodexLoginJob(updated)
          if (updated.state !== 'running') {
            void codexStatusQuery.refetch()
          }
        })
        .catch((error) => {
          setCodexLoginError(error instanceof Error ? error.message : 'Failed to fetch Codex login job')
        })
    }, 1000)

    onCleanup(() => {
      clearInterval(interval)
    })
  })

  createEffect(() => {
    const name = localUserQuery.data?.name ?? ''
    const mailto = localUserQuery.data?.openalexMailto ?? ''
    setDisplayName(name)
    setOpenalexMailto(mailto)
  })

  const startCodexLogin = async () => {
    setIsStartingCodexLogin(true)
    setCodexLoginError('')
    try {
      const response = await apiClient.api.models.codex.login.post()
      const result = handleApiResponse<StartCodexLoginResponse>(
        response as unknown as {data?: StartCodexLoginResponse; error?: unknown; status?: number},
        'Failed to start Codex login',
      )
      const job = result.data.job
      if (!job) {
        void codexStatusQuery.refetch()
        setIsStartingCodexLogin(false)
        return
      }

      setCodexLoginJobId(job.id)
      setCodexLoginJob(job)
    } catch (error) {
      setCodexLoginError(error instanceof Error ? error.message : 'Failed to start Codex login')
    } finally {
      setIsStartingCodexLogin(false)
    }
  }

  return (
    <div class="p-6 max-w-4xl mx-auto">
      <h1 class="text-3xl font-bold mb-6">Settings</h1>

      <div class="space-y-6">
        <div class="bg-white border border-gray-200 rounded-lg shadow-sm p-6">
          <h2 class="text-xl font-semibold text-gray-900 mb-4">Local profile</h2>
          <Show when={localUserQuery.isLoading}>
            <p class="text-sm text-gray-600">Loading local profile...</p>
          </Show>
          <Show when={localUserQuery.isError}>
            <p class="text-sm text-red-600">
              {localUserQuery.error instanceof Error ? localUserQuery.error.message : 'Failed to load local profile'}
            </p>
          </Show>
          <Show when={!localUserQuery.isLoading && !localUserQuery.isError}>
            <div class="space-y-4">
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-2">Email</label>
                <input
                  type="email"
                  value={localUserQuery.data?.email || ''}
                  readonly
                  class="w-full px-3 py-3 border border-gray-300 rounded-md bg-gray-50 text-gray-500"
                />
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-2">Display Name</label>
                <input
                  type="text"
                  value={displayName()}
                  readonly
                  class="w-full px-3 py-3 border border-gray-300 rounded-md bg-gray-50 text-gray-500 sm:text-sm"
                />
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-2">OpenAlex Mailto</label>
                <input
                  type="email"
                  value={openalexMailto()}
                  readonly
                  class="w-full px-3 py-3 border border-gray-300 rounded-md bg-gray-50 text-gray-500 sm:text-sm"
                />
                <p class="mt-2 text-xs text-gray-500">
                  Used for OpenAlex imports. In no-auth mode this comes from `OPENALEX_MAILTO`.
                </p>
              </div>
            </div>
          </Show>
        </div>

        <div class="bg-white border border-gray-200 rounded-lg shadow-sm p-6">
          <h2 class="text-xl font-semibold text-gray-900 mb-4">Codex</h2>
          <div class="space-y-3">
            <Show when={codexStatusQuery.isLoading}>
              <p class="text-sm text-gray-600">Checking Codex status...</p>
            </Show>
            <Show when={codexStatusQuery.isError}>
              <p class="text-sm text-red-600">
                {codexStatusQuery.error instanceof Error
                  ? codexStatusQuery.error.message
                  : 'Failed to load Codex status'}
              </p>
            </Show>
            <Show when={!codexStatusQuery.isLoading && !codexStatusQuery.isError && codexStatusQuery.data}>
              <div class="text-sm text-gray-700">
                <span class="font-medium">Login:</span>{' '}
                <span class={codexStatusQuery.data?.cli.loggedIn ? 'text-green-700' : 'text-amber-700'}>
                  {codexStatusQuery.data?.cli.loggedIn
                    ? `Logged in${codexStatusQuery.data?.cli.method ? ` (${codexStatusQuery.data?.cli.method})` : ''}`
                    : 'Not logged in'}
                </span>
              </div>
              <div class="text-sm text-gray-700">
                <span class="font-medium">App-server:</span>{' '}
                <span class={codexStatusQuery.data?.appServerReady ? 'text-green-700' : 'text-amber-700'}>
                  {codexStatusQuery.data?.appServerReady ? 'Ready' : 'Not ready'}
                </span>
              </div>
              <p class="text-xs text-gray-600 font-mono break-all">{codexStatusQuery.data?.codexBin}</p>
              <p class="text-xs text-gray-600">{codexStatusQuery.data?.message}</p>

              <Show when={!codexStatusQuery.data?.cli.loggedIn}>
                <button
                  class="mt-2 px-4 py-3 bg-blue-600 text-white rounded-md shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 text-sm font-medium disabled:opacity-60 disabled:cursor-not-allowed"
                  disabled={isStartingCodexLogin()}
                  onClick={() => {
                    void startCodexLogin()
                  }}
                >
                  {isStartingCodexLogin() ? 'Starting Codex Login...' : 'Sign in to Codex'}
                </button>
              </Show>

              <Show when={codexLoginError()}>
                <p class="text-sm text-red-600">{codexLoginError()}</p>
              </Show>

              <Show when={codexLoginJob()}>
                <div class="mt-3 border border-gray-200 rounded-md bg-gray-50 p-4">
                  <p class="text-sm font-medium text-gray-900 mb-2">Device login</p>
                  <Show when={codexLoginJob()?.deviceUrl}>
                    <p class="text-sm text-gray-700">
                      Open:{' '}
                      <a
                        class="text-blue-700 underline"
                        href={codexLoginJob()?.deviceUrl ?? '#'}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {codexLoginJob()?.deviceUrl}
                      </a>
                    </p>
                  </Show>
                  <Show when={codexLoginJob()?.deviceCode}>
                    <p class="text-sm text-gray-700">
                      Code: <span class="font-mono">{codexLoginJob()?.deviceCode}</span>
                    </p>
                  </Show>

                  <pre class="mt-3 text-xs whitespace-pre-wrap font-mono text-gray-800">
                    {codexLoginJob()?.output.join('\n')}
                  </pre>

                  <Show when={codexLoginJob()?.state === 'completed'}>
                    <p class="mt-2 text-sm text-green-700">Login complete. Refreshing status...</p>
                  </Show>
                  <Show when={codexLoginJob()?.state === 'failed'}>
                    <p class="mt-2 text-sm text-red-700">Login failed: {codexLoginJob()?.error ?? 'Unknown error'}</p>
                  </Show>
                </div>
              </Show>
            </Show>
          </div>
        </div>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/settings/')({component: Settings})
