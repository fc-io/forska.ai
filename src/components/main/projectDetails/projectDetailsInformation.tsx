import {format} from 'date-fns'

export const ProjectDetailsInformation = (props: {
  project: {
    name: string
    createdAt: Date
    updatedAt: Date
    description: string | null
  }
}) => {
  const formatDate = (date: Date) => {
    return format(date, 'yyyy-MM-dd HH:mm:ss')
  }

  return (
    <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
      {/* <h2 class="text-1xl font-semibold mb-4">Project Information</h2> */}
      <div class="grid grid-cols-1 md:grid-cols-2 md:grid-flow-col md:grid-rows-2 gap-1">
        <div class="flex gap-2 items-start">
          <label class="text-sm font-medium text-muted-foreground">
            Project Name:
          </label>
          <p class="text-sm">{props.project.name}</p>
        </div>
        <div class="flex gap-2 items-start">
          <label class="text-sm font-medium text-muted-foreground">
            Created:
          </label>
          <p class="text-sm">{formatDate(props.project.createdAt)}</p>
        </div>
        <div class="flex gap-2 items-start">
          <label class="text-sm font-medium text-muted-foreground">
            Status:
          </label>
          <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
            Active
          </span>
        </div>
        <div class="flex gap-2 items-start">
          <label class="text-sm font-medium text-muted-foreground">
            Last Updated:
          </label>
          <p class="text-sm">{formatDate(props.project.updatedAt)}</p>
        </div>
      </div>
      <div class="flex gap-2 items-start">
        <label class="text-sm font-medium text-muted-foreground">
          Description:
        </label>
        <p class="text-sm max-w-[580px]">
          {props.project.description || 'No description provided'}
        </p>
      </div>
    </div>
  )
}
