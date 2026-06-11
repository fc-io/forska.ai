// @vitest-environment happy-dom

import {render} from 'solid-js/web'
import {afterEach, expect, test} from 'vitest'

import {ProjectDetailsInformation} from './projectDetailsInformation.tsx'

const getProject = (humanJudgmentMode: 'prompt' | 'summary' | null = 'prompt') => {
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
    useTitle: true,
  }
}

const renderProjectDetailsInformation = (humanJudgmentMode: 'prompt' | 'summary' | null) => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return <ProjectDetailsInformation importRoutes={[]} project={getProject(humanJudgmentMode)} />
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
