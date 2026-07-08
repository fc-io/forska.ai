// @vitest-environment happy-dom

import type {ParentProps} from 'solid-js'
import {render} from 'solid-js/web'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

type MockLinkProps = ParentProps<{class?: string; onClick?: (event: MouseEvent) => void; to: string}>

vi.mock('@tanstack/solid-query', () => {
  return {
    useQuery: () => {
      return {data: undefined}
    },
  }
})

vi.mock('@tanstack/solid-router', () => {
  return {
    Link: (props: MockLinkProps) => {
      return (
        <a
          class={props.class}
          href={props.to}
          onClick={(event) => {
            props.onClick?.(event)
          }}
        >
          {props.children}
        </a>
      )
    },
    useLocation: () => {
      return () => {
        return {pathname: '/'}
      }
    },
  }
})

const waitForUpdates = () => {
  return new Promise<void>((resolve) => {
    queueMicrotask(resolve)
  })
}

const renderNavigation = async () => {
  const {Navigation} = await import('./Navigation.tsx')
  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return <Navigation />
  }, container)

  await waitForUpdates()

  return {container, dispose}
}

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('Navigation admin menu hover', () => {
  test('renders an invisible admin hover bridge that controls the sibling menu', async () => {
    const {container, dispose} = await renderNavigation()

    try {
      const trigger = container.querySelector('[role="button"]')
      const menu = container.querySelector('a[href="/admin/assessments"]')?.closest('div.absolute')
      const hoverTarget = trigger?.closest('.peer')
      const bridge = hoverTarget?.querySelector('[aria-hidden="true"]')

      expect(trigger).toBeInstanceOf(HTMLElement)
      expect(menu).toBeInstanceOf(HTMLElement)
      expect(hoverTarget).toBeInstanceOf(HTMLElement)
      expect(bridge).toBeInstanceOf(HTMLElement)
      expect(hoverTarget?.nextElementSibling).toBe(menu)
      expect(bridge?.classList.contains('absolute')).toBe(true)
      expect(bridge?.classList.contains('top-full')).toBe(true)
      expect(bridge?.classList.contains('h-8')).toBe(true)
      expect(menu?.classList.contains('invisible')).toBe(true)
      expect(menu?.classList.contains('transition-[visibility]')).toBe(true)
      expect(menu?.classList.contains('duration-0')).toBe(true)
      expect(menu?.classList.contains('delay-150')).toBe(true)
      expect(menu?.classList.contains('peer-hover:visible')).toBe(true)
      expect(menu?.classList.contains('peer-hover:delay-0')).toBe(true)
      expect(menu?.classList.contains('hover:visible')).toBe(true)
      expect(menu?.classList.contains('hover:delay-0')).toBe(true)
      expect(menu?.classList.contains('transition-opacity')).toBe(false)
    } finally {
      dispose()
      container.remove()
    }
  })

  test('renders the menu as a full-width overlay attached to the nav edge without a gap', async () => {
    const {container, dispose} = await renderNavigation()

    try {
      const menu = container.querySelector('a[href="/admin/assessments"]')?.closest('div.absolute')

      expect(menu).toBeInstanceOf(HTMLElement)
      expect(menu?.classList.contains('absolute')).toBe(true)
      expect(menu?.classList.contains('left-0')).toBe(true)
      expect(menu?.classList.contains('right-0')).toBe(true)
      expect(menu?.classList.contains('top-full')).toBe(true)
      expect(menu?.classList.contains('-mt-px')).toBe(true)
    } finally {
      dispose()
      container.remove()
    }
  })

  test('still closes the click-open admin menu when a menu link is clicked', async () => {
    const {container, dispose} = await renderNavigation()

    try {
      const trigger = container.querySelector('[role="button"]')
      const menu = container.querySelector('a[href="/admin/assessments"]')?.closest('div.absolute')

      expect(trigger).toBeInstanceOf(HTMLElement)
      expect(menu).toBeInstanceOf(HTMLElement)

      trigger?.dispatchEvent(new MouseEvent('click', {bubbles: true}))

      expect(menu?.classList.contains('visible')).toBe(true)
      expect(menu?.classList.contains('delay-0')).toBe(true)
      expect(menu?.classList.contains('invisible')).toBe(false)

      container.querySelector('a[href="/admin/assessments"]')?.dispatchEvent(new MouseEvent('click', {bubbles: true}))

      expect(menu?.classList.contains('invisible')).toBe(true)
      expect(menu?.classList.contains('delay-150')).toBe(true)
      expect(menu?.classList.contains('visible')).toBe(false)
    } finally {
      dispose()
      container.remove()
    }
  })

  test('still toggles the admin menu by click', async () => {
    const {container, dispose} = await renderNavigation()

    try {
      const trigger = container.querySelector('[role="button"]')
      const menu = container.querySelector('a[href="/admin/assessments"]')?.closest('div.absolute')

      expect(trigger).toBeInstanceOf(HTMLElement)
      expect(menu).toBeInstanceOf(HTMLElement)
      expect(trigger?.getAttribute('aria-expanded')).toBe('false')

      trigger?.dispatchEvent(new MouseEvent('click', {bubbles: true}))

      expect(trigger?.getAttribute('aria-expanded')).toBe('true')
      expect(menu?.classList.contains('visible')).toBe(true)
      expect(menu?.classList.contains('invisible')).toBe(false)

      trigger?.dispatchEvent(new MouseEvent('click', {bubbles: true}))

      expect(trigger?.getAttribute('aria-expanded')).toBe('false')
      expect(menu?.classList.contains('invisible')).toBe(true)
    } finally {
      dispose()
      container.remove()
    }
  })

  test('still toggles the admin menu by F13 outside editable inputs', async () => {
    const {container, dispose} = await renderNavigation()

    try {
      const trigger = container.querySelector('[role="button"]')
      const menu = container.querySelector('a[href="/admin/assessments"]')?.closest('div.absolute')

      expect(trigger).toBeInstanceOf(HTMLElement)
      expect(menu).toBeInstanceOf(HTMLElement)

      window.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true, code: 'F13', key: 'F13'}))

      expect(trigger?.getAttribute('aria-expanded')).toBe('true')
      expect(menu?.classList.contains('visible')).toBe(true)

      window.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true, code: 'F13', key: 'F13'}))

      expect(trigger?.getAttribute('aria-expanded')).toBe('false')
      expect(menu?.classList.contains('invisible')).toBe(true)
    } finally {
      dispose()
      container.remove()
    }
  })
})
