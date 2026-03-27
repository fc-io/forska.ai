import {expect, test} from 'bun:test'

import {getBackgroundServerEnv, getBackgroundServerStackConfig} from './backgroundServerStack.ts'

test('background server stack defaults worker port to api port plus one', () => {
  expect(getBackgroundServerStackConfig({API_SERVER_PORT: '3001'})).toEqual({
    apiPort: 3001,
    workerPort: 3002,
    writerUrl: 'http://127.0.0.1:3002',
  })
})

test('background server stack honors an explicit worker port override', () => {
  expect(getBackgroundServerStackConfig({API_SERVER_PORT: '4100', BACKGROUND_WRITER_PORT: '5100'})).toEqual({
    apiPort: 4100,
    workerPort: 5100,
    writerUrl: 'http://127.0.0.1:5100',
  })
})

test('background server stack builds api env that proxies to the worker', () => {
  expect(
    getBackgroundServerEnv({baseEnv: {API_SERVER_PORT: '3301', BACKGROUND_WRITER_PORT: '3302'}, role: 'api'}),
  ).toMatchObject({API_SERVER_PORT: '3301', SERVER_ROLE: 'api', SERVER_WRITER_URL: 'http://127.0.0.1:3302'})
})

test('background server stack builds worker env on the sibling port', () => {
  expect(
    getBackgroundServerEnv({baseEnv: {API_SERVER_PORT: '3301', BACKGROUND_WRITER_PORT: '3302'}, role: 'worker'}),
  ).toMatchObject({API_SERVER_PORT: '3302', SERVER_ROLE: 'worker', SERVER_WRITER_URL: ''})
})
