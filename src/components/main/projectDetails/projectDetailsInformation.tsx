import {format} from 'date-fns'
import {createMemo, For, Show} from 'solid-js'

interface ProjectDetailsInformationProject {
  name: string
  createdAt: Date | string
  updatedAt: Date | string
  description: string | null
  dateFrom: Date | string | null
  dateTo: Date | string | null
}

type ProjectDetailsInformationProps = {
  project: ProjectDetailsInformationProject
  importRoutes: string[]
  model?: {id: string; name: string; provider?: string | null; modelName?: string | null} | null
}

const parseDate = (value: Date | string | null) => {
  if (!value) {
    return null
  }

  const parsedDate = typeof value === 'string' ? new Date(value) : value

  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate
}

const formatDateValue = (value: Date | string | null, fallback: string) => {
  const parsedDate = parseDate(value)

  return parsedDate ? format(parsedDate, 'yyyy-MM-dd HH:mm:ss') : fallback
}

export const ProjectDetailsInformation = (props: ProjectDetailsInformationProps) => {
  const createdAt = createMemo(() => {
    return formatDateValue(props.project.createdAt, 'Unknown')
  })
  const updatedAt = createMemo(() => {
    return formatDateValue(props.project.updatedAt, 'Unknown')
  })
  const dateFrom = createMemo(() => {
    return formatDateValue(props.project.dateFrom, 'Not set')
  })
  const dateTo = createMemo(() => {
    return formatDateValue(props.project.dateTo, 'Not set')
  })
  const description = createMemo(() => {
    return props.project.description || 'No description provided'
  })
  const hasImportRoutes = createMemo(() => {
    return props.importRoutes.length > 0
  })
  const modelName = createMemo(() => {
    return props.model?.name ?? 'Unknown'
  })

  return (
    <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
      <div class="grid grid-cols-1 md:grid-cols-2 md:grid-flow-col md:grid-rows-4 gap-1">
        <div class="flex gap-2 items-start">
          <label class="text-sm font-medium text-muted-foreground">Project Name:</label>
          <p class="text-sm">{props.project.name}</p>
        </div>
        <div class="flex gap-2 items-start">
          <label class="text-sm font-medium text-muted-foreground">Created:</label>
          <p class="text-sm">{createdAt()}</p>
        </div>
        <div class="flex gap-2 items-start">
          <label class="text-sm font-medium text-muted-foreground">Status:</label>
          <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
            Active
          </span>
        </div>
        <div class="flex gap-2 items-start">
          <label class="text-sm font-medium text-muted-foreground">Last Updated:</label>
          <p class="text-sm">{updatedAt()}</p>
        </div>
        <div class="flex gap-2 items-start">
          <label class="text-sm font-medium text-muted-foreground">Date From:</label>
          <p class="text-sm">{dateFrom()}</p>
        </div>
        <div class="flex gap-2 items-start">
          <label class="text-sm font-medium text-muted-foreground">Date To:</label>
          <p class="text-sm">{dateTo()}</p>
        </div>
        <div class="flex gap-2 items-start">
          <label class="text-sm font-medium text-muted-foreground">Model:</label>
          <p class="text-sm">{modelName()}</p>
        </div>
      </div>
      <div class="flex gap-2 items-start">
        <label class="text-sm font-medium text-muted-foreground">Description:</label>
        <p class="text-sm max-w-[580px]">{description()}</p>
      </div>
      <div class="flex gap-2 items-start">
        <label class="text-sm font-medium text-muted-foreground">Import Routes:</label>
        <Show when={hasImportRoutes()} fallback={<p class="text-sm">No import routes assigned</p>}>
          <ul class="space-y-1 text-sm">
            <For each={props.importRoutes}>
              {(route) => {
                return <li class="font-medium text-gray-900 break-all">{route}</li>
              }}
            </For>
          </ul>
        </Show>
      </div>
    </div>
  )
}
