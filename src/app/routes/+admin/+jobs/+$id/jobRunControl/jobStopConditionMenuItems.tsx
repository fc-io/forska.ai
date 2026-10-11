import {type JSX, Show, splitProps} from 'solid-js'

import {cn} from '../../../../../../utils/cn.ts'

export const stopConditionMenuItemSelector = '[data-stop-menu-item]:not([disabled])'

const menuItemClass =
  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-gray-900 hover:bg-gray-100 focus:bg-gray-100 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50'

const ChevronRightIcon = () => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="size-4 shrink-0 text-gray-400"
      aria-hidden="true"
      data-stop-menu-arrow
    >
      <path d="M9 6l6 6l-6 6" />
    </svg>
  )
}

const ChevronLeftIcon = () => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="size-4 shrink-0"
      aria-hidden="true"
    >
      <path d="M15 6l-6 6l6 6" />
    </svg>
  )
}

export const CheckIcon = () => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="size-4 shrink-0 text-blue-600"
      aria-hidden="true"
      data-stop-menu-check
    >
      <path d="M5 12l5 5l10 -10" />
    </svg>
  )
}

export const CalendarIcon = () => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="size-4 shrink-0 text-gray-500"
      aria-hidden="true"
    >
      <path d="M4 7a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12z" />
      <path d="M16 3v4" />
      <path d="M8 3v4" />
      <path d="M4 11h16" />
    </svg>
  )
}

type StopConditionMenuItemProps = {
  checked?: boolean
  disabled?: boolean
  hasSubmenu?: boolean
  icon?: JSX.Element
  label: string
  onSelect: () => void
  role?: 'menuitem' | 'menuitemcheckbox'
  value?: string
}

export const StopConditionMenuItem = (props: StopConditionMenuItemProps) => {
  const [local] = splitProps(props, ['checked', 'disabled', 'hasSubmenu', 'icon', 'label', 'onSelect', 'role', 'value'])

  return (
    <button
      type="button"
      role={local.role ?? 'menuitem'}
      aria-checked={local.role === 'menuitemcheckbox' ? Boolean(local.checked) : undefined}
      aria-haspopup={local.hasSubmenu ? 'menu' : undefined}
      class={menuItemClass}
      data-stop-menu-item
      data-stop-menu-submenu={local.hasSubmenu ? '' : undefined}
      disabled={local.disabled}
      onClick={() => {
        local.onSelect()
      }}
    >
      {local.icon}
      <span class="min-w-0 flex-1 break-words" data-stop-menu-label>
        {local.label}
      </span>
      <Show when={local.value}>
        {(value) => {
          return <span class="shrink-0 text-xs text-gray-500">{value()}</span>
        }}
      </Show>
      <Show when={local.checked && local.role !== 'menuitemcheckbox'}>
        <CheckIcon />
      </Show>
      <Show when={local.role === 'menuitemcheckbox'}>
        <Show when={local.checked} fallback={<span class="shrink-0 text-xs text-gray-500">off</span>}>
          <CheckIcon />
        </Show>
      </Show>
      <Show when={local.hasSubmenu}>
        <ChevronRightIcon />
      </Show>
    </button>
  )
}

export const StopConditionMenuHeader = (props: {label: string; onBack: () => void}) => {
  return (
    <button
      type="button"
      class={cn(menuItemClass, 'font-medium text-gray-700')}
      data-stop-menu-item
      data-stop-menu-back
      onClick={() => {
        props.onBack()
      }}
    >
      <ChevronLeftIcon />
      <span class="sr-only">Back: </span>
      <span class="min-w-0 flex-1 break-words" data-stop-menu-label>
        {props.label}
      </span>
    </button>
  )
}

export const StopConditionMenuSeparator = () => {
  return <div role="separator" class="my-1 h-px bg-gray-200" />
}
