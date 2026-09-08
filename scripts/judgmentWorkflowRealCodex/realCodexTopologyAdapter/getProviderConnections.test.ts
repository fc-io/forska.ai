import {expect, test} from 'bun:test'

import {getProviderConnections} from './getProviderConnections.ts'

test('reads the provider connection list without confusing catalog or runtime metadata with connections', () => {
  const connection = {id: 'codex-connection', providerKind: 'codex', authMode: 'codex-cli'}
  expect(
    getProviderConnections({
      data: {catalog: [{providerKind: 'codex'}], connections: [connection], runtime: null},
      error: null,
    }),
  ).toEqual([connection])
  expect(getProviderConnections({data: {catalog: [], connections: [], runtime: null}, error: null})).toEqual([])
})

test.each([{data: []}, {data: null}, {data: {connections: null}}, {error: 'unavailable'}])(
  'rejects malformed provider responses instead of reporting an absent Codex connection: %j',
  (body) => {
    expect(() => {
      return getProviderConnections(body)
    }).toThrow('Provider connections response')
  },
)

test('rejects malformed list entries at the HTTP boundary', () => {
  expect(() => {
    return getProviderConnections({data: {connections: [null]}})
  }).toThrow('non-object connection')
})
