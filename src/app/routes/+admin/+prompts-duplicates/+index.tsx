import {useQuery, useMutation} from '@tanstack/solid-query'
import {createFileRoute} from '@tanstack/solid-router'
import {createSignal, For, Show} from 'solid-js'

import {apiClient} from '../../../../services/apiClient'

export const AdminPromptsDuplicates = () => {
  const [selection, setSelection] = createSignal<Record<string, string>>({})

  const dups = useQuery(() => {
    return {
      queryKey: ['admin-prompts-duplicates'],
      queryFn: async () => {
        const response = await apiClient.api.admin.prompts.duplicates.get()
        if (response.error) throw new Error('Failed to load duplicates')
        return response.data?.data as Array<{contentHash: string; prompts: Array<{id: string; projectId: string}>}>
      },
    }
  })

  const canonicalize = useMutation(() => {
    return {
      mutationFn: async ({contentHash, canonicalPromptId}: {contentHash: string; canonicalPromptId: string}) => {
        const res = await apiClient.api.admin.prompts.canonicalize.post({contentHash, canonicalPromptId})
        if (res.error || !res.data?.success) throw new Error('Canonicalization failed')
        return true
      },
      onSuccess: () => {
        void dups.refetch()
      },
    }
  })

  const setChoice = (hash: string, id: string) => {
    setSelection((s) => ({...s, [hash]: id}))
  }

  const doCanonicalize = (hash: string) => {
    const id = selection()[hash]
    if (!id) return
    canonicalize.mutate({contentHash: hash, canonicalPromptId: id})
  }

  return (
    <div class="p-6 max-w-4xl mx-auto">
      <h1 class="text-2xl font-bold mb-4">Duplicate Prompts</h1>
      <Show when={dups.isLoading}>
        <p>Loading...</p>
      </Show>
      <Show when={dups.error}>
        <p class="text-red-600">{(dups.error as any)?.message || 'Error'}</p>
      </Show>
      <Show when={dups.data}>
        <div class="space-y-4">
          <For each={dups.data}>
            {(group) => {
              const chosen = () => selection()[group.contentHash]
              return (
                <div class="border rounded p-3">
                  <div class="flex items-center justify-between mb-2">
                    <div class="font-mono text-sm">hash: {group.contentHash}</div>
                    <button
                      class="px-3 py-1 text-xs bg-blue-600 text-white rounded disabled:opacity-50"
                      disabled={!chosen() || canonicalize.isPending}
                      onClick={() => doCanonicalize(group.contentHash)}
                    >
                      {canonicalize.isPending ? 'Working...' : 'Canonicalize'}
                    </button>
                  </div>
                  <div class="space-y-2">
                    <For each={group.prompts}>
                      {(p) => {
                        const checked = () => chosen() === p.id
                        return (
                          <label class="flex items-center gap-2 text-sm">
                            <input
                              type="radio"
                              name={`sel-${group.contentHash}`}
                              checked={checked()}
                              onChange={() => setChoice(group.contentHash, p.id)}
                            />
                            <span>
                              <span class="font-mono">{p.id}</span> · project <span class="font-mono">{p.projectId}</span>
                            </span>
                          </label>
                        )
                      }}
                    </For>
                  </div>
                </div>
              )
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}

export const Route = createFileRoute('/admin/prompts-duplicates/')({component: AdminPromptsDuplicates})
