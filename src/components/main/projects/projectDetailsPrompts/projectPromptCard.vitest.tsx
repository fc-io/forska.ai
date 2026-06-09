// @vitest-environment happy-dom

import {QueryClient, QueryClientProvider} from '@tanstack/solid-query'
import {render} from 'solid-js/web'
import {afterEach, expect, test, vi} from 'vitest'

import {type ProjectDetailsPrompt, ProjectPromptCard} from './projectPromptCard.tsx'

const mockedProjectServices = vi.hoisted(() => {
  return {fetchProjectPromptPreview: vi.fn()}
})

vi.mock('../../../../services/projectsService.ts', () => {
  return {fetchProjectPromptPreview: mockedProjectServices.fetchProjectPromptPreview}
})

const waitForCondition = async (assertion: () => void, remaining = 30): Promise<void> => {
  try {
    assertion()
  } catch (error) {
    if (remaining <= 0) {
      throw error
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
    return waitForCondition(assertion, remaining - 1)
  }
}

const getPrompt = (overrides: Partial<ProjectDetailsPrompt> = {}): ProjectDetailsPrompt => {
  return {
    archived: false,
    contentHash: null,
    created_at: '2026-06-09T00:00:00.000Z',
    enabled: true,
    id: 'prompt-1',
    linkedToProject: true,
    modelName: null,
    order: 1,
    original_text: 'Original prompt text',
    originProjectId: null,
    promptHeading: 'Healthcare',
    provider: null,
    transformed_text: undefined,
    type: `'yes' | 'no' | 'unsure'`,
    ...overrides,
  }
}

const renderProjectPromptCard = async (prompt: ProjectDetailsPrompt = getPrompt()) => {
  const queryClient = new QueryClient({defaultOptions: {queries: {retry: false}}})
  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return (
      <QueryClientProvider client={queryClient}>
        <ProjectPromptCard
          formatDate={() => {
            return 'Jun 9, 2026'
          }}
          projectId="project-1"
          prompt={prompt}
        />
      </QueryClientProvider>
    )
  }, container)

  await Promise.resolve()

  return {container, dispose, queryClient}
}

afterEach(() => {
  document.body.innerHTML = ''
  mockedProjectServices.fetchProjectPromptPreview.mockReset()
  vi.restoreAllMocks()
})

test('ProjectPromptCard toggles from original text to preview mode', async () => {
  mockedProjectServices.fetchProjectPromptPreview.mockResolvedValue({
    articleId: 'article-1',
    articleTitle: 'First article',
    previewText: '## System Prompt\n\nsystem\n\n## User Prompt\n\nuser',
    reason: null,
    status: 'ready',
    systemPrompt: 'system',
    userPrompt: 'user',
  })

  const {container, dispose, queryClient} = await renderProjectPromptCard()

  try {
    expect(container.textContent).toContain('Original prompt text')

    const previewButton = Array.from(container.querySelectorAll('button')).find((button) => {
      return button.textContent?.trim() === 'Preview Prompt'
    })

    previewButton?.click()

    await waitForCondition(() => {
      expect(mockedProjectServices.fetchProjectPromptPreview).toHaveBeenCalledWith('project-1', 'prompt-1')
      expect(container.textContent).toContain('Preview article: First article')
      expect(container.textContent).toContain('## System Prompt')
      expect(container.textContent).toContain('Show Original Text')
    })
  } finally {
    dispose()
    queryClient.clear()
    container.remove()
  }
})
