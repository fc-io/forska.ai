import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'

export const hashDistributionInput = (bytes: Uint8Array) => {
  return createHash('sha256').update(bytes).digest('hex')
}

export const getDistributionIntegrity = (bytes: Uint8Array) => {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

export const assertDistributionHash = (bytes: Uint8Array, expected: string, label: string) => {
  assert.match(expected, /^[a-f0-9]{64}$/, `${label}: expected a pinned SHA-256`)
  assert.equal(hashDistributionInput(bytes), expected, `${label}: checksum mismatch`)
}
