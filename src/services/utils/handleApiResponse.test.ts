import {expect, test} from 'bun:test'

import {handleApiResponse} from './handleApiResponse.ts'

test('handleApiResponse returns data for successful responses', () => {
  const result = handleApiResponse({data: {data: {id: 'article-1'}}})

  expect(result).toEqual({data: {id: 'article-1'}})
})

test('handleApiResponse allows raw domain objects with error fields', () => {
  const result = handleApiResponse({data: {error: [], id: 'job-1'}})

  expect(result).toEqual({error: [], id: 'job-1'})
})

test('handleApiResponse preserves nested API envelope errors with fallback data', () => {
  const getResult = () => {
    return handleApiResponse({data: {data: [], error: 'Failed to fetch tokens'}}, 'Failed to load tokens')
  }

  expect(getResult).toThrow('Failed to fetch tokens')
})

test('handleApiResponse uses nested treaty error messages', () => {
  const getResult = () => {
    return handleApiResponse(
      {error: {value: {data: null, error: 'No articles left to judge'}, message: {summary: 'Not Found'}}},
      'Failed to initialize human assessment',
    )
  }

  expect(getResult).toThrow('No articles left to judge')
})

test('handleApiResponse skips stringified object treaty error messages', () => {
  const getResult = () => {
    return handleApiResponse(
      {error: {value: {data: null, error: 'Project transfer export failed'}, message: '[object Object]'}},
      'Failed to fetch project transfer export status',
    )
  }

  expect(getResult).toThrow('Project transfer export failed')
})
