import {createEffect} from 'solid-js'

type HtmlLine = {nodes: Node[]; br: HTMLBRElement | null; text: string}
type TimelineBucketMatch = {key: string; text: string}

const patientTimelineToggleClassName = 'patient-timeline-toggle'
const timelineBucketBodySelector = '[data-timeline-bucket-body-key]'

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

const setTimelineToggleButtonState = (button: HTMLButtonElement, collapsed: boolean) => {
  button.textContent = collapsed ? '+' : '-'
  button.setAttribute('aria-expanded', String(!collapsed))
  button.setAttribute('aria-label', collapsed ? 'Expand timeline section' : 'Collapse timeline section')
}

const getPreviousTimelineBucketHeading = (element: Element | null): HTMLElement | undefined => {
  const previous = element?.previousElementSibling
  if (!previous) return undefined
  return previous instanceof HTMLElement && previous.dataset.timelineBucketKey
    ? previous
    : getPreviousTimelineBucketHeading(previous)
}

const normalizePatientTimelineText = (text: string): string => {
  const trimmed = text.replace(/^[\s"“”']+|[\s"“”']+$/g, '').trim()
  const withoutEllipses = trimmed.replace(/^(?:\.{3}|…)+|(?:\.{3}|…)+$/g, '').trim()
  const withSpaces = withoutEllipses.replace(/\u00A0/g, ' ')
  const withNormalizedHyphens = withSpaces.replace(/[\u00AD\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
  const withNormalizedTimes = withNormalizedHyphens.replace(/\u00D7/g, 'x')
  return withNormalizedTimes.toLowerCase().replace(/\s+/g, ' ').trim()
}

const getTimelineLines = (html: string): HtmlLine[] => {
  const lines = splitHtmlIntoLines(html)
  const timelineHeaderIndex = lines.findIndex((l) => {
    return isTimelineHeaderLine(l.text)
  })

  if (timelineHeaderIndex === -1) return []

  const afterTimelineHeader = lines.slice(timelineHeaderIndex + 1)
  const timelineEndOffset = afterTimelineHeader.findIndex((l) => {
    return isH2Line(l.text) && !isTimelineHeaderLine(l.text)
  })
  const timelineEndIndex = timelineEndOffset === -1 ? lines.length : timelineHeaderIndex + 1 + timelineEndOffset
  return lines.slice(timelineHeaderIndex + 1, timelineEndIndex)
}

const getTimelineBucketMatches = (html: string): TimelineBucketMatch[] => {
  const timelineLines = getTimelineLines(html)
  const matches: TimelineBucketMatch[] = []
  let i = 0

  while (i < timelineLines.length) {
    const line = timelineLines[i]
    if (!line) {
      i += 1
      continue
    }

    if (!isTimelineBucketHeadingLine(line.text)) {
      i += 1
      continue
    }

    const key = getTimelineBucketKey(line.text)
    let text = ''
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
      text += `${next.text}\n`
      j += 1
    }

    matches.push({key, text})
    i = j
  }

  return matches
}

const getTimelineBucketBodies = (root: ParentNode): HTMLElement[] => {
  return Array.from(root.querySelectorAll<HTMLElement>(timelineBucketBodySelector))
}

const expandTimelineBucketBody = (params: {
  body: HTMLElement
  collapsedByBucketKey: Map<string, boolean>
}): HTMLElement | undefined => {
  const bucketKey = params.body.dataset.timelineBucketBodyKey

  if (!bucketKey) return undefined

  params.collapsedByBucketKey.set(bucketKey, false)
  params.body.hidden = false

  const heading = getPreviousTimelineBucketHeading(params.body)
  const toggleButton = heading?.querySelector<HTMLButtonElement>(`.${patientTimelineToggleClassName}`)
  if (toggleButton) {
    setTimelineToggleButtonState(toggleButton, false)
  }

  return params.body
}

export const reviewArticleDetailsPatientTimelineGetBucketKeyForQuote = (params: {
  html: string
  quote: string
}): string | undefined => {
  const normalizedQuote = normalizePatientTimelineText(params.quote)
  if (!normalizedQuote) return undefined

  const initial = {score: 0, key: undefined as string | undefined}
  const reduced = getTimelineBucketMatches(params.html).reduce((acc, bucket) => {
    const normalizedText = normalizePatientTimelineText(bucket.text)
    if (!normalizedText) return acc

    const score = normalizedText.includes(normalizedQuote)
      ? normalizedQuote.length
      : normalizedQuote.includes(normalizedText)
        ? normalizedText.length
        : 0

    return score > acc.score ? {score, key: bucket.key} : acc
  }, initial)

  return reduced.key
}

export const reviewArticleDetailsPatientTimelineExpandBucket = (params: {
  root: ParentNode
  bucketKey: string
  collapsedByBucketKey: Map<string, boolean>
}): HTMLElement | undefined => {
  const body = getTimelineBucketBodies(params.root).find((candidate) => {
    return candidate.dataset.timelineBucketBodyKey === params.bucketKey
  })

  return body ? expandTimelineBucketBody({body, collapsedByBucketKey: params.collapsedByBucketKey}) : undefined
}

export const reviewArticleDetailsPatientTimelineExpandBucketForElement = (params: {
  element: HTMLElement
  collapsedByBucketKey: Map<string, boolean>
}): HTMLElement | undefined => {
  const body = params.element.closest<HTMLElement>('[data-timeline-bucket-body-key]')
  return body ? expandTimelineBucketBody({body, collapsedByBucketKey: params.collapsedByBucketKey}) : undefined
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
  button.className = patientTimelineToggleClassName
  setTimelineToggleButtonState(button, collapsed)
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
      setTimelineToggleButtonState(toggleButton, collapsed)
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
