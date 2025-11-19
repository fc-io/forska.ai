import {useQuery} from '@tanstack/solid-query'
import {Link} from '@tanstack/solid-router'
import {type ColumnDef, createSolidTable, flexRender, getCoreRowModel} from '@tanstack/solid-table'
import {For, Show, Suspense} from 'solid-js'

import {apiClient} from '../../../services/apiClient.ts'
import {handleApiResponse} from '../../../services/utils/handleApiResponse.ts'

type CuratedArticle = {id: string; articleTitle: string}

export const ProjectDetailsCuratedArticles = (props: {projectId: string}) => {
  const query = useQuery(() => {
    return {
      queryKey: ['project-curated-articles', props.projectId],
      queryFn: async () => {
        const response = await apiClient.api.projects({id: props.projectId}).articles.get()
        const data = handleApiResponse(response, 'Failed to fetch project articles') as {articles: CuratedArticle[]}
        return data.articles ?? []
      },
      refetchOnWindowFocus: false,
    }
  })

  const columns: ColumnDef<CuratedArticle, unknown>[] = [
    {
      accessorKey: 'id',
      header: 'ID',
      size: 280,
      minSize: 180,
      cell: (info) => {
        return <span class="font-mono text-xs text-gray-700">{info.getValue() as string}</span>
      },
    },
    {
      accessorKey: 'articleTitle',
      header: 'Title',
      size: 520,
      minSize: 240,
      cell: (info) => {
        return (
          <Link
            to="/projects/$id/reviews-llm/$articleId"
            params={{id: props.projectId, articleId: info.row.original.id}}
            class="text-blue-600 hover:underline"
          >
            {(info.getValue() as string) || 'Untitled'}
          </Link>
        )
      },
    },
  ]

  const table = createSolidTable({
    get data() {
      return query.data || []
    },
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => {
      return (row as CuratedArticle).id
    },
  })

  return (
    <div>
      <h2 class="text-lg font-semibold mb-2">Imported Articles</h2>
      <Suspense>
        <Show when={query.isPending}>
          <div class="text-sm text-gray-500">Loading imported articles…</div>
        </Show>
        <Show when={query.error}>
          <div class="text-sm text-red-600">{(query.error as Error).message}</div>
        </Show>
        <Show when={query.data}>
          <div class="overflow-x-auto bg-white rounded-lg shadow">
            <table class="min-w-full divide-y divide-gray-200">
              <thead class="bg-gray-50">
                <For each={table.getHeaderGroups()}>
                  {(headerGroup) => {
                    return (
                      <tr>
                        <For each={headerGroup.headers}>
                          {(header) => {
                            return (
                              <th
                                class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                                style={{width: `${header.getSize()}px`}}
                              >
                                {header.isPlaceholder
                                  ? null
                                  : flexRender(header.column.columnDef.header, header.getContext())}
                              </th>
                            )
                          }}
                        </For>
                      </tr>
                    )
                  }}
                </For>
              </thead>
              <tbody class="bg-white divide-y divide-gray-200">
                <For each={table.getRowModel().rows}>
                  {(row) => {
                    return (
                      <tr class="hover:bg-gray-50">
                        <For each={row.getVisibleCells()}>
                          {(cell) => {
                            return (
                              <td
                                class={
                                  cell.column.id === 'articleTitle'
                                    ? 'px-6 py-4 text-sm text-gray-900'
                                    : 'px-6 py-4 whitespace-nowrap text-sm text-gray-900'
                                }
                                style={{width: `${cell.column.getSize()}px`}}
                              >
                                {flexRender(cell.column.columnDef.cell, cell.getContext())}
                              </td>
                            )
                          }}
                        </For>
                      </tr>
                    )
                  }}
                </For>
              </tbody>
            </table>
            <Show when={(query.data || []).length === 0}>
              <div class="p-8 text-center text-gray-500">No articles linked.</div>
            </Show>
          </div>
        </Show>
      </Suspense>
    </div>
  )
}
