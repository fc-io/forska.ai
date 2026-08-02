import {expect, test} from 'bun:test'

import {
  getPromptFilterControls,
  getPromptFilterLabel,
  getPromptFilterTitle,
  reconcileSchemaEnumSelections,
} from './reviewPromptFilterControls.ts'

test('getPromptFilterControls prefers server promptFilterDefinitions with debug state', () => {
  const response = {
    filters: [{answeredOriginalValues: ['legacy'], filterType: 'enum', promptId: 'legacy', promptName: 'Legacy'}],
    promptFilterDefinitions: [
      {
        articleReadinessState: 'slow',
        debugDisplayState: 'project/slow',
        kind: 'schemaEnum',
        label: 'Population Criteria',
        optionSourceState: 'schema',
        options: [
          {label: 'yes', value: 'yes'},
          {label: 'no', value: 'no'},
          {label: 'maybe', value: 'maybe'},
        ],
        promptId: 'population',
        source: 'project',
      },
    ],
  }

  const result = getPromptFilterControls(response)

  expect(result.controls).toEqual([
    {
      debugDisplayState: 'project/slow',
      kind: 'schemaEnum',
      label: 'Population Criteria',
      optionSourceState: 'schema',
      options: [
        {label: 'yes', value: 'yes'},
        {label: 'no', value: 'no'},
        {label: 'maybe', value: 'maybe'},
      ],
      promptId: 'population',
      readiness: 'slow',
      source: 'project',
    },
  ])
  const populationControl = result.controls[0]
  expect(populationControl).toBeDefined()
  if (!populationControl) {
    throw new Error('Expected population prompt control')
  }
  expect(getPromptFilterLabel(populationControl)).toBe('Population Criteria (project prompt)')
  expect(getPromptFilterTitle(populationControl)).toBe('Population Criteria (project prompt; Project schema options)')
})

test('getPromptFilterLabel and getPromptFilterTitle stay stable when prompt read readiness changes', () => {
  const slowControl = {
    articleReadinessState: 'slow',
    debugDisplayState: 'project/slow',
    kind: 'schemaEnum',
    label: 'Population Criteria',
    optionSourceState: 'schema',
    options: [{label: 'yes', value: 'yes'}],
    promptId: 'population',
    source: 'project',
  }
  const fastControl = {...slowControl, articleReadinessState: 'fast', debugDisplayState: 'project/fast'}

  const slowResult = getPromptFilterControls({promptFilterDefinitions: [slowControl]})
  const fastResult = getPromptFilterControls({promptFilterDefinitions: [fastControl]})
  const slowResultControl = slowResult.controls[0]
  const fastResultControl = fastResult.controls[0]

  if (!slowResultControl || !fastResultControl) {
    throw new Error('Expected schema prompt controls')
  }

  expect(getPromptFilterLabel(slowResultControl)).toBe('Population Criteria (project prompt)')
  expect(getPromptFilterLabel(fastResultControl)).toBe('Population Criteria (project prompt)')
  expect(getPromptFilterTitle(slowResultControl)).toBe('Population Criteria (project prompt; Project schema options)')
  expect(getPromptFilterTitle(fastResultControl)).toBe('Population Criteria (project prompt; Project schema options)')

  const slowIndexedControl = {
    ...slowControl,
    articleReadinessState: 'slow',
    debugDisplayState: 'mart/slow',
    optionSourceState: 'slow',
    source: 'mart',
  }
  const fastIndexedControl = {
    ...slowIndexedControl,
    articleReadinessState: 'fast',
    debugDisplayState: 'mart/fast',
    optionSourceState: 'fast',
  }
  const slowIndexedResult = getPromptFilterControls({promptFilterDefinitions: [slowIndexedControl]})
  const fastIndexedResult = getPromptFilterControls({promptFilterDefinitions: [fastIndexedControl]})
  const slowIndexedResultControl = slowIndexedResult.controls[0]
  const fastIndexedResultControl = fastIndexedResult.controls[0]

  if (!slowIndexedResultControl || !fastIndexedResultControl) {
    throw new Error('Expected indexed prompt controls')
  }

  expect(getPromptFilterLabel(slowIndexedResultControl)).toBe('Population Criteria (review index)')
  expect(getPromptFilterLabel(fastIndexedResultControl)).toBe('Population Criteria (review index)')
  expect(getPromptFilterTitle(slowIndexedResultControl)).toBe(
    'Population Criteria (review index; Indexed answer options)',
  )
  expect(getPromptFilterTitle(fastIndexedResultControl)).toBe(
    'Population Criteria (review index; Indexed answer options)',
  )

  const renderedText = [
    getPromptFilterLabel(slowResultControl),
    getPromptFilterTitle(slowResultControl),
    getPromptFilterLabel(slowIndexedResultControl),
    getPromptFilterTitle(slowIndexedResultControl),
  ].join(' ')

  expect(renderedText).not.toContain('fast')
  expect(renderedText).not.toContain('slow')
})

test('getPromptFilterControls keeps legacy enum and numeric filter compatibility', () => {
  const filters = [
    {answeredOriginalValues: ['include'], filterType: 'enum', promptId: 'prompt-1', promptName: 'Prompt 1'},
    {
      bins: [{label: '1-5', max: 5, min: 1}],
      filterType: 'numeric',
      promptId: 'prompt-2',
      promptName: 'Prompt 2',
      specialValues: ['unknown'],
    },
  ]
  const result = getPromptFilterControls({filters})

  expect(result.controls).toEqual([
    {kind: 'openString', label: 'Prompt 1', options: [{label: 'include', value: 'include'}], promptId: 'prompt-1'},
    {
      kind: 'numeric',
      label: 'Prompt 2',
      options: [
        {label: '1-5', value: 'bin:1:5'},
        {label: 'unknown', value: 'unknown'},
      ],
      promptId: 'prompt-2',
    },
  ])
  expect(getPromptFilterControls(filters).controls).toEqual(result.controls)
})

test('an authoritative empty definition list does not fall back to legacy filters', () => {
  const result = getPromptFilterControls({
    filters: [{answeredOriginalValues: ['include'], promptId: 'legacy', promptName: 'Legacy'}],
    promptFilterDefinitions: [],
  })

  expect(result.controls).toEqual([])
})

test('reconcileSchemaEnumSelections only removes invalid schema enum values', () => {
  const previous = {open: ['free text'], population: ['yes', 'invalid'], summary: ['bookmarked']}
  const controls = [
    {
      kind: 'schemaEnum' as const,
      label: 'Population Criteria',
      optionSourceState: 'schema' as const,
      options: [{label: 'yes', value: 'yes'}],
      promptId: 'population',
    },
    {kind: 'openString' as const, label: 'Open', options: [], promptId: 'open'},
    {
      kind: 'schemaEnum' as const,
      label: 'Summary',
      optionSourceState: 'fast' as const,
      options: [{label: 'include', value: 'include'}],
      promptId: 'summary',
    },
  ]

  expect(reconcileSchemaEnumSelections(previous, controls)).toEqual({
    open: ['free text'],
    population: ['yes'],
    summary: ['bookmarked'],
  })

  const alreadyValid = {population: ['yes']}
  expect(reconcileSchemaEnumSelections(alreadyValid, controls)).toBe(alreadyValid)
})
