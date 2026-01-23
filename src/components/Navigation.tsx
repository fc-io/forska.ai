import {Menu} from '@ark-ui/solid'
import {Link} from '@tanstack/solid-router'
import {createSignal, onCleanup, onMount, Show} from 'solid-js'

import type {User} from '../types/user'

interface NavigationProps {
  user: User | undefined
  onSignOut: () => void
}

const isEventTargetWithinElement = (target: EventTarget | null, element: HTMLElement | undefined) => {
  return target instanceof Node && !!element && element.contains(target)
}

const isEditableTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  const tagName = target.tagName
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT' || target.isContentEditable
}

const isF13KeyDownEvent = (event: KeyboardEvent) => {
  return event.code === 'F13' || event.key === 'F13'
}

const getAvatarLabel = (user: User | undefined) => {
  const defaultLabel = 'U'
  if (!user) {
    return defaultLabel
  }
  const trimmedName = user.name?.trim()
  if (trimmedName) {
    return trimmedName
      .split(/\s+/)
      .filter((part) => {
        return part.length > 0
      })
      .map((part) => {
        return part[0] ?? ''
      })
      .join('')
      .slice(0, 2)
      .toUpperCase()
  }
  const trimmedEmail = user.email?.trim()
  if (trimmedEmail) {
    return trimmedEmail.slice(0, 2).toUpperCase()
  }
  return defaultLabel
}

export const Navigation = (props: NavigationProps) => {
  const [isAdminMenuOpen, setIsAdminMenuOpen] = createSignal(false)
  let adminMenuTriggerElement: HTMLDivElement | undefined
  let adminMenuElement: HTMLDivElement | undefined

  const closeAdminMenu = () => {
    setIsAdminMenuOpen(false)
  }

  const openAdminMenu = () => {
    setIsAdminMenuOpen(true)
  }

  const toggleAdminMenu = () => {
    setIsAdminMenuOpen((previous) => {
      return !previous
    })
  }

  const handleAdminMenuTriggerPointerEnter = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') {
      openAdminMenu()
    }
  }

  const handleAdminMenuTriggerPointerLeave = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse') {
      return
    }

    if (!isEventTargetWithinElement(event.relatedTarget, adminMenuElement)) {
      closeAdminMenu()
    }
  }

  const handleAdminMenuPointerEnter = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') {
      openAdminMenu()
    }
  }

  const handleAdminMenuPointerLeave = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse') {
      return
    }

    if (!isEventTargetWithinElement(event.relatedTarget, adminMenuTriggerElement)) {
      closeAdminMenu()
    }
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (!isF13KeyDownEvent(event) || isEditableTarget(event.target)) {
      return
    }

    if (props.user?.role !== 'admin') {
      return
    }

    event.preventDefault()
    toggleAdminMenu()
  }

  onMount(() => {
    window.addEventListener('keydown', handleKeyDown)
  })

  onCleanup(() => {
    window.removeEventListener('keydown', handleKeyDown)
  })

  return (
    <nav class="relative bg-white shadow-sm border-b border-gray-200">
      <div class="px-4 sm:px-6 lg:px-8">
        <div class="flex justify-between h-16">
          <div class="flex items-center space-x-8">
            <Link
              to="/"
              class="text-gray-900 hover:text-blue-600 px-3 py-2 text-sm font-medium [&.active]:text-blue-600 [&.active]:font-semibold"
            >
              Home
            </Link>
            <Link
              to="/prompts"
              class="text-gray-900 hover:text-blue-600 px-3 py-2 text-sm font-medium [&.active]:text-blue-600 [&.active]:font-semibold"
            >
              Prompts
            </Link>
            <Link
              to="/articles"
              class="text-gray-900 hover:text-blue-600 px-3 py-2 text-sm font-medium [&.active]:text-blue-600 [&.active]:font-semibold"
            >
              Article Search
            </Link>
          </div>
          <div class="flex items-center space-x-4">
            <Show when={props.user?.role === 'admin'}>
              <div
                ref={(element) => {
                  adminMenuTriggerElement = element
                }}
                class="group -mx-2 mr-4 flex h-full cursor-pointer select-none items-center px-2"
                role="button"
                tabIndex={0}
                aria-haspopup="true"
                aria-expanded={isAdminMenuOpen()}
                onPointerEnter={handleAdminMenuTriggerPointerEnter}
                onPointerLeave={handleAdminMenuTriggerPointerLeave}
                onClick={toggleAdminMenu}
              >
                <div
                  class={`rounded-md px-3 py-2 text-sm font-medium text-gray-700 group-hover:bg-stone-100 group-hover:text-gray-900 ${
                    isAdminMenuOpen() ? 'bg-stone-100 text-gray-900' : ''
                  }`}
                >
                  Admin Menu
                </div>
              </div>
            </Show>
            <Show when={props.user}>
              <Menu.Root positioning={{placement: 'bottom-end'}}>
                <Menu.Trigger class="inline-flex items-center justify-center w-9 h-9 rounded-full bg-gray-200 text-sm font-semibold text-gray-700 hover:bg-gray-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                  <span aria-hidden="true">{getAvatarLabel(props.user)}</span>
                  <span class="sr-only">Open user menu</span>
                </Menu.Trigger>
                <Menu.Positioner>
                  <Menu.Content class="mt-2 w-40 rounded-md bg-white py-2 shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none">
                    <Menu.Item id="settings" value="settings" class="p-0">
                      <Link
                        to="/settings"
                        class="block w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100"
                      >
                        Settings
                      </Link>
                    </Menu.Item>
                    <Menu.Item id="sign-out" value="sign-out" class="p-0">
                      <Link
                        to="/login"
                        class="block w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100"
                        onClick={() => {
                          props.onSignOut()
                        }}
                      >
                        Sign Out
                      </Link>
                    </Menu.Item>
                  </Menu.Content>
                </Menu.Positioner>
              </Menu.Root>
            </Show>
          </div>
        </div>
      </div>
      <Show when={props.user?.role === 'admin' && isAdminMenuOpen()}>
        <div
          ref={(element) => {
            adminMenuElement = element
          }}
          class="absolute left-0 right-0 top-full -mt-px z-50 border-t border-gray-200 bg-stone-100 shadow-sm"
          onPointerEnter={handleAdminMenuPointerEnter}
          onPointerLeave={handleAdminMenuPointerLeave}
        >
          <div class="px-4 sm:px-6 lg:px-8 py-6">
            <div class="flex items-stretch gap-6 min-h-64">
              <div class="grid flex-1 grid-cols-1 gap-10 sm:grid-cols-2 lg:grid-cols-3">
                <div class="flex flex-col gap-4">
                  <div class="text-xs font-semibold uppercase tracking-wide text-gray-500">Data</div>
                  <div class="flex flex-col gap-1">
                    <Link
                      to="/admin/assessments"
                      class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                      onClick={closeAdminMenu}
                    >
                      Assessments
                    </Link>
                    <Link
                      to="/admin/datasources"
                      class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                      onClick={closeAdminMenu}
                    >
                      Data Sources
                    </Link>
                    <Link
                      to="/admin/latest-articles"
                      class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                      onClick={closeAdminMenu}
                    >
                      Latest Articles
                    </Link>
                    <Link
                      to="/admin/pdf-conversions"
                      class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                      onClick={closeAdminMenu}
                    >
                      PDF Conversions
                    </Link>
                    <Link
                      to="/admin/pdf-reset"
                      class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                      onClick={closeAdminMenu}
                    >
                      PDF Fetch Reset
                    </Link>
                    <Link
                      to="/admin/parquet"
                      class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                      onClick={closeAdminMenu}
                    >
                      Parquet
                    </Link>
                    <Link
                      to="/admin/unexpected-answers"
                      class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                      onClick={closeAdminMenu}
                    >
                      Unexpected Answers
                    </Link>
                  </div>
                </div>
                <div class="flex flex-col gap-4">
                  <div class="text-xs font-semibold uppercase tracking-wide text-gray-500">System</div>
                  <div class="flex flex-col gap-1">
                    <Link
                      to="/admin/gpu"
                      class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                      onClick={closeAdminMenu}
                    >
                      GPU Metrics
                    </Link>
                    <Link
                      to="/admin/failed_requests"
                      class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                      onClick={closeAdminMenu}
                    >
                      Failed Requests
                    </Link>
                    <Link
                      to="/admin/clickhouse-sync"
                      class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                      onClick={closeAdminMenu}
                    >
                      ClickHouse Sync
                    </Link>
                    <Link
                      to="/admin/setup_stats"
                      class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                      onClick={closeAdminMenu}
                    >
                      Setup/Stats
                    </Link>
                  </div>
                </div>
                <div class="flex flex-col gap-4">
                  <div class="text-xs font-semibold uppercase tracking-wide text-gray-500">Admin</div>
                  <div class="flex flex-col gap-1">
                    <Link
                      to="/admin/users"
                      class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                      onClick={closeAdminMenu}
                    >
                      Users
                    </Link>
                    <Link
                      to="/admin/prompts/deduplicate"
                      class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                      onClick={closeAdminMenu}
                    >
                      Prompts
                    </Link>
                    <Link
                      to="/admin/aa-models"
                      class="rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:bg-white/60 hover:text-gray-900"
                      onClick={closeAdminMenu}
                    >
                      AI Models
                    </Link>
                  </div>
                </div>
              </div>
              <div class="flex items-stretch gap-4">
                <Link
                  to="/admin/jobs"
                  class="flex h-full w-44 sm:w-52 md:w-60 flex-col justify-between rounded-xl border border-stone-200 bg-white/60 px-6 py-6 font-semibold text-gray-900 hover:bg-white"
                  onClick={closeAdminMenu}
                >
                  <div class="text-lg font-semibold">Jobs</div>
                </Link>
                <Link
                  to="/admin/llm"
                  class="flex h-full w-44 sm:w-52 md:w-60 flex-col justify-between rounded-xl border border-stone-200 bg-white/60 px-6 py-6 font-semibold text-gray-900 hover:bg-white"
                  onClick={closeAdminMenu}
                >
                  <div class="text-lg font-semibold">LLM Metrics</div>
                </Link>
              </div>
            </div>
          </div>
        </div>
      </Show>
    </nav>
  )
}
