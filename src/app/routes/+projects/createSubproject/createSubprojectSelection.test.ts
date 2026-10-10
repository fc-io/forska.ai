import {describe, expect, test} from 'bun:test'

import {getPromptAnswerTypesWithoutProject, getSubprojectDateRangeError} from './createSubprojectSelection.ts'

const sources = [
  {id: 'parent', prompts: [{id: 'shared-prompt'}, {id: 'parent-only-prompt'}]},
  {id: 'child', prompts: [{id: 'shared-prompt'}, {id: 'child-only-prompt'}]},
]

describe('getPromptAnswerTypesWithoutProject', () => {
  test('keeps answer types for prompts still provided by another selected project', () => {
    expect(
      getPromptAnswerTypesWithoutProject({
        projectId: 'child',
        promptAnswerTypes: {'shared-prompt': ['yes'], 'child-only-prompt': ['no'], 'parent-only-prompt': ['unsure']},
        selectedProjectIds: ['parent', 'child'],
        sources,
      }),
    ).toEqual({'shared-prompt': ['yes'], 'parent-only-prompt': ['unsure']})
  })

  test('removes every prompt of the project when it was the only selected source', () => {
    expect(
      getPromptAnswerTypesWithoutProject({
        projectId: 'child',
        promptAnswerTypes: {'shared-prompt': ['yes'], 'child-only-prompt': ['no']},
        selectedProjectIds: ['child'],
        sources,
      }),
    ).toEqual({})
  })

  test('leaves answer types untouched when the project is unknown', () => {
    expect(
      getPromptAnswerTypesWithoutProject({
        projectId: 'missing',
        promptAnswerTypes: {'shared-prompt': ['yes']},
        selectedProjectIds: ['parent', 'missing'],
        sources: undefined,
      }),
    ).toEqual({'shared-prompt': ['yes']})
  })
})

describe('getSubprojectDateRangeError', () => {
  test('rejects a start date after the end date', () => {
    expect(getSubprojectDateRangeError('2024-06-01', '2024-01-01')).toBe('Start date must be on or before the end date')
  })

  test('accepts equal dates, ordered dates, and open ranges', () => {
    expect(getSubprojectDateRangeError('2024-01-01', '2024-01-01')).toBeNull()
    expect(getSubprojectDateRangeError('2024-01-01', '2024-06-01')).toBeNull()
    expect(getSubprojectDateRangeError('', '2024-01-01')).toBeNull()
    expect(getSubprojectDateRangeError('2024-06-01', '')).toBeNull()
    expect(getSubprojectDateRangeError('', '')).toBeNull()
  })
})
