import {expect, test} from 'bun:test'

import {getTokenTimelineDisplayData, type TimeInterval, type TokenTimelineData} from './TokenUsageTimeline.tsx'

const getBucket = (params: {
  count?: number
  interval?: TimeInterval
  timestamp: string
  totalCompletionTokens?: number
  totalPromptTokens?: number
  totalRequests?: number
  totalTokens?: number
}): TokenTimelineData => {
  return {
    count: params.count ?? 0,
    timestamp: params.timestamp,
    totalCompletionTokens: params.totalCompletionTokens ?? 0,
    totalPromptTokens: params.totalPromptTokens ?? 0,
    totalRequests: params.totalRequests ?? 0,
    totalTokens: params.totalTokens ?? 0,
  }
}

const getDisplayedTimestamps = (params: {data: TokenTimelineData[]; interval: TimeInterval; now: Date}) => {
  return getTokenTimelineDisplayData(params).map((bucket) => {
    return bucket.timestamp
  })
}

test('one minute timeline drops a trailing empty current-minute bucket', () => {
  const now = new Date('2026-04-28T12:44:30.000Z')
  const data = [
    getBucket({timestamp: '2026-04-28T12:42:00.000Z', totalPromptTokens: 100, totalRequests: 1, totalTokens: 100}),
    getBucket({timestamp: '2026-04-28T12:43:00.000Z'}),
    getBucket({timestamp: '2026-04-28T12:44:00.000Z'}),
  ]

  expect(getDisplayedTimestamps({data, interval: '1min', now})).toEqual([
    '2026-04-28T12:42:00.000Z',
    '2026-04-28T12:43:00.000Z',
  ])
})

test('one minute timeline keeps a non-empty current-minute bucket', () => {
  const now = new Date('2026-04-28T12:44:30.000Z')
  const data = [
    getBucket({timestamp: '2026-04-28T12:43:00.000Z'}),
    getBucket({timestamp: '2026-04-28T12:44:00.000Z', totalPromptTokens: 100, totalRequests: 1, totalTokens: 100}),
  ]

  expect(getDisplayedTimestamps({data, interval: '1min', now})).toEqual([
    '2026-04-28T12:43:00.000Z',
    '2026-04-28T12:44:00.000Z',
  ])
})

test('one minute timeline keeps a trailing empty completed-minute bucket', () => {
  const now = new Date('2026-04-28T12:44:30.000Z')
  const data = [
    getBucket({timestamp: '2026-04-28T12:42:00.000Z', totalPromptTokens: 100, totalRequests: 1, totalTokens: 100}),
    getBucket({timestamp: '2026-04-28T12:43:00.000Z'}),
  ]

  expect(getDisplayedTimestamps({data, interval: '1min', now})).toEqual([
    '2026-04-28T12:42:00.000Z',
    '2026-04-28T12:43:00.000Z',
  ])
})

test('larger timelines keep the trailing empty current bucket for progress display', () => {
  const now = new Date('2026-04-28T12:44:30.000Z')
  const data = [
    getBucket({timestamp: '2026-04-28T12:35:00.000Z', totalPromptTokens: 100, totalRequests: 1, totalTokens: 100}),
    getBucket({timestamp: '2026-04-28T12:44:00.000Z'}),
  ]

  expect(getDisplayedTimestamps({data, interval: '5min', now})).toEqual([
    '2026-04-28T12:35:00.000Z',
    '2026-04-28T12:44:00.000Z',
  ])
})
