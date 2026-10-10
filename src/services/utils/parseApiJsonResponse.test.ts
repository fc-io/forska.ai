import {expect, test} from 'bun:test'

import {parseApiJsonResponse, reviveApiJsonValue} from './parseApiJsonResponse.ts'

const getJsonResponse = (body: unknown, init: ResponseInit = {}) => {
  return new Response(JSON.stringify(body), {headers: {'Content-Type': 'application/json; charset=utf-8'}, ...init})
}

test('revives only full ISO-8601 timestamps with a time zone', () => {
  expect(reviveApiJsonValue('setAt', '2026-10-10T12:00:00.000Z')).toEqual(new Date('2026-10-10T12:00:00.000Z'))
  expect(reviveApiJsonValue('setAt', '2026-10-10T14:00:00+02:00')).toEqual(new Date('2026-10-10T12:00:00.000Z'))
  expect(reviveApiJsonValue('setAt', '2026-10-10T12:00Z')).toEqual(new Date('2026-10-10T12:00:00.000Z'))
  expect(
    [
      '2026-10-10',
      '10/10/2026',
      '2026/10/10 3:15 PM',
      '3 4 2025',
      '"2026-10-10"',
      '2026-10-10T12:00:00',
      '2026-10-10 22:32:52.19246+02',
      'Sat Oct 10 2026 12:00:00 GMT+0200 (Central European Summer Time)',
      'Checked 2026-10-10T12:00:00Z',
      '2026-13-45T99:99:99Z',
    ].map((value) => {
      return reviveApiJsonValue('setAt', value)
    }),
  ).toEqual([
    '2026-10-10',
    '10/10/2026',
    '2026/10/10 3:15 PM',
    '3 4 2025',
    '"2026-10-10"',
    '2026-10-10T12:00:00',
    '2026-10-10 22:32:52.19246+02',
    'Sat Oct 10 2026 12:00:00 GMT+0200 (Central European Summer Time)',
    'Checked 2026-10-10T12:00:00Z',
    '2026-13-45T99:99:99Z',
  ])
})

test('never revives free-text keys, even when the text is an exact timestamp', () => {
  expect(
    ['comment', 'name', 'articleTitle', 'description', 'reviewerDisplayName', 'label', 'originalText', 'note'].map(
      (key) => {
        return reviveApiJsonValue(key, '2026-10-10T12:00:00.000Z')
      },
    ),
  ).toEqual(
    Array.from({length: 8}, () => {
      return '2026-10-10T12:00:00.000Z'
    }),
  )
})

test('parses successful JSON responses with the reviver and leaves other responses to Eden', async () => {
  const parsed = (await parseApiJsonResponse(
    getJsonResponse({data: {comment: '2026-10-10', commentUpdatedAt: '2026-10-10T12:00:00.000Z', name: '10/10/2026'}}),
  )) as {data: {comment: unknown; commentUpdatedAt: unknown; name: unknown}}

  expect(parsed.data.comment).toBe('2026-10-10')
  expect(parsed.data.name).toBe('10/10/2026')
  expect(parsed.data.commentUpdatedAt).toEqual(new Date('2026-10-10T12:00:00.000Z'))
  expect(await parseApiJsonResponse(getJsonResponse({error: 'Bad request'}, {status: 400}))).toBeNull()
  expect(await parseApiJsonResponse(new Response('2026-10-10', {headers: {'Content-Type': 'text/plain'}}))).toBeNull()
})
