import {expect, test} from 'bun:test'

import {
  covidenceImportMaxReferencesPerFile,
  getCovidenceImportPartCount,
  getCovidenceImportPartSegments,
} from './covidenceImportLimits.ts'

const getRecords = (count: number, firstRecord = 0) => {
  return Array.from({length: count}, (_, index) => {
    return firstRecord + index
  })
}

const getSegmentShape = (records: readonly number[], firstRecordIndex: number, maxRecordsPerFile: number) => {
  return getCovidenceImportPartSegments(records, firstRecordIndex, maxRecordsPerFile).map((segment) => {
    return {partIndex: segment.partIndex, records: segment.records}
  })
}

const getPartRecordsFromBatches = (batchSizes: readonly number[], maxRecordsPerFile: number) => {
  const batches = batchSizes.reduce<{batches: number[][]; nextRecord: number}>(
    (state, batchSize) => {
      return {
        batches: [...state.batches, getRecords(batchSize, state.nextRecord)],
        nextRecord: state.nextRecord + batchSize,
      }
    },
    {batches: [], nextRecord: 0},
  ).batches

  return batches
    .reduce<{firstRecordIndex: number; segments: Array<{partIndex: number; records: number[]}>}>(
      (state, batch) => {
        return {
          firstRecordIndex: state.firstRecordIndex + batch.length,
          segments: [...state.segments, ...getSegmentShape(batch, state.firstRecordIndex, maxRecordsPerFile)],
        }
      },
      {firstRecordIndex: 0, segments: []},
    )
    .segments.reduce<number[][]>((parts, segment) => {
      parts[segment.partIndex] = [...(parts[segment.partIndex] ?? []), ...segment.records]
      return parts
    }, [])
}

test('Covidence accepts at most 15,000 references per import file', () => {
  expect(covidenceImportMaxReferencesPerFile).toBe(15_000)
})

test('the part count is one file up to the limit and one more file per started limit after it', () => {
  expect(
    [0, 1, 14_999, 15_000, 15_001, 29_999, 30_000, 30_001].map((recordCount) => {
      return getCovidenceImportPartCount(recordCount)
    }),
  ).toEqual([1, 1, 1, 1, 2, 2, 2, 3])
  expect(
    [0, 3, 4, 6, 7].map((recordCount) => {
      return getCovidenceImportPartCount(recordCount, 3)
    }),
  ).toEqual([1, 1, 2, 2, 3])
})

test('a batch inside one part stays one segment of that part', () => {
  expect(getSegmentShape([4, 5], 4, 3)).toEqual([{partIndex: 1, records: [4, 5]}])
  expect(getSegmentShape([0, 1, 2], 0, 3)).toEqual([{partIndex: 0, records: [0, 1, 2]}])
  expect(getSegmentShape([], 7, 3)).toEqual([])
})

test('a batch is cut exactly where a part reaches the limit', () => {
  expect(getSegmentShape([2, 3, 4, 5, 6, 7, 8, 9], 2, 3)).toEqual([
    {partIndex: 0, records: [2]},
    {partIndex: 1, records: [3, 4, 5]},
    {partIndex: 2, records: [6, 7, 8]},
    {partIndex: 3, records: [9]},
  ])
  expect(getSegmentShape([3], 3, 3)).toEqual([{partIndex: 1, records: [3]}])
})

test('the default limit cuts a batch after record 15,000', () => {
  const segments = getCovidenceImportPartSegments(getRecords(3, 14_999), 14_999)

  expect(
    segments.map((segment) => {
      return {partIndex: segment.partIndex, records: segment.records}
    }),
  ).toEqual([
    {partIndex: 0, records: [14_999]},
    {partIndex: 1, records: [15_000, 15_001]},
  ])
})

test('uneven batches put every record in exactly one part, in order, with at most the limit per part', () => {
  const parts = getPartRecordsFromBatches([2, 5, 1, 0, 7, 3], 4)

  expect(parts).toEqual([getRecords(4), getRecords(4, 4), getRecords(4, 8), getRecords(4, 12), getRecords(2, 16)])
  expect(parts.flat()).toEqual(getRecords(18))
  expect(parts).toHaveLength(getCovidenceImportPartCount(18, 4))
})
