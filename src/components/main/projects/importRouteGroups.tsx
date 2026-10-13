import {createMemo, For, Show} from 'solid-js'

import {groupImportRoutes, isImportedFileRoute} from '../../../utils/importRouteUtils.ts'

type ImportRouteOption = {name: string | null; route: string}

type ImportRouteGroupsProps = {
  disabled?: boolean
  onToggle: (route: string) => void
  routes: ImportRouteOption[]
  selectedRoutes: string[]
}

const getImportRouteDisplayName = (option: ImportRouteOption) => {
  const name = option.name?.trim() ?? ''
  return name ? name : option.route
}

const shouldShowImportRouteHint = (option: ImportRouteOption) => {
  const name = option.name?.trim() ?? ''
  return Boolean(name) && name !== option.route && !isImportedFileRoute(option.route)
}

export const ImportRouteGroups = (props: ImportRouteGroupsProps) => {
  const groups = createMemo(() => {
    return groupImportRoutes(props.routes)
  })

  return (
    <div class="space-y-2">
      <For each={groups()}>
        {(group) => {
          const selectedCount = () => {
            return group.routes.filter((option) => {
              return props.selectedRoutes.includes(option.route)
            }).length
          }

          return (
            <details class="group border border-input rounded-md bg-muted/10">
              <summary class="cursor-pointer list-none flex items-center justify-between gap-3 px-4 py-3">
                <p class="text-sm font-medium text-gray-900">{group.label}</p>
                <span class="flex items-center gap-3 text-xs text-muted-foreground">
                  <span>
                    {selectedCount()} of {group.routes.length} selected
                  </span>
                  <span class="group-open:hidden">Expand</span>
                  <span class="hidden group-open:inline">Collapse</span>
                </span>
              </summary>
              <div class="px-4 pb-4 space-y-2">
                <For each={group.routes}>
                  {(option) => {
                    return (
                      <label
                        class="flex items-start gap-3 border rounded-md p-3 bg-background cursor-pointer"
                        classList={{'border-input': !props.disabled, 'opacity-60': props.disabled}}
                      >
                        <input
                          type="checkbox"
                          class="mt-1"
                          checked={props.selectedRoutes.includes(option.route)}
                          disabled={props.disabled}
                          onChange={() => {
                            return props.onToggle(option.route)
                          }}
                        />
                        <div class="flex-1">
                          <p class="text-sm font-medium text-gray-900">{getImportRouteDisplayName(option)}</p>
                          <Show when={shouldShowImportRouteHint(option)}>
                            <p class="text-xs text-gray-600 font-mono break-all">{option.route}</p>
                          </Show>
                        </div>
                      </label>
                    )
                  }}
                </For>
              </div>
            </details>
          )
        }}
      </For>
    </div>
  )
}
