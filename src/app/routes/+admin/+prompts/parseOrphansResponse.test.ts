import {expect, test} from 'bun:test'

import {type OrphanPromptSummary, parseOrphansResponse} from './parseOrphansResponse'

const toPromptSummary = (value: unknown): OrphanPromptSummary | null => {
  const id = (value as {id?: unknown} | null)?.id

  return typeof id === 'string'
    ? {
        id,
        promptHeading: null,
        originalText: null,
        type: null,
        createdAt: '',
        usage: {projects: 0, judgments: 0, humanJudgments: 0},
      }
    : null
}

test('parseOrphansResponse keeps the fully orphaned list returned by the server', () => {
  const parsed = parseOrphansResponse(
    {noProjects: [{id: 'a'}, {id: 'c'}], noJudgments: [{id: 'b'}, {id: 'c'}], noProjectsAndJudgments: [{id: 'c'}]},
    toPromptSummary,
  )

  expect(
    parsed.noProjectsAndJudgments.map((prompt) => {
      return prompt.id
    }),
  ).toEqual(['c'])
  expect(parsed.noProjects).toHaveLength(2)
  expect(parsed.noJudgments).toHaveLength(2)
})

test('parseOrphansResponse drops malformed rows and tolerates missing lists', () => {
  const parsed = parseOrphansResponse({noProjects: [{id: 'a'}, {nope: true}, null]}, toPromptSummary)

  expect(parsed.noProjects).toHaveLength(1)
  expect(parsed.noJudgments).toEqual([])
  expect(parsed.noProjectsAndJudgments).toEqual([])
  expect(parseOrphansResponse(null, toPromptSummary)).toEqual({
    noProjects: [],
    noJudgments: [],
    noProjectsAndJudgments: [],
  })
})
