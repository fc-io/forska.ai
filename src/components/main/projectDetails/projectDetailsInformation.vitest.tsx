// @vitest-environment happy-dom

import {render} from 'solid-js/web'
import {afterEach, expect, test} from 'vitest'

import {ProjectDetailsInformation} from './projectDetailsInformation.tsx'

const getProject = (humanJudgmentMode: 'prompt' | 'summary' | null = 'prompt', useMetadata = false) => {
  return {
    createdAt: '2026-06-01T10:00:00.000Z',
    dateFrom: null,
    dateTo: null,
    description: 'Project description',
    humanJudgmentMode,
    id: 'project-1',
    name: 'Project One',
    updatedAt: '2026-06-02T10:00:00.000Z',
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useMetadata,
    useTitle: true,
  }
}

const renderProjectDetailsInformation = (humanJudgmentMode: 'prompt' | 'summary' | null, useMetadata = false) => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return <ProjectDetailsInformation importRoutes={[]} project={getProject(humanJudgmentMode, useMetadata)} />
  }, container)

  return {container, dispose}
}

afterEach(() => {
  document.body.innerHTML = ''
})

test('shows summary mode for summary projects', () => {
  const {container, dispose} = renderProjectDetailsInformation('summary')

  try {
    expect(container.textContent).toContain('Human Review:')
    expect(container.textContent).toContain('Summary mode')
  } finally {
    dispose()
  }
})

test('shows prompt mode for non-summary projects', () => {
  const {container, dispose} = renderProjectDetailsInformation(null)

  try {
    expect(container.textContent).toContain('Human Review:')
    expect(container.textContent).toContain('Prompt mode')
  } finally {
    dispose()
  }
})

const getMetadataPill = (container: HTMLElement) => {
  return Array.from(container.querySelectorAll<HTMLSpanElement>('span')).find((element) => {
    return element.textContent?.startsWith('Article metadata')
  })
}

test('shows the article metadata content pill on when the project uses metadata', () => {
  const {container, dispose} = renderProjectDetailsInformation('prompt', true)

  try {
    const metadataPill = getMetadataPill(container)

    expect(metadataPill?.textContent).toBe('Article metadata on')
    expect(metadataPill?.className).toContain('bg-green-100')
  } finally {
    dispose()
  }
})

test('shows the article metadata content pill off when the project does not use metadata', () => {
  const {container, dispose} = renderProjectDetailsInformation('prompt', false)

  try {
    const metadataPill = getMetadataPill(container)

    expect(metadataPill?.textContent).toBe('Article metadata off')
    expect(metadataPill?.className).toContain('bg-gray-100')
  } finally {
    dispose()
  }
})
