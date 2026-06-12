import {type QueryClient, useQueryClient} from '@tanstack/solid-query'
import {Link} from '@tanstack/solid-router'
import {type ColumnDef, createSolidTable, flexRender, getCoreRowModel} from '@tanstack/solid-table'
import {format} from 'date-fns'
import {type Accessor, createEffect, createMemo, createSignal, For, type Setter, Show} from 'solid-js'

import {Button} from '../../../../components/ui/button'
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from '../../../../components/ui/table'
import {
  deleteArchivedProjects,
  type fetchArchivedProjects,
  unarchiveProject,
} from '../../../../services/projectsService'

type ArchivedProject = Awaited<ReturnType<typeof fetchArchivedProjects>>[number]

type ArchivedProjectsTableProps = {projects: ArchivedProject[]}

type ArchivedProjectsTableColumnsParams = {
  queryClient: QueryClient
  allSelected: Accessor<boolean>
  someSelected: Accessor<boolean>
  toggleCurrentPageSelection: (checked: boolean) => void
  rowSelection: Accessor<Record<string, boolean>>
  unarchivingProjectIds: Accessor<Set<string>>
  setUnarchivingProjectIds: Setter<Set<string>>
}

const getSelectedRowIds = (rowIds: string[], rowSelection: Record<string, boolean>) => {
  return rowIds.filter((rowId) => {
    return Boolean(rowSelection[rowId])
  })
}

const getDeleteConfirmationMessage = (selectedCount: number) => {
  const projectLabel = selectedCount === 1 ? 'project' : 'projects'

  return `Delete ${selectedCount} selected archived ${projectLabel}? This delete is permanent and cannot restore the project.`
}

const mergeCurrentPageSelection = (rowIds: string[], checked: boolean, rowSelection: Record<string, boolean>) => {
  return checked
    ? rowIds.reduce<Record<string, boolean>>((next, rowId) => {
        return {...next, [rowId]: true}
      }, rowSelection)
    : rowIds.reduce<Record<string, boolean>>((next, rowId) => {
        const {[rowId]: _removed, ...rest} = next
        return rest
      }, rowSelection)
}

const filterSelectionToCurrentRows = (rowIds: string[], rowSelection: Record<string, boolean>) => {
  return rowIds.reduce<Record<string, boolean>>((next, rowId) => {
    return rowSelection[rowId] ? {...next, [rowId]: true} : next
  }, {})
}

const selectionMatchesCurrentRows = (current: Record<string, boolean>, next: Record<string, boolean>) => {
  const currentKeys = Object.keys(current).sort()
  const nextKeys = Object.keys(next).sort()

  return (
    currentKeys.length === nextKeys.length
    && currentKeys.every((key, index) => {
      return key === nextKeys[index]
    })
  )
}

const SelectionHeaderCheckbox = (props: {
  allSelected: Accessor<boolean>
  someSelected: Accessor<boolean>
  toggleCurrentPageSelection: (checked: boolean) => void
}) => {
  let input: HTMLInputElement | undefined

  createEffect(() => {
    if (input) {
      input.indeterminate = props.someSelected()
    }
  })

  return (
    <input
      ref={(element) => {
        input = element
      }}
      type="checkbox"
      aria-label="Select all archived projects on this page"
      class="size-4"
      checked={props.allSelected()}
      onChange={(event) => {
        props.toggleCurrentPageSelection(event.currentTarget.checked)
      }}
    />
  )
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
      id: 'select',
      header: () => {
        return (
          <SelectionHeaderCheckbox
            allSelected={params.allSelected}
            someSelected={params.someSelected}
            toggleCurrentPageSelection={params.toggleCurrentPageSelection}
          />
        )
      },
      size: 52,
      minSize: 52,
      cell: (info) => {
        const project = info.row.original
        const isSelected = () => {
          return Boolean(params.rowSelection()[project.id])
        }

        return (
          <input
            type="checkbox"
            class="size-4"
            checked={isSelected()}
            onChange={(event) => {
              info.row.toggleSelected(event.currentTarget.checked)
            }}
          />
        )
      },
    },
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
      size: 320,
      minSize: 320,
      cell: (info) => {
        const project = info.row.original
        const isUnarchiving = params.unarchivingProjectIds().has(project.id)

        return (
          <div class="flex items-center justify-end gap-3">
            <span class="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700">
              Archived
            </span>
            <Button
              as={Link}
              to="/projects/$id/export-project"
              params={{id: project.id} as never}
              size="sm"
              variant="outline"
            >
              Export Project
            </Button>
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
  const [rowSelection, setRowSelection] = createSignal<Record<string, boolean>>({})
  const [unarchivingProjectIds, setUnarchivingProjectIds] = createSignal<Set<string>>(new Set())
  const [isDeletingSelected, setIsDeletingSelected] = createSignal(false)
  const sortedProjects = createMemo(() => {
    return [...props.projects].sort((a, b) => {
      return a.name.localeCompare(b.name)
    })
  })
  const currentPageRowIds = createMemo(() => {
    return sortedProjects().map((project) => {
      return project.id
    })
  })
  const selectedProjectIds = createMemo(() => {
    return getSelectedRowIds(currentPageRowIds(), rowSelection())
  })
  const selectedCount = createMemo(() => {
    return selectedProjectIds().length
  })
  const allSelected = createMemo(() => {
    return currentPageRowIds().length > 0 && selectedCount() === currentPageRowIds().length
  })
  const someSelected = createMemo(() => {
    return selectedCount() > 0 && !allSelected()
  })
  const toggleCurrentPageSelection = (checked: boolean) => {
    setRowSelection((current) => {
      return mergeCurrentPageSelection(currentPageRowIds(), checked, current)
    })
  }
  createEffect(() => {
    const currentSelection = rowSelection()
    const nextSelection = filterSelectionToCurrentRows(currentPageRowIds(), rowSelection())

    if (!selectionMatchesCurrentRows(currentSelection, nextSelection)) {
      setRowSelection(nextSelection)
    }
  })
  const columns = getArchivedProjectsColumns({
    queryClient,
    allSelected,
    someSelected,
    toggleCurrentPageSelection,
    rowSelection,
    unarchivingProjectIds,
    setUnarchivingProjectIds,
  })
  const table = createSolidTable({
    get data() {
      return sortedProjects()
    },
    columns,
    getCoreRowModel: getCoreRowModel(),
    enableRowSelection: true,
    enableMultiRowSelection: true,
    getRowId: (row) => {
      return row.id
    },
    get state() {
      return {rowSelection: rowSelection()}
    },
    onRowSelectionChange: (updater) => {
      const current = rowSelection()
      const next = typeof updater === 'function' ? (updater as (old: unknown) => unknown)(current) : updater
      setRowSelection((next || {}) as Record<string, boolean>)
    },
  })

  const handleDeleteSelectedProjects = () => {
    if (!selectedCount()) {
      return
    }

    const confirmed = globalThis.confirm(getDeleteConfirmationMessage(selectedCount()))

    if (!confirmed) {
      return
    }

    setIsDeletingSelected(true)
    void deleteArchivedProjects(queryClient, selectedProjectIds())
      .then(() => {
        setRowSelection({})
      })
      .catch((error) => {
        console.error('Failed to delete archived projects:', error)
        alert(`Failed to delete archived projects: ${error instanceof Error ? error.message : 'Unknown error'}`)
      })
      .finally(() => {
        setIsDeletingSelected(false)
      })
  }

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
        <Show when={selectedCount() > 0}>
          <div class="mt-3 flex flex-col gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <span class="text-sm font-medium text-red-900">{selectedCount()} selected on this page</span>
            <Button
              variant="destructive"
              size="sm"
              disabled={isDeletingSelected()}
              onClick={handleDeleteSelectedProjects}
            >
              {isDeletingSelected() ? 'Deleting...' : 'Delete selected'}
            </Button>
          </div>
        </Show>
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
                            cell.column.id === 'actions'
                              ? 'px-4 py-4 text-right align-middle'
                              : cell.column.id === 'select'
                                ? 'px-4 py-4 align-middle'
                                : 'px-4 py-4 align-top'
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
