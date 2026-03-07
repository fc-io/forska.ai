import {createEffect} from 'solid-js'

type HtmlLine = {nodes: Node[]; br: HTMLBRElement | null; text: string}

const getTextFromNodes = (nodes: Node[]): string => {
  return nodes
    .map((node) => {
      return node.textContent ?? ''
    })
    .join('')
}

const splitHtmlIntoLines = (html: string): HtmlLine[] => {
  const template = document.createElement('template')
  template.innerHTML = html

  const childNodes = Array.from(template.content.childNodes)

  const initial = {current: [] as Node[], lines: [] as Array<{nodes: Node[]; br: HTMLBRElement | null}>}

  const reduced = childNodes.reduce((acc, node) => {
    const isBr = node.nodeName === 'BR'
    return isBr
      ? {current: [], lines: [...acc.lines, {nodes: acc.current, br: node as HTMLBRElement}]}
      : {current: [...acc.current, node], lines: acc.lines}
  }, initial)

  const rawLines = [...reduced.lines, {nodes: reduced.current, br: null}]

  return rawLines.map((line) => {
    return {...line, text: getTextFromNodes(line.nodes)}
  })
}

const isTimelineHeaderLine = (lineText: string): boolean => {
  return lineText.trim() === '## Timeline'
}

const isH2Line = (lineText: string): boolean => {
  return lineText.trim().startsWith('## ')
}

const isTimelineBucketHeadingLine = (lineText: string): boolean => {
  return lineText.trim().startsWith('### ')
}

const getTimelineBucketKey = (lineText: string): string => {
  return lineText.trim()
}

const appendNodes = (parent: ParentNode, nodes: Node[]) => {
  for (const node of nodes) {
    parent.appendChild(node)
  }
}

const appendLine = (parent: ParentNode, line: HtmlLine) => {
  appendNodes(parent, line.nodes)
  if (line.br) {
    parent.appendChild(line.br)
  }
}

const createTimelineToggleButton = ({
  collapsed,
  onToggle,
}: {
  collapsed: boolean
  onToggle: () => void
}): HTMLButtonElement => {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'patient-timeline-toggle'
  button.setAttribute('aria-expanded', String(!collapsed))
  button.setAttribute('aria-label', collapsed ? 'Expand timeline section' : 'Collapse timeline section')
  button.textContent = collapsed ? '+' : '-'
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    onToggle()
  })
  return button
}

const buildEnhancedPatientTimelineFragment = (params: {
  html: string
  collapsedByBucketKey: Map<string, boolean>
  defaultCollapsed: boolean
}): DocumentFragment => {
  const lines = splitHtmlIntoLines(params.html)
  const timelineHeaderIndex = lines.findIndex((l) => {
    return isTimelineHeaderLine(l.text)
  })

  if (timelineHeaderIndex === -1) {
    const fragment = document.createDocumentFragment()
    lines.forEach((line) => {
      return appendLine(fragment, line)
    })
    return fragment
  }

  const afterTimelineHeader = lines.slice(timelineHeaderIndex + 1)
  const timelineEndOffset = afterTimelineHeader.findIndex((l) => {
    return isH2Line(l.text) && !isTimelineHeaderLine(l.text)
  })
  const timelineEndIndex = timelineEndOffset === -1 ? lines.length : timelineHeaderIndex + 1 + timelineEndOffset

  const fragment = document.createDocumentFragment()

  const before = lines.slice(0, timelineHeaderIndex + 1)
  before.forEach((line) => {
    return appendLine(fragment, line)
  })

  const timelineLines = lines.slice(timelineHeaderIndex + 1, timelineEndIndex)
  const after = lines.slice(timelineEndIndex)

  let i = 0
  while (i < timelineLines.length) {
    const line = timelineLines[i]
    if (!line) {
      i += 1
      continue
    }

    if (!isTimelineBucketHeadingLine(line.text)) {
      appendLine(fragment, line)
      i += 1
      continue
    }

    const key = getTimelineBucketKey(line.text)
    const currentCollapsed = params.collapsedByBucketKey.get(key) ?? params.defaultCollapsed
    params.collapsedByBucketKey.set(key, currentCollapsed)

    const heading = document.createElement('span')
    heading.className = 'patient-timeline-bucket-heading'
    heading.dataset.timelineBucketKey = key

    appendNodes(heading, line.nodes)

    const body = document.createElement('span')
    body.className = 'inline'
    body.dataset.timelineBucketBodyKey = key
    body.hidden = currentCollapsed

    const setCollapsed = (collapsed: boolean) => {
      body.hidden = collapsed
      toggleButton.textContent = collapsed ? '+' : '-'
      toggleButton.setAttribute('aria-expanded', String(!collapsed))
      toggleButton.setAttribute('aria-label', collapsed ? 'Expand timeline section' : 'Collapse timeline section')
    }

    const toggleButton = createTimelineToggleButton({
      collapsed: currentCollapsed,
      onToggle: () => {
        const next = !(params.collapsedByBucketKey.get(key) ?? params.defaultCollapsed)
        params.collapsedByBucketKey.set(key, next)
        setCollapsed(next)
      },
    })

    heading.appendChild(toggleButton)
    fragment.appendChild(heading)
    fragment.appendChild(line.br ?? document.createElement('br'))

    let j = i + 1
    while (j < timelineLines.length) {
      const next = timelineLines[j]
      if (!next) {
        j += 1
        continue
      }
      if (isTimelineBucketHeadingLine(next.text)) {
        break
      }
      appendLine(body, next)
      j += 1
    }

    fragment.appendChild(body)
    i = j
  }

  after.forEach((line) => {
    return appendLine(fragment, line)
  })

  return fragment
}

const setEnhancedTimelineHtml = (params: {
  root: HTMLDivElement
  html: string
  collapsedByBucketKey: Map<string, boolean>
  defaultCollapsed: boolean
}) => {
  const fragment = buildEnhancedPatientTimelineFragment(params)
  params.root.replaceChildren(fragment)
}

type ReviewArticleDetailsPatientTimelineExpandableProps = {
  html: string
  collapsedByBucketKey: Map<string, boolean>
  defaultCollapsed?: boolean
}

export const ReviewArticleDetailsPatientTimelineExpandable = (
  props: ReviewArticleDetailsPatientTimelineExpandableProps,
) => {
  let root: HTMLDivElement | undefined

  const apply = () => {
    const el = root
    return el
      ? setEnhancedTimelineHtml({
          root: el,
          html: props.html,
          collapsedByBucketKey: props.collapsedByBucketKey,
          defaultCollapsed: props.defaultCollapsed ?? true,
        })
      : undefined
  }

  createEffect(() => {
    const html = props.html
    if (!html) return
    return apply()
  })

  return (
    <div
      ref={(el) => {
        root = el
        apply()
      }}
    />
  )
}
