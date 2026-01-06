import type {JSX} from 'solid-js'
import {createSignal, onCleanup, onMount} from 'solid-js'

type StickyColumnProps = {class?: string; offsetTop?: number; offsetBottom?: number; children?: JSX.Element}

/**
 * A column that sticks to the viewport while scrolling.
 * - If the content fits in the viewport, it sticks to the top.
 * - If the content is taller than the viewport, it sticks when the bottom
 *   of the content reaches the bottom of the viewport.
 */
export const StickyColumn = (props: StickyColumnProps) => {
  const [stickyTop, setStickyTop] = createSignal<number | undefined>(undefined)
  let containerRef: HTMLDivElement | undefined

  const offsetTop = () => {
    return props.offsetTop ?? 24
  }
  const offsetBottom = () => {
    return props.offsetBottom ?? 24
  }

  const setStickiness = () => {
    const containerHeight = containerRef?.getBoundingClientRect().height
    if (!containerHeight) {
      setStickyTop(undefined)
      return
    }

    const availableHeight = window.innerHeight - offsetTop()

    if (containerHeight <= availableHeight) {
      // Content fits: stick to top
      setStickyTop(offsetTop())
    } else {
      // Content is taller: stick when bottom reaches viewport bottom
      setStickyTop(window.innerHeight - containerHeight - offsetBottom())
    }
  }

  onMount(() => {
    setStickiness()
    const resizeObserver = new ResizeObserver(() => {
      setStickiness()
    })
    if (containerRef) {
      resizeObserver.observe(containerRef)
    }
    const handleResize = () => {
      setStickiness()
    }
    window.addEventListener('resize', handleResize)
    onCleanup(() => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', handleResize)
    })
  })

  return (
    <div
      ref={(el) => {
        containerRef = el
      }}
      class={props.class}
      classList={{sticky: stickyTop() !== undefined, 'self-start': stickyTop() !== undefined}}
      style={{top: stickyTop() !== undefined ? `${stickyTop()}px` : undefined}}
    >
      {props.children}
    </div>
  )
}
