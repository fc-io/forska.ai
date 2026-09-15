import {describe, expect, test} from 'bun:test'

import {createArticlesReviewsCountQueryOptions} from './projectsArticlesReviewsCountQuery.ts'

const accessor = <T>(value: T) => {
  return () => {
    return value
  }
}

describe('createArticlesReviewsCountQueryOptions', () => {
  const baseOptions = {
    covidenceConflictsOnly: accessor(false),
    covidenceDuplicatesOnly: accessor(false),
    fromDateStr: accessor(''),
    pageLimit: accessor(100),
    projectId: 'project-1',
    promptFilters: accessor({} as Record<string, string[] | null>),
    searchTitleApplied: accessor(''),
    toDateStr: accessor(''),
  }

  const createOptions = (
    overrides: Partial<typeof baseOptions> = {},
    llmStatus = accessor<'complete' | null>(null),
  ) => {
    const props = {...baseOptions, ...overrides}

    return createArticlesReviewsCountQueryOptions(
      props.projectId,
      props.covidenceDuplicatesOnly,
      props.covidenceConflictsOnly,
      props.promptFilters,
      props.pageLimit,
      props.fromDateStr,
      props.toDateStr,
      props.searchTitleApplied,
      llmStatus,
    )
  }

  test('polls cheap LLM status counts so open review pages reflect new completions', () => {
    const options = createOptions({}, accessor('complete'))

    expect(options.refetchInterval).toBe(15_000)
    expect(options.refetchOnMount).toBe('always')
    expect(options.refetchOnWindowFocus).toBe('always')
    expect(options.staleTime).toBe(15_000)
  })

  test('keeps expensive prompt and search filtered counts cached', () => {
    const promptFilteredOptions = createOptions({promptFilters: accessor({promptA: ['yes']})}, accessor('complete'))
    const searchFilteredOptions = createOptions({searchTitleApplied: accessor('heart failure')}, accessor('complete'))

    expect(promptFilteredOptions.refetchInterval).toBe(false)
    expect(promptFilteredOptions.refetchOnMount).toBeUndefined()
    expect(promptFilteredOptions.refetchOnWindowFocus).toBe(false)
    expect(promptFilteredOptions.staleTime).toBe(1000 * 60 * 5)
    expect(searchFilteredOptions.refetchInterval).toBe(false)
    expect(searchFilteredOptions.refetchOnMount).toBeUndefined()
    expect(searchFilteredOptions.refetchOnWindowFocus).toBe(false)
    expect(searchFilteredOptions.staleTime).toBe(1000 * 60 * 5)
  })
})
