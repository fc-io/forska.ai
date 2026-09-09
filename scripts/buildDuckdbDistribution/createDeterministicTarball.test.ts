import {gunzipSync} from 'node:zlib'

import {expect, test} from 'bun:test'

import {createDeterministicTarball} from './createDeterministicTarball'

test('target gzip OS normalization changes only header byte9 and leaves full canonical tar and compressed payload exact', () => {
  const files = {'package/example': new TextEncoder().encode('portable immutable input')}
  const portable = createDeterministicTarball(files)
  expect(portable[9]).toBe(255)
  for (const [platform, operatingSystem] of Object.entries({linux: 3, darwin: 19, win32: 10})) {
    const target = createDeterministicTarball(files, platform)
    expect(target[9]).toBe(operatingSystem)
    expect(gunzipSync(target)).toEqual(gunzipSync(portable))
    const normalized = Buffer.from(target)
    normalized[9] = 255
    expect(normalized).toEqual(portable)
  }
  expect(() => {
    return createDeterministicTarball(files, 'unreviewed-platform')
  }).toThrow('Unsupported gzip target platform')
})
