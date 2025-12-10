import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {formatDate} from 'date-fns'
import {createSignal, For, Show, Suspense} from 'solid-js'

import {apiClient} from '../../../../services/apiClient.ts'
import {fetchSession} from '../../../../services/fetchSession.ts'

type PromptUsage = {projects: number; judgments: number; humanJudgments: number}
type PromptSummary = {
  id: string
  promptHeading: string | null
  originalText: string | null
  type: string | null
  createdAt: string | Date
  usage: PromptUsage
}

type DuplicateGroup = PromptSummary[]
type OrphansResponse = {
  noProjects: PromptSummary[]
  noJudgments: PromptSummary[]
  noProjectsAndJudgments?: PromptSummary[]
}

const readUsage = (value: unknown): PromptUsage => {
  if (!value || typeof value !== 'object') return {projects: 0, judgments: 0, humanJudgments: 0}
  const obj = value as Record<string, unknown>
  const readCount = (n: unknown) => {
    return typeof n === 'number' ? n : 0
  }
  return {
    projects: readCount(obj.projects),
    judgments: readCount(obj.judgments),
    humanJudgments: readCount(obj.humanJudgments),
  }
}

const toPromptSummary = (value: unknown): PromptSummary | null => {
  if (!value || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  const id = typeof obj.id === 'string' ? obj.id : ''
  if (!id) return null
  const createdAt = obj.createdAt instanceof Date || typeof obj.createdAt === 'string' ? obj.createdAt : ''
  return {
    id,
    promptHeading: typeof obj.promptHeading === 'string' ? obj.promptHeading : null,
    originalText: typeof obj.originalText === 'string' ? obj.originalText : null,
    type: typeof obj.type === 'string' ? obj.type : null,
    createdAt,
    usage: readUsage(obj.usage),
  }
}

const isPromptSummary = (value: PromptSummary | null): value is PromptSummary => {
  return Boolean(value)
}

const fetchDuplicates = async (): Promise<DuplicateGroup[]> => {
  const response = await apiClient.api.prompts.duplicates.get()

  if (response.error) {
    console.error('Error fetching duplicates:', response.error)
    throw new Error('Failed to fetch duplicates')
  }

  const data = response.data?.data
  if (!Array.isArray(data)) return []
  return data
    .map((group) => {
      if (!Array.isArray(group)) return []
      return group.map(toPromptSummary).filter(isPromptSummary)
    })
    .filter((group) => {
      return group.length > 0
    })
}

const fetchOrphans = async (): Promise<OrphansResponse> => {
  const response = await apiClient.api.prompts.orphans.get()

  if (response.error) {
    console.error('Error fetching orphans:', response.error)
    throw new Error('Failed to fetch orphans')
  }

  const data = response.data?.data
  if (!data || typeof data !== 'object') return {noProjects: [], noJudgments: []}
  const obj = data as Record<string, unknown>
  const readList = (value: unknown): PromptSummary[] => {
    if (!Array.isArray(value)) return []
    return value.map(toPromptSummary).filter(isPromptSummary)
  }
  return {noProjects: readList(obj.noProjects), noJudgments: readList(obj.noJudgments)}
}

type InvalidJudgment = {
  id: string
  articleId: string
  promptId: string
  promptHeading: string | null
  promptType: string | null
  answeredOriginal: string | null
  answeredOriginalAsArray: string[] | null
  createdAt: string | Date
}

const fetchInvalidJudgments = async (): Promise<InvalidJudgment[]> => {
  const response = await apiClient.api.prompts['invalid-judgments'].get()

  if (response.error) {
    console.error('Error fetching invalid judgments:', response.error)
    throw new Error('Failed to fetch invalid judgments')
  }

  const data = response.data?.data
  if (!Array.isArray(data)) return []
  return data as InvalidJudgment[]
}

const DeduplicatePrompts = () => {
  const sessionQuery = useQuery(() => {
    return {queryKey: ['session'], queryFn: fetchSession}
  })

  const duplicatesQuery = useQuery(() => {
    return {queryKey: ['prompts', 'duplicates'], queryFn: fetchDuplicates}
  })

  const hasDuplicateGroups = () => {
    return (duplicatesQuery.data ?? []).length > 0
  }

  const orphansQuery = useQuery(() => {
    return {queryKey: ['prompts', 'orphans'], queryFn: fetchOrphans}
  })

  const invalidJudgmentsQuery = useQuery(() => {
    return {queryKey: ['prompts', 'invalid-judgments'], queryFn: fetchInvalidJudgments}
  })

  const isAdmin = () => {
    return sessionQuery.data?.user?.role === 'admin'
  }

  const [selectedKeepIds, setSelectedKeepIds] = createSignal<Record<string, string>>({})
  const [processingGroups, setProcessingGroups] = createSignal<Record<string, boolean>>({})
  const [deletingPrompts, setDeletingPrompts] = createSignal<Record<string, boolean>>({})
  const [deletingInvalidJudgments, setDeletingInvalidJudgments] = createSignal(false)
  const [regeneratingHashes, setRegeneratingHashes] = createSignal(false)
  const [expandedSections, setExpandedSections] = createSignal<Record<string, boolean>>({
    invalidJudgments: true,
    noProjects: true,
    noJudgments: true,
    noProjectsAndJudgments: true,
  })

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => {
      return {...prev, [section]: !prev[section]}
    })
  }

  const handleMerge = async (groupIndex: number, prompts: PromptSummary[]) => {
    const keepId = selectedKeepIds()[groupIndex]
    if (!keepId) {
      alert('Please select a prompt to keep.')
      return
    }

    if (!confirm('Are you sure you want to merge these prompts? This action cannot be undone.')) {
      return
    }

    const mergeIds = prompts
      .filter((p) => {
        return p.id !== keepId
      })
      .map((p) => {
        return p.id
      })

    setProcessingGroups((prev) => {
      return {...prev, [groupIndex]: true}
    })

    try {
      const response = await apiClient.api.prompts.merge.post({keepPromptId: keepId, mergePromptIds: mergeIds})

      if (response.error) {
        console.error('Merge failed:', response.error)
        alert('Merge failed. Check console for details.')
      } else {
        alert('Prompts merged successfully.')
        void duplicatesQuery.refetch()
        void orphansQuery.refetch()
      }
    } catch (error) {
      console.error('Merge error:', error)
      alert('An error occurred during merge.')
    } finally {
      setProcessingGroups((prev) => {
        return {...prev, [groupIndex]: false}
      })
    }
  }

  const handleDelete = async (promptId: string) => {
    if (!confirm('Are you sure you want to delete this orphaned prompt? This action cannot be undone.')) {
      return
    }

    setDeletingPrompts((prev) => {
      return {...prev, [promptId]: true}
    })

    try {
      const response = await apiClient.api.prompts({id: promptId}).delete()

      if (response.error) {
        console.error('Delete failed:', response.error)
        alert('Delete failed. It might not be fully orphaned.')
      } else {
        alert('Prompt deleted successfully.')
        void orphansQuery.refetch()
        void duplicatesQuery.refetch()
      }
    } catch (error) {
      console.error('Delete error:', error)
      alert('An error occurred during deletion.')
    } finally {
      setDeletingPrompts((prev) => {
        return {...prev, [promptId]: false}
      })
    }
  }

  const isFullyOrphaned = (promptId: string) => {
    const noProjects = orphansQuery.data?.noProjects || []
    const noJudgments = orphansQuery.data?.noJudgments || []

    const inNoProjects = noProjects.some((p) => {
      return p.id === promptId
    })
    const inNoJudgments = noJudgments.some((p) => {
      return p.id === promptId
    })

    return inNoProjects && inNoJudgments
  }

  const regenerateHashes = async () => {
    setRegeneratingHashes(true)
    try {
      const response = await apiClient.api.prompts['regenerate-hashes'].post()

      if (response.error) {
        console.error('Regenerate hashes failed:', response.error)
        alert('Failed to regenerate prompt hashes.')
        return
      }

      alert('Prompt hashes regenerated.')
      void duplicatesQuery.refetch()
      void orphansQuery.refetch()
    } catch (error) {
      console.error('Regenerate hashes error:', error)
      alert('An error occurred while regenerating hashes.')
    } finally {
      setRegeneratingHashes(false)
    }
  }

  const handleDeleteInvalidJudgments = async () => {
    const judgments = invalidJudgmentsQuery.data ?? []
    if (judgments.length === 0) {
      alert('No invalid judgments to delete.')
      return
    }

    if (
      !confirm(`Are you sure you want to delete ${judgments.length} invalid judgments? This action cannot be undone.`)
    ) {
      return
    }

    setDeletingInvalidJudgments(true)
    try {
      const judgmentIds = judgments.map((j) => {
        return j.id
      })
      const response = await apiClient.api.prompts['delete-invalid-judgments'].post({judgmentIds})

      if (response.error) {
        console.error('Delete invalid judgments failed:', response.error)
        alert('Failed to delete invalid judgments.')
        return
      }

      alert(`Successfully deleted ${judgments.length} invalid judgments.`)
      void invalidJudgmentsQuery.refetch()
    } catch (error) {
      console.error('Delete invalid judgments error:', error)
      alert('An error occurred while deleting invalid judgments.')
    } finally {
      setDeletingInvalidJudgments(false)
    }
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <Suspense
        fallback={
          <div class="flex items-center justify-center h-64">
            <span class="text-gray-600">Loading...</span>
          </div>
        }
      >
        <Show
          when={isAdmin()}
          fallback={
            <div class="bg-white border border-gray-200 rounded-lg shadow-sm max-w-xl mx-auto p-10 text-center">
              <h1 class="text-2xl font-semibold text-gray-900 mb-2">Administrator Access Required</h1>
              <p class="text-gray-500 mb-6">You need administrator privileges to view this page.</p>
              <Link
                to="/"
                class="inline-flex items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Go back home
              </Link>
            </div>
          }
        >
          <div class="flex justify-between items-center mb-6">
            <h1 class="text-2xl font-bold">Prompts</h1>
            <button
              onClick={() => {
                return void regenerateHashes()
              }}
              disabled={hasDuplicateGroups() || duplicatesQuery.isLoading || regeneratingHashes()}
              class={`inline-flex items-center px-4 py-2 rounded-md text-sm font-medium focus:outline-none focus:ring-2 focus:ring-offset-1 ${
                hasDuplicateGroups() || duplicatesQuery.isLoading || regeneratingHashes()
                  ? 'bg-gray-200 text-gray-500 cursor-not-allowed'
                  : 'bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500'
              }`}
            >
              {regeneratingHashes() ? 'Regenerating...' : 'Regenerate Prompt Hashes'}
            </button>
          </div>

          <div class="space-y-8">
            <Show when={duplicatesQuery.isLoading}>
              <p class="text-muted-foreground">Loading duplicates...</p>
            </Show>

            <Show when={duplicatesQuery.isError}>
              <div class="p-4 rounded-md bg-red-50 border border-red-200">
                <p class="text-red-600">Failed to load duplicates</p>
                <button
                  onClick={() => {
                    return void duplicatesQuery.refetch()
                  }}
                  class="mt-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
                >
                  Retry
                </button>
              </div>
            </Show>

            <Show when={!duplicatesQuery.isLoading && !duplicatesQuery.isError && duplicatesQuery.data?.length === 0}>
              <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
                <h3 class="text-lg font-medium text-gray-900 mb-2">No duplicate prompts found</h3>
                <p class="text-sm text-gray-500">All prompts seem to be unique based on their content.</p>
              </div>
            </Show>

            <For each={duplicatesQuery.data}>
              {(group, index) => {
                return (
                  <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                    <div class="mb-4">
                      <h3 class="text-lg font-semibold text-gray-900">Duplicate Group #{index() + 1}</h3>
                      <div class="text-sm text-gray-500 mt-1">
                        <span class="font-medium">Heading:</span> {group[0].promptHeading || 'N/A'} |{' '}
                        <span class="font-medium">Type:</span> {group[0].type || 'N/A'}
                      </div>
                      <div class="mt-2 p-3 bg-gray-50 rounded text-sm font-mono whitespace-pre-wrap max-h-32 overflow-y-auto border border-gray-200">
                        {group[0].originalText}
                      </div>
                    </div>

                    <div class="overflow-x-auto">
                      <table class="min-w-full divide-y divide-gray-200 table-fixed w-full">
                        <thead class="bg-gray-50">
                          <tr>
                            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Keep
                            </th>
                            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              ID
                            </th>
                            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Created At
                            </th>
                            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Projects
                            </th>
                            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Judgments
                            </th>
                            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Human Judgments
                            </th>
                          </tr>
                        </thead>
                        <tbody class="bg-white divide-y divide-gray-200">
                          <For each={group}>
                            {(prompt) => {
                              return (
                                <tr
                                  class={selectedKeepIds()[index()] === prompt.id ? 'bg-blue-50' : 'hover:bg-gray-50'}
                                >
                                  <td class="px-6 py-4 whitespace-nowrap">
                                    <input
                                      type="radio"
                                      name={`group-${index()}`}
                                      value={prompt.id}
                                      checked={selectedKeepIds()[index()] === prompt.id}
                                      onChange={() => {
                                        return setSelectedKeepIds((prev) => {
                                          return {...prev, [index()]: prompt.id}
                                        })
                                      }}
                                      class="focus:ring-blue-500 h-4 w-4 text-blue-600 border-gray-300"
                                    />
                                  </td>
                                  <td class="px-6 py-4 text-sm text-gray-500 font-mono break-all w-32">{prompt.id}</td>
                                  <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                                    {formatDate(new Date(prompt.createdAt), 'yyyy-MM-dd HH:mm')}
                                  </td>
                                  <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                                    {prompt.usage.projects}
                                  </td>
                                  <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                                    {prompt.usage.judgments}
                                  </td>
                                  <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                                    {prompt.usage.humanJudgments}
                                  </td>
                                </tr>
                              )
                            }}
                          </For>
                        </tbody>
                      </table>
                    </div>

                    <div class="mt-4 flex justify-end">
                      <button
                        onClick={() => {
                          void handleMerge(index(), group)
                        }}
                        disabled={!selectedKeepIds()[index()] || processingGroups()[index()]}
                        class={`px-4 py-2 rounded-md text-white text-sm font-medium focus:outline-none focus:ring-2 focus:ring-offset-1 ${
                          !selectedKeepIds()[index()] || processingGroups()[index()]
                            ? 'bg-gray-400 cursor-not-allowed'
                            : 'bg-blue-600 hover:bg-blue-700 focus:ring-blue-500'
                        }`}
                      >
                        {processingGroups()[index()] ? 'Merging...' : 'Merge Duplicates'}
                      </button>
                    </div>
                  </div>
                )
              }}
            </For>

            <div class="mt-12 space-y-8">
              <h2 class="text-xl font-bold text-gray-900">Invalid Judgments</h2>
              <p class="text-sm text-gray-500">
                Judgments where the answer doesn't match the expected prompt type (e.g., 'maybe' when the type is 'yes'
                | 'no' | 'unsure').
              </p>

              <div class="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
                <div
                  class="px-6 py-4 border-b border-gray-200 bg-gray-50 flex justify-between items-center cursor-pointer"
                  onClick={() => {
                    return toggleSection('invalidJudgments')
                  }}
                >
                  <h3 class="text-lg font-semibold text-gray-900">
                    Judgments with Mismatched Answer Types ({invalidJudgmentsQuery.data?.length ?? 0})
                  </h3>
                  <button class="text-gray-500 hover:text-gray-700">
                    {expandedSections().invalidJudgments ? (
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                        <path
                          fill-rule="evenodd"
                          d="M14.707 12.707a1 1 0 01-1.414 0L10 9.414l-3.293 3.293a1 1 0 01-1.414-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 010 1.414z"
                          clip-rule="evenodd"
                        />
                      </svg>
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                        <path
                          fill-rule="evenodd"
                          d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
                          clip-rule="evenodd"
                        />
                      </svg>
                    )}
                  </button>
                </div>
                <Show when={expandedSections().invalidJudgments}>
                  <div class="p-4 border-b border-gray-200 bg-gray-50">
                    <button
                      onClick={() => {
                        return void handleDeleteInvalidJudgments()
                      }}
                      disabled={
                        deletingInvalidJudgments()
                        || invalidJudgmentsQuery.isLoading
                        || (invalidJudgmentsQuery.data?.length ?? 0) === 0
                      }
                      class={`px-4 py-2 rounded-md text-white text-sm font-medium focus:outline-none focus:ring-2 focus:ring-offset-1 ${
                        deletingInvalidJudgments()
                        || invalidJudgmentsQuery.isLoading
                        || (invalidJudgmentsQuery.data?.length ?? 0) === 0
                          ? 'bg-gray-400 cursor-not-allowed'
                          : 'bg-red-600 hover:bg-red-700 focus:ring-red-500'
                      }`}
                    >
                      {deletingInvalidJudgments()
                        ? 'Deleting...'
                        : `Delete All ${invalidJudgmentsQuery.data?.length ?? 0} Invalid Judgments`}
                    </button>
                  </div>
                  <div class="overflow-x-auto">
                    <table class="min-w-full divide-y divide-gray-200 table-fixed w-full">
                      <thead class="bg-gray-50">
                        <tr>
                          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Judgment ID
                          </th>
                          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Prompt
                          </th>
                          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Expected Type
                          </th>
                          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            answeredOriginal
                          </th>
                          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            answeredOriginalAsArray
                          </th>
                          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Created At
                          </th>
                        </tr>
                      </thead>
                      <tbody class="bg-white divide-y divide-gray-200">
                        <Show
                          when={invalidJudgmentsQuery.data && invalidJudgmentsQuery.data.length > 0}
                          fallback={
                            <tr>
                              <td colspan="6" class="px-6 py-4 text-center text-sm text-gray-500">
                                {invalidJudgmentsQuery.isLoading
                                  ? 'Loading...'
                                  : 'No invalid judgments found. All judgment answers match their prompt types.'}
                              </td>
                            </tr>
                          }
                        >
                          <For each={invalidJudgmentsQuery.data}>
                            {(judgment) => {
                              return (
                                <tr class="hover:bg-gray-50">
                                  <td class="px-6 py-4 text-sm text-gray-500 font-mono break-all">{judgment.id}</td>
                                  <td class="px-6 py-4 text-sm text-gray-900 break-words">
                                    <div class="max-h-[60px] overflow-y-auto">
                                      {judgment.promptHeading || judgment.promptId.slice(0, 8)}
                                    </div>
                                  </td>
                                  <td class="px-6 py-4 text-sm text-gray-500 break-words">
                                    <div class="max-h-[60px] overflow-y-auto font-mono text-xs">
                                      {judgment.promptType || 'N/A'}
                                    </div>
                                  </td>
                                  <td class="px-6 py-4 text-sm text-red-600 font-medium break-words">
                                    <div class="max-h-[60px] overflow-y-auto">
                                      {judgment.answeredOriginal || <span class="text-gray-400 italic">null</span>}
                                    </div>
                                  </td>
                                  <td class="px-6 py-4 text-sm text-red-600 font-medium break-words">
                                    <div class="max-h-[60px] overflow-y-auto">
                                      {judgment.answeredOriginalAsArray !== null ? (
                                        `[${judgment.answeredOriginalAsArray.join(', ')}]`
                                      ) : (
                                        <span class="text-gray-400 italic">null</span>
                                      )}
                                    </div>
                                  </td>
                                  <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                                    {formatDate(new Date(judgment.createdAt), 'yyyy-MM-dd HH:mm')}
                                  </td>
                                </tr>
                              )
                            }}
                          </For>
                        </Show>
                      </tbody>
                    </table>
                  </div>
                </Show>
              </div>
            </div>

            <div class="mt-12 space-y-8">
              <h2 class="text-xl font-bold text-gray-900">Orphaned Prompts</h2>

              <div class="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
                <div
                  class="px-6 py-4 border-b border-gray-200 bg-gray-50 flex justify-between items-center cursor-pointer"
                  onClick={() => {
                    return toggleSection('noProjects')
                  }}
                >
                  <h3 class="text-lg font-semibold text-gray-900">Prompts with No Project Connection</h3>
                  <button class="text-gray-500 hover:text-gray-700">
                    {expandedSections().noProjects ? (
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                        <path
                          fill-rule="evenodd"
                          d="M14.707 12.707a1 1 0 01-1.414 0L10 9.414l-3.293 3.293a1 1 0 01-1.414-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 010 1.414z"
                          clip-rule="evenodd"
                        />
                      </svg>
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                        <path
                          fill-rule="evenodd"
                          d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
                          clip-rule="evenodd"
                        />
                      </svg>
                    )}
                  </button>
                </div>
                <Show when={expandedSections().noProjects}>
                  <div class="overflow-x-auto">
                    <table class="min-w-full divide-y divide-gray-200 table-fixed w-full">
                      <thead class="bg-gray-50">
                        <tr>
                          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            ID
                          </th>
                          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Heading
                          </th>
                          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Type
                          </th>
                          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Created At
                          </th>
                          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Content Preview
                          </th>
                          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Actions
                          </th>
                        </tr>
                      </thead>
                      <tbody class="bg-white divide-y divide-gray-200">
                        <Show
                          when={orphansQuery.data?.noProjects?.length > 0}
                          fallback={
                            <tr>
                              <td colspan="6" class="px-6 py-4 text-center text-sm text-gray-500">
                                No prompts found without project connections.
                              </td>
                            </tr>
                          }
                        >
                          <For each={orphansQuery.data?.noProjects}>
                            {(prompt) => {
                              const fullyOrphaned = isFullyOrphaned(prompt.id)
                              return (
                                <tr class="hover:bg-gray-50">
                                  <td class="px-6 py-4 text-sm text-gray-500 font-mono break-all w-32">{prompt.id}</td>
                                  <td class="px-6 py-4 text-sm text-gray-900 break-words">
                                    <div class="max-h-[100px] overflow-y-auto">{prompt.promptHeading || 'N/A'}</div>
                                  </td>
                                  <td class="px-6 py-4 text-sm text-gray-900 break-words">
                                    <div class="max-h-[100px] overflow-y-auto">{prompt.type || 'N/A'}</div>
                                  </td>
                                  <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                                    {formatDate(new Date(prompt.createdAt), 'yyyy-MM-dd HH:mm')}
                                  </td>
                                  <td class="px-6 py-4 text-sm text-gray-500 max-w-xs break-words">
                                    <div class="max-h-[100px] overflow-y-auto" title={prompt.originalText}>
                                      {prompt.originalText}
                                    </div>
                                  </td>
                                  <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                                    <Show when={fullyOrphaned}>
                                      <button
                                        onClick={() => {
                                          void handleDelete(prompt.id)
                                        }}
                                        disabled={deletingPrompts()[prompt.id]}
                                        class="text-red-600 hover:text-red-900 font-medium disabled:opacity-50"
                                      >
                                        {deletingPrompts()[prompt.id] ? 'Deleting...' : 'Delete'}
                                      </button>
                                    </Show>
                                  </td>
                                </tr>
                              )
                            }}
                          </For>
                        </Show>
                      </tbody>
                    </table>
                  </div>
                </Show>
              </div>

              <div class="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
                <div
                  class="px-6 py-4 border-b border-gray-200 bg-gray-50 flex justify-between items-center cursor-pointer"
                  onClick={() => {
                    return toggleSection('noJudgments')
                  }}
                >
                  <h3 class="text-lg font-semibold text-gray-900">Prompts with No Judgment Connection</h3>
                  <button class="text-gray-500 hover:text-gray-700">
                    {expandedSections().noJudgments ? (
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                        <path
                          fill-rule="evenodd"
                          d="M14.707 12.707a1 1 0 01-1.414 0L10 9.414l-3.293 3.293a1 1 0 01-1.414-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 010 1.414z"
                          clip-rule="evenodd"
                        />
                      </svg>
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                        <path
                          fill-rule="evenodd"
                          d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
                          clip-rule="evenodd"
                        />
                      </svg>
                    )}
                  </button>
                </div>
                <Show when={expandedSections().noJudgments}>
                  <div class="overflow-x-auto">
                    <table class="min-w-full divide-y divide-gray-200 table-fixed w-full">
                      <thead class="bg-gray-50">
                        <tr>
                          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            ID
                          </th>
                          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Heading
                          </th>
                          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Type
                          </th>
                          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Created At
                          </th>
                          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Content Preview
                          </th>
                          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Actions
                          </th>
                        </tr>
                      </thead>
                      <tbody class="bg-white divide-y divide-gray-200">
                        <Show
                          when={orphansQuery.data?.noJudgments?.length > 0}
                          fallback={
                            <tr>
                              <td colspan="6" class="px-6 py-4 text-center text-sm text-gray-500">
                                No prompts found without judgment connections.
                              </td>
                            </tr>
                          }
                        >
                          <For each={orphansQuery.data?.noJudgments}>
                            {(prompt) => {
                              const fullyOrphaned = isFullyOrphaned(prompt.id)
                              return (
                                <tr class="hover:bg-gray-50">
                                  <td class="px-6 py-4 text-sm text-gray-500 font-mono break-all w-32">{prompt.id}</td>
                                  <td class="px-6 py-4 text-sm text-gray-900 break-words">
                                    <div class="max-h-[100px] overflow-y-auto">{prompt.promptHeading || 'N/A'}</div>
                                  </td>
                                  <td class="px-6 py-4 text-sm text-gray-900 break-words">
                                    <div class="max-h-[100px] overflow-y-auto">{prompt.type || 'N/A'}</div>
                                  </td>
                                  <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                                    {formatDate(new Date(prompt.createdAt), 'yyyy-MM-dd HH:mm')}
                                  </td>
                                  <td class="px-6 py-4 text-sm text-gray-500 max-w-xs break-words">
                                    <div class="max-h-[100px] overflow-y-auto" title={prompt.originalText}>
                                      {prompt.originalText}
                                    </div>
                                  </td>
                                  <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                                    <Show when={fullyOrphaned}>
                                      <button
                                        onClick={() => {
                                          void handleDelete(prompt.id)
                                        }}
                                        disabled={deletingPrompts()[prompt.id]}
                                        class="text-red-600 hover:text-red-900 font-medium disabled:opacity-50"
                                      >
                                        {deletingPrompts()[prompt.id] ? 'Deleting...' : 'Delete'}
                                      </button>
                                    </Show>
                                  </td>
                                </tr>
                              )
                            }}
                          </For>
                        </Show>
                      </tbody>
                    </table>
                  </div>
                </Show>
              </div>

              <div class="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
                <div
                  class="px-6 py-4 border-b border-gray-200 bg-gray-50 flex justify-between items-center cursor-pointer"
                  onClick={() => {
                    return toggleSection('noProjectsAndJudgments')
                  }}
                >
                  <h3 class="text-lg font-semibold text-gray-900">
                    Prompts with No Project Connection and No Judgments
                  </h3>
                  <button class="text-gray-500 hover:text-gray-700">
                    {expandedSections().noProjectsAndJudgments ? (
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                        <path
                          fill-rule="evenodd"
                          d="M14.707 12.707a1 1 0 01-1.414 0L10 9.414l-3.293 3.293a1 1 0 01-1.414-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 010 1.414z"
                          clip-rule="evenodd"
                        />
                      </svg>
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                        <path
                          fill-rule="evenodd"
                          d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
                          clip-rule="evenodd"
                        />
                      </svg>
                    )}
                  </button>
                </div>
                <Show when={expandedSections().noProjectsAndJudgments}>
                  <div class="overflow-x-auto">
                    <table class="min-w-full divide-y divide-gray-200 table-fixed w-full">
                      <thead class="bg-gray-50">
                        <tr>
                          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            ID
                          </th>
                          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Heading
                          </th>
                          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Type
                          </th>
                          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Created At
                          </th>
                          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Content Preview
                          </th>
                          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Actions
                          </th>
                        </tr>
                      </thead>
                      <tbody class="bg-white divide-y divide-gray-200">
                        <Show
                          when={orphansQuery.data?.noProjectsAndJudgments?.length > 0}
                          fallback={
                            <tr>
                              <td colspan="6" class="px-6 py-4 text-center text-sm text-gray-500">
                                No fully orphaned prompts found.
                              </td>
                            </tr>
                          }
                        >
                          <For each={orphansQuery.data?.noProjectsAndJudgments}>
                            {(prompt) => {
                              return (
                                <tr class="hover:bg-gray-50">
                                  <td class="px-6 py-4 text-sm text-gray-500 font-mono break-all w-32">{prompt.id}</td>
                                  <td class="px-6 py-4 text-sm text-gray-900 break-words">
                                    <div class="max-h-[100px] overflow-y-auto">{prompt.promptHeading || 'N/A'}</div>
                                  </td>
                                  <td class="px-6 py-4 text-sm text-gray-900 break-words">
                                    <div class="max-h-[100px] overflow-y-auto">{prompt.type || 'N/A'}</div>
                                  </td>
                                  <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                                    {formatDate(new Date(prompt.createdAt), 'yyyy-MM-dd HH:mm')}
                                  </td>
                                  <td class="px-6 py-4 text-sm text-gray-500 max-w-xs break-words">
                                    <div class="max-h-[100px] overflow-y-auto" title={prompt.originalText}>
                                      {prompt.originalText}
                                    </div>
                                  </td>
                                  <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                                    <button
                                      onClick={() => {
                                        void handleDelete(prompt.id)
                                      }}
                                      disabled={deletingPrompts()[prompt.id]}
                                      class="text-red-600 hover:text-red-900 font-medium disabled:opacity-50"
                                    >
                                      {deletingPrompts()[prompt.id] ? 'Deleting...' : 'Delete'}
                                    </button>
                                  </td>
                                </tr>
                              )
                            }}
                          </For>
                        </Show>
                      </tbody>
                    </table>
                  </div>
                </Show>
              </div>
            </div>
          </div>
        </Show>
      </Suspense>
    </div>
  )
}

export const Route = createFileRoute('/admin/prompts/deduplicate')({component: DeduplicatePrompts})
