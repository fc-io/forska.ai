import {type QueryClient, useQueryClient} from '@tanstack/solid-query'
import {type ColumnDef, createSolidTable, flexRender, getCoreRowModel} from '@tanstack/solid-table'
import {format} from 'date-fns'
import {type Accessor, createMemo, createSignal, For, type Setter} from 'solid-js'

import {Button} from '../../../../components/ui/button'
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from '../../../../components/ui/table'
import {type fetchArchivedProjects, unarchiveProject} from '../../../../services/projectsService'

type ArchivedProject = Awaited<ReturnType<typeof fetchArchivedProjects>>[number]

type ArchivedProjectsTableProps = {projects: ArchivedProject[]}

type ArchivedProjectsTableColumnsParams = {
  queryClient: QueryClient
  unarchivingProjectIds: Accessor<Set<string>>
  setUnarchivingProjectIds: Setter<Set<string>>
}

const getProjectModelLabel = (project: ArchivedProject) => {
  return project.modelName || 'Unknown model'
}

const getProjectContentUsedLabel = (project: ArchivedProject) => {
  const fulltextLabel = project.useFulltextNoImages ? 'fulltext (no images)' : project.useFulltext ? 'fulltext' : null
  const parts = [project.useTitle ? 'title' : null, project.useAbstract ? 'abstract' : null, fulltextLabel].filter(
    Boolean,
  ) as string[]

  return parts.length > 0 ? parts.join(', ') : 'none'
}

const getProjectDescriptionLabel = (project: ArchivedProject) => {
  return project.description
    ? project.description.length > 120
      ? `${project.description.slice(0, 120).trim()}...`
      : project.description
    : 'No description'
}

const getProjectTimestampLabel = (value: Date | null) => {
  return value ? format(value, 'yyyy-MM-dd HH:mm') : 'Unknown'
}

const addPendingProjectId = (setUnarchivingProjectIds: Setter<Set<string>>, projectId: string) => {
  setUnarchivingProjectIds((prev) => {
    return new Set([...prev, projectId])
  })
}

const removePendingProjectId = (setUnarchivingProjectIds: Setter<Set<string>>, projectId: string) => {
  setUnarchivingProjectIds((prev) => {
    const next = new Set(prev)
    next.delete(projectId)
    return next
  })
}

const handleUnarchiveProject = (
  queryClient: QueryClient,
  setUnarchivingProjectIds: Setter<Set<string>>,
  projectId: string,
) => {
  addPendingProjectId(setUnarchivingProjectIds, projectId)
  void unarchiveProject(queryClient, projectId)
    .then(() => {
      console.log('Project unarchived:', projectId)
    })
    .catch((error) => {
      console.error('Failed to unarchive project:', error)
    })
    .finally(() => {
      removePendingProjectId(setUnarchivingProjectIds, projectId)
    })
}

const getArchivedProjectsColumns = (
  params: ArchivedProjectsTableColumnsParams,
): ColumnDef<ArchivedProject, unknown>[] => {
  return [
    {
      accessorKey: 'name',
      header: 'Project',
      size: 360,
      minSize: 280,
      cell: (info) => {
        const project = info.row.original

        return (
          <div class="min-w-[16rem] space-y-1 py-1">
            <div class="font-medium text-gray-900">{project.name}</div>
            <div class="text-sm text-muted-foreground">{getProjectDescriptionLabel(project)}</div>
          </div>
        )
      },
    },
    {
      id: 'model',
      header: 'Model',
      size: 220,
      minSize: 180,
      cell: (info) => {
        return <div class="text-sm text-gray-700">{getProjectModelLabel(info.row.original)}</div>
      },
    },
    {
      id: 'content',
      header: 'Content Used',
      size: 220,
      minSize: 180,
      cell: (info) => {
        return <div class="text-sm text-gray-700">{getProjectContentUsedLabel(info.row.original)}</div>
      },
    },
    {
      accessorKey: 'createdAt',
      header: 'Created',
      size: 160,
      minSize: 160,
      cell: (info) => {
        return (
          <div class="whitespace-nowrap text-sm text-gray-700">
            {getProjectTimestampLabel(info.getValue() as Date | null)}
          </div>
        )
      },
    },
    {
      accessorKey: 'updatedAt',
      header: 'Last Updated',
      size: 160,
      minSize: 160,
      cell: (info) => {
        return (
          <div class="whitespace-nowrap text-sm text-gray-700">
            {getProjectTimestampLabel(info.getValue() as Date | null)}
          </div>
        )
      },
    },
    {
      id: 'actions',
      header: 'Actions',
      size: 180,
      minSize: 180,
      cell: (info) => {
        const project = info.row.original
        const isUnarchiving = params.unarchivingProjectIds().has(project.id)

        return (
          <div class="flex items-center justify-end gap-3">
            <span class="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700">
              Archived
            </span>
            <Button
              size="sm"
              disabled={isUnarchiving}
              onClick={() => {
                handleUnarchiveProject(params.queryClient, params.setUnarchivingProjectIds, project.id)
              }}
            >
              {isUnarchiving ? 'Unarchiving...' : 'Unarchive'}
            </Button>
          </div>
        )
      },
    },
  ]
}

export const ArchivedProjectsTable = (props: ArchivedProjectsTableProps) => {
  const queryClient = useQueryClient()
  const [unarchivingProjectIds, setUnarchivingProjectIds] = createSignal<Set<string>>(new Set())
  const sortedProjects = createMemo(() => {
    return [...props.projects].sort((a, b) => {
      return a.name.localeCompare(b.name)
    })
  })
  const columns = getArchivedProjectsColumns({queryClient, unarchivingProjectIds, setUnarchivingProjectIds})
  const table = createSolidTable({
    get data() {
      return sortedProjects()
    },
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => {
      return row.id
    },
  })

  return (
    <div class="w-full overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
      <div class="flex flex-col gap-1 border-b border-gray-200 px-4 py-4 sm:px-6">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 class="text-lg font-semibold text-gray-900">Project archive</h2>
            <p class="text-sm text-muted-foreground">
              Archived projects stay read-only here until you move them back to the active list.
            </p>
          </div>
          <span class="inline-flex items-center rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-700">
            {sortedProjects().length} {sortedProjects().length === 1 ? 'project' : 'projects'}
          </span>
        </div>
      </div>
      <Table class="min-w-[1100px] w-full">
        <TableHeader class="bg-gray-50/80">
          <For each={table.getHeaderGroups()}>
            {(headerGroup) => {
              return (
                <TableRow class="hover:bg-transparent">
                  <For each={headerGroup.headers}>
                    {(header) => {
                      return (
                        <TableHead
                          class="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-gray-500"
                          style={{width: `${header.getSize()}px`}}
                        >
                          {header.isPlaceholder
                            ? null
                            : flexRender(header.column.columnDef.header, header.getContext())}
                        </TableHead>
                      )
                    }}
                  </For>
                </TableRow>
              )
            }}
          </For>
        </TableHeader>
        <TableBody>
          <For each={table.getRowModel().rows}>
            {(row) => {
              return (
                <TableRow class="border-b border-gray-100 align-top">
                  <For each={row.getVisibleCells()}>
                    {(cell) => {
                      return (
                        <TableCell
                          class={
                            cell.column.id === 'actions' ? 'px-4 py-4 text-right align-middle' : 'px-4 py-4 align-top'
                          }
                          style={{width: `${cell.column.getSize()}px`}}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      )
                    }}
                  </For>
                </TableRow>
              )
            }}
          </For>
        </TableBody>
      </Table>
    </div>
  )
}
