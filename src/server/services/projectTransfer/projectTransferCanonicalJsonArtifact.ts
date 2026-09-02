import {randomUUID} from 'node:crypto'
import {createWriteStream} from 'node:fs'
import {mkdir, rename, rm} from 'node:fs/promises'
import {dirname} from 'node:path'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'

const canonicalJsonChunkCodeUnitLimit = 16 * 1024
const canonicalJsonPublishRetryCount = 5
const canonicalJsonPublishRetryDelayMs = 25
const textEncoder = new TextEncoder()

export const projectTransferCanonicalJsonChunkMaxBytes = canonicalJsonChunkCodeUnitLimit * 3

const compareStableStrings = (left: string, right: string) => {
  return left < right ? -1 : left > right ? 1 : 0
}

const isObjectRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const getJsonUnicodeEscape = (value: number) => {
  return `\\u${value.toString(16).padStart(4, '0')}`
}

const getJsonEscapeSequence = ({codeUnit, nextCodeUnit}: {codeUnit: number; nextCodeUnit: number}) => {
  if (codeUnit === 0x22) {
    return '\\"'
  }

  if (codeUnit === 0x5c) {
    return '\\\\'
  }

  if (codeUnit === 0x08) {
    return '\\b'
  }

  if (codeUnit === 0x0c) {
    return '\\f'
  }

  if (codeUnit === 0x0a) {
    return '\\n'
  }

  if (codeUnit === 0x0d) {
    return '\\r'
  }

  if (codeUnit === 0x09) {
    return '\\t'
  }

  if (codeUnit < 0x20) {
    return getJsonUnicodeEscape(codeUnit)
  }

  if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
    return nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff ? null : getJsonUnicodeEscape(codeUnit)
  }

  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff ? getJsonUnicodeEscape(codeUnit) : null
}

const getCanonicalJsonStringFragments = function* (value: string): Generator<string> {
  yield '"'
  let chunkStart = 0
  let index = 0

  while (index < value.length) {
    const codeUnit = value.charCodeAt(index)
    const nextCodeUnit = value.charCodeAt(index + 1)
    const escapeSequence = getJsonEscapeSequence({codeUnit, nextCodeUnit})

    if (escapeSequence !== null) {
      if (chunkStart < index) {
        yield value.slice(chunkStart, index)
      }

      yield escapeSequence
      index += 1
      chunkStart = index
      continue
    }

    const codeUnitLength = codeUnit >= 0xd800 && codeUnit <= 0xdbff ? 2 : 1

    if (index > chunkStart && index + codeUnitLength - chunkStart > canonicalJsonChunkCodeUnitLimit) {
      yield value.slice(chunkStart, index)
      chunkStart = index
    }

    index += codeUnitLength

    if (index - chunkStart === canonicalJsonChunkCodeUnitLimit) {
      yield value.slice(chunkStart, index)
      chunkStart = index
    }
  }

  if (chunkStart < value.length) {
    yield value.slice(chunkStart)
  }

  yield '"'
}

const getCanonicalJsonFragments = function* (value: unknown): Generator<string> {
  if (Array.isArray(value)) {
    yield '['
    const length = value.length

    for (let index = 0; index < length; index += 1) {
      if (index > 0) {
        yield ','
      }

      if (index in value) {
        yield* getCanonicalJsonFragments(value[index])
      }
    }

    yield ']'
    return
  }

  if (isObjectRecord(value)) {
    yield '{'
    const keys = Object.keys(value)
      .filter((key) => {
        return value[key] !== undefined
      })
      .sort(compareStableStrings)

    for (const [index, key] of keys.entries()) {
      if (index > 0) {
        yield ','
      }

      yield* getCanonicalJsonStringFragments(key)
      yield ':'
      yield* getCanonicalJsonFragments(value[key])
    }

    yield '}'
    return
  }

  if (typeof value === 'string') {
    yield* getCanonicalJsonStringFragments(value)
    return
  }

  yield JSON.stringify(value) ?? 'null'
}

const getCanonicalJsonTextChunks = function* (value: unknown): Generator<string> {
  let pending = ''

  for (const fragment of getCanonicalJsonFragments(value)) {
    if (pending.length + fragment.length <= canonicalJsonChunkCodeUnitLimit) {
      pending += fragment
      continue
    }

    if (pending !== '') {
      yield pending
    }

    pending = fragment
  }

  if (pending !== '') {
    yield pending
  }
}

export const getProjectTransferCanonicalJsonChunks = function* (value: unknown): Generator<Uint8Array> {
  for (const chunk of getCanonicalJsonTextChunks(value)) {
    yield textEncoder.encode(chunk)
  }
}

const removeTemporaryArtifact = async (temporaryPath: string, error: unknown): Promise<never> => {
  await rm(temporaryPath, {force: true, recursive: false}).catch(() => {
    return undefined
  })
  throw error
}

const isTransientArtifactPublishError = (error: unknown) => {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && ['EACCES', 'EBUSY', 'EPERM'].includes(String(error.code))
  )
}

const waitForArtifactPublishRetry = (attempt: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, canonicalJsonPublishRetryDelayMs * (attempt + 1))
  })
}

const publishTemporaryArtifact = async ({
  attempt,
  filePath,
  temporaryPath,
}: {
  attempt: number
  filePath: string
  temporaryPath: string
}): Promise<void> => {
  return rename(temporaryPath, filePath).catch(async (error: unknown) => {
    if (!isTransientArtifactPublishError(error) || attempt >= canonicalJsonPublishRetryCount) {
      throw error
    }

    await waitForArtifactPublishRetry(attempt)
    return publishTemporaryArtifact({attempt: attempt + 1, filePath, temporaryPath})
  })
}

export const writeProjectTransferCanonicalJsonArtifact = async ({
  filePath,
  value,
}: {
  filePath: string
  value: unknown
}) => {
  await mkdir(dirname(filePath), {recursive: true})
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  const source = Readable.from(getProjectTransferCanonicalJsonChunks(value), {objectMode: false})
  const destination = createWriteStream(temporaryPath)

  await pipeline(source, destination)
    .then(() => {
      return publishTemporaryArtifact({attempt: 0, filePath, temporaryPath})
    })
    .catch((error: unknown) => {
      return removeTemporaryArtifact(temporaryPath, error)
    })
}
