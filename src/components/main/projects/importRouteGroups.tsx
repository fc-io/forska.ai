import {createMemo, For, Show} from 'solid-js'

import {groupImportRoutes, isImportedFileRoute} from '../../../utils/importRouteUtils.ts'
import {CollapsibleSelectionSection} from './collapsibleSelectionSection.tsx'

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
            <CollapsibleSelectionSection
              label={group.label}
              open={group.key === 'dataSource'}
              selectedCount={selectedCount()}
              totalCount={group.routes.length}
            >
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
            </CollapsibleSelectionSection>
          )
        }}
      </For>
    </div>
  )
}
