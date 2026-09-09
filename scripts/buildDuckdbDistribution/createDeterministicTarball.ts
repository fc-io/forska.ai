import assert from 'node:assert/strict'
import {gzipSync} from 'node:zlib'

const writeOctal = (header: Buffer, value: number, offset: number, length: number) => {
  const encoded = value.toString(8).padStart(length - 1, '0')
  assert.ok(encoded.length < length, 'tar numeric field overflow')
  header.write(encoded, offset, length - 1, 'ascii')
}

const createEntry = ([name, contents]: [string, Uint8Array]) => {
  assert.match(name, /^(?:package\/)?[a-zA-Z0-9_.-]+$/, 'package entries must be flat regular files')
  assert.ok(Buffer.byteLength(name) < 100, 'package filename exceeds ustar limit')
  const header = Buffer.alloc(512)
  header.write(name)
  writeOctal(header, 0o644, 100, 8)
  writeOctal(header, 0, 108, 8)
  writeOctal(header, 0, 116, 8)
  writeOctal(header, contents.byteLength, 124, 12)
  writeOctal(header, 0, 136, 12)
  header.fill(32, 148, 156)
  header.write('0', 156)
  header.write('ustar\0', 257)
  header.write('00', 263)
  const checksum = header.reduce((sum, byte) => {
    return sum + byte
  }, 0)
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148)
  const padding = Buffer.alloc((512 - (contents.byteLength % 512)) % 512)
  return Buffer.concat([header, contents, padding])
}

export const createDeterministicTarball = (files: Record<string, Uint8Array>, platform?: string) => {
  const entries = Object.entries(files).sort(([left], [right]) => {
    return left.localeCompare(right, 'en')
  })
  const tar = Buffer.concat([...entries.map(createEntry), Buffer.alloc(1024)])
  const bytes = gzipSync(tar, {level: 9})
  // Preserve the target header emitted by pinned Bun 1.3.13, not the assembler host's header.
  // New platform-neutral evidence archives use the gzip "unknown OS" value.
  const operatingSystems: Record<string, number> = {linux: 3, darwin: 19, win32: 10}
  const operatingSystem = platform === undefined ? 255 : operatingSystems[platform]
  assert.ok(operatingSystem !== undefined, 'Unsupported gzip target platform')
  bytes[9] = operatingSystem
  return bytes
}
