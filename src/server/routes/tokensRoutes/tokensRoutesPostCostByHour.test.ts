import {describe, expect, mock, test} from 'bun:test'

const getProviderCostByHourSpy = mock(async () => {
  return {costHours: [], quotaHours: []}
})

void mock.module('../../services/providerCostQueryService.ts', () => {
  return {getProviderCostByHour: getProviderCostByHourSpy}
})

const {getCostByHourQuery, tokensRoutesPostCostByHour} = await import('./tokensRoutesPostCostByHour.ts')

describe('getCostByHourQuery', () => {
  test('returns an open query for an empty body', () => {
    expect(getCostByHourQuery({})).toEqual({error: null, query: {from: null, jobId: null, to: null}})
  })

  test('parses valid ISO from and to into dates', () => {
    expect(getCostByHourQuery({from: '2026-11-06T00:00:00.000Z', to: '2026-11-06T00:00:00.001Z'})).toEqual({
      error: null,
      query: {from: new Date('2026-11-06T00:00:00.000Z'), jobId: null, to: new Date('2026-11-06T00:00:00.001Z')},
    })
  })

  test('accepts only one of from and to', () => {
    expect(getCostByHourQuery({from: '2026-11-06T00:00:00.000Z'}).query).toEqual({
      from: new Date('2026-11-06T00:00:00.000Z'),
      jobId: null,
      to: null,
    })
    expect(getCostByHourQuery({to: '2026-11-06T00:00:00.000Z'}).query).toEqual({
      from: null,
      jobId: null,
      to: new Date('2026-11-06T00:00:00.000Z'),
    })
  })

  test('rejects from equal to to', () => {
    expect(getCostByHourQuery({from: '2026-11-06T00:00:00.000Z', to: '2026-11-06T00:00:00.000Z'})).toEqual({
      error: 'from must be before to',
      query: null,
    })
  })

  test('rejects from after to', () => {
    expect(getCostByHourQuery({from: '2026-11-06T00:00:00.001Z', to: '2026-11-06T00:00:00.000Z'})).toEqual({
      error: 'from must be before to',
      query: null,
    })
  })

  test('rejects an invalid date in from or to', () => {
    const invalidResult = {error: 'from and to must be ISO 8601 timestamps', query: null}

    expect(getCostByHourQuery({from: 'not a date'})).toEqual(invalidResult)
    expect(getCostByHourQuery({to: '2026-13-45T99:00:00Z'})).toEqual(invalidResult)
    expect(getCostByHourQuery({from: '', to: '2026-11-06T00:00:00.000Z'})).toEqual(invalidResult)
  })

  test('trims jobId and treats a blank jobId as null', () => {
    expect(getCostByHourQuery({jobId: '  job-123  '}).query?.jobId).toBe('job-123')
    expect(getCostByHourQuery({jobId: '   '}).query?.jobId).toBeNull()
    expect(getCostByHourQuery({jobId: ''}).query?.jobId).toBeNull()
  })
})

describe('tokensRoutesPostCostByHour', () => {
  test('responds 400 without calling the service for an invalid body', async () => {
    const set = {headers: {}} as Parameters<typeof tokensRoutesPostCostByHour>[0]['set']

    expect(
      await tokensRoutesPostCostByHour({body: {from: '2026-11-06T01:00:00.000Z', to: '2026-11-06T00:00:00.000Z'}, set}),
    ).toEqual({data: null, error: 'from must be before to'})
    expect(set.status).toBe(400)
    expect(getProviderCostByHourSpy).not.toHaveBeenCalled()
  })
})
