import {createHash} from 'node:crypto'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {deflateRawSync} from 'node:zlib'

import {expect, test} from 'bun:test'

import {projectTransferPathLimits} from './projectTransferPaths.ts'
import {
  getProjectTransferZipCrc32Digest,
  type ProjectTransferZipJsEntry,
  type ProjectTransferZipJsModule,
  type ProjectTransferZipJsUint8ArrayWriter,
  readProjectTransferZipPackage,
  writeProjectTransferZipPackage,
  writeProjectTransferZipPackageToFile,
} from './projectTransferZip.ts'

type FakeZipReadEntry = ProjectTransferZipJsEntry & {readCount: () => number}
type FakeZipReadWriter = ProjectTransferZipJsUint8ArrayWriter & {appendChunks: (chunks: readonly Uint8Array[]) => void}

type FakeZipState = {
  closeOptions: Record<string, unknown> | null
  readerClosed: boolean
  readerOptions: Record<string, unknown> | null
  writtenEntries: Array<{bytes: Uint8Array; options: Record<string, unknown> | undefined; path: string}>
  writerOptions: Record<string, unknown> | null
}

const textEncoder = new TextEncoder()

const getBytes = (value: string) => {
  return textEncoder.encode(value)
}

const getSha256Digest = (bytes: Uint8Array) => {
  return createHash('sha256').update(bytes).digest('hex')
}

const getZipEntryMetadata = (bytes: Uint8Array) => {
  return {
    checksumSha256: getSha256Digest(bytes),
    crc32: getProjectTransferZipCrc32Digest(bytes),
    uncompressedSize: bytes.byteLength,
  }
}

const getErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}

const expectPromiseToRejectWithMessage = async (promise: Promise<unknown>, message: string) => {
  const result = await promise.then(
    () => {
      return {message: '', rejected: false}
    },
    (error: unknown) => {
      return {message: getErrorMessage(error), rejected: true}
    },
  )

  expect(result.rejected).toBe(true)
  expect(result.message).toContain(message)
}

const getSymlinkExternalFileAttributes = () => {
  return 0o120000 * 0x10000
}

const getFakeReadWriter = (writer: ProjectTransferZipJsUint8ArrayWriter): FakeZipReadWriter => {
  if (!('appendChunks' in writer)) {
    throw new Error('Expected project transfer ZIP reads to use Uint8ArrayWriter')
  }

  return writer as FakeZipReadWriter
}

const getFakeZipEntry = ({
  chunks = [getBytes('{}')],
  compressedSize = 1,
  directory = false,
  externalFileAttributes = 0,
  filename,
  signature = 1,
  uncompressedSize = 1,
  unixMode,
  zip64 = false,
}: {
  chunks?: readonly Uint8Array[]
  compressedSize?: number
  directory?: boolean
  externalFileAttributes?: number
  filename: string
  signature?: number
  uncompressedSize?: number
  unixMode?: number
  zip64?: boolean
}): FakeZipReadEntry => {
  const state = {readCount: 0}

  return {
    compressedSize,
    directory,
    externalFileAttributes,
    filename,
    getData: async (writable) => {
      state.readCount += 1
      const writer = getFakeReadWriter(writable)
      writer.appendChunks(chunks)
      return writer.getData()
    },
    readCount: () => {
      return state.readCount
    },
    signature,
    uncompressedSize,
    unixMode,
    zip64,
  }
}

const getFakeZipModule = (readEntries: readonly ProjectTransferZipJsEntry[] = []) => {
  const state: FakeZipState = {
    closeOptions: null,
    readerClosed: false,
    readerOptions: null,
    writtenEntries: [],
    writerOptions: null,
  }

  class FakeUint8ArrayReader {
    bytes: Uint8Array

    constructor(bytes: Uint8Array) {
      this.bytes = bytes
    }
  }

  class FakeUint8ArrayWriter {
    chunks: Uint8Array[] = []

    appendChunks = (chunks: readonly Uint8Array[]) => {
      this.chunks = [...this.chunks, ...chunks]
    }

    getData = () => {
      const size = this.chunks.reduce((total, chunk) => {
        return total + chunk.byteLength
      }, 0)

      return Buffer.concat(
        this.chunks.map((chunk) => {
          return Buffer.from(chunk)
        }),
        size,
      )
    }
  }

  class FakeZipReader {
    constructor(_reader: unknown, options?: Record<string, unknown>) {
      state.readerOptions = options ?? null
    }

    close = async () => {
      state.readerClosed = true
    }

    getEntries = async () => {
      return [...readEntries]
    }
  }

  class FakeZipWriter {
    constructor(_writer: unknown, options?: Record<string, unknown>) {
      state.writerOptions = options ?? null
    }

    add = async (path: string, reader: unknown, options?: Record<string, unknown>) => {
      state.writtenEntries.push({bytes: (reader as FakeUint8ArrayReader).bytes, options, path})
    }

    close = async (options?: Record<string, unknown>) => {
      state.closeOptions = options ?? null

      return getBytes(
        JSON.stringify(
          state.writtenEntries.map((entry) => {
            return entry.path
          }),
        ),
      )
    }
  }

  return {
    state,
    zipModule: {
      Uint8ArrayReader: FakeUint8ArrayReader,
      Uint8ArrayWriter: FakeUint8ArrayWriter,
      ZipReader: FakeZipReader,
      ZipWriter: FakeZipWriter,
    } satisfies ProjectTransferZipJsModule,
  }
}

test('writes a ZIP64 project-transfer package after validating payload paths and manifest', async () => {
  const {state, zipModule} = getFakeZipModule()
  const result = await writeProjectTransferZipPackage({
    entries: [
      {bytes: '{"schemaVersion":1}', path: 'manifest.json'},
      {bytes: 'article-one', path: 'assets/articles/article-1.txt'},
    ],
    zipModule,
  })

  expect(state.writerOptions).toMatchObject({keepOrder: true, supportZip64SplitFile: true, useWebWorkers: false})
  expect(state.closeOptions).toMatchObject({zip64: true})
  expect(
    state.writtenEntries.map((entry) => {
      return entry.path
    }),
  ).toEqual(['manifest.json', 'assets/articles/article-1.txt'])
  expect(result.entries).toMatchObject([
    {
      checksumSha256: getSha256Digest(getBytes('{"schemaVersion":1}')),
      path: 'manifest.json',
      uncompressedSize: getBytes('{"schemaVersion":1}').byteLength,
    },
    {
      checksumSha256: getSha256Digest(getBytes('article-one')),
      path: 'assets/articles/article-1.txt',
      uncompressedSize: getBytes('article-one').byteLength,
    },
  ])
  expect(result.uncompressedSize).toBe(getBytes('{"schemaVersion":1}article-one').byteLength)
  expect(result.checksumSha256).toBe(getSha256Digest(result.bytes))
})

test('writes a project-transfer package directly to a file without returning archive bytes', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), `f2-project-transfer-zip-${process.pid}-`))
  const outputPath = join(rootPath, 'export.zip')

  try {
    const result = await writeProjectTransferZipPackageToFile({
      entries: [
        {bytes: '{"schemaVersion":1}', path: 'manifest.json'},
        {bytes: 'article-one', path: 'assets/articles/article-1.txt'},
      ],
      outputPath,
    })
    const bytes = new Uint8Array(await readFile(outputPath))

    expect(result.byteLength).toBe(bytes.byteLength)
    expect(result.checksumSha256).toBe(getSha256Digest(bytes))
    expect(result.entries).toMatchObject([
      {
        checksumSha256: getSha256Digest(getBytes('{"schemaVersion":1}')),
        path: 'manifest.json',
        uncompressedSize: getBytes('{"schemaVersion":1}').byteLength,
      },
      {
        checksumSha256: getSha256Digest(getBytes('article-one')),
        path: 'assets/articles/article-1.txt',
        uncompressedSize: getBytes('article-one').byteLength,
      },
    ])
    expect(bytes[0]).toBe(0x50)
    expect(bytes[1]).toBe(0x4b)
  } finally {
    await rm(rootPath, {force: true, recursive: true})
  }
})

test('writes staged file and stream entries with precomputed metadata and central-directory headers', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), `f2-project-transfer-zip-stream-${process.pid}-`))
  const outputPath = join(rootPath, 'export.zip')
  const stagedFilePath = join(rootPath, 'staged-article.txt')
  const manifestBytes = getBytes('{"schemaVersion":1}')
  const stagedFileBytes = getBytes('staged-file-entry')
  const streamedBytes = getBytes('streamed-entry')

  try {
    await writeFile(stagedFilePath, stagedFileBytes)

    const result = await writeProjectTransferZipPackageToFile({
      entries: [
        {bytes: manifestBytes, metadata: getZipEntryMetadata(manifestBytes), path: 'manifest.json'},
        {
          filePath: stagedFilePath,
          metadata: getZipEntryMetadata(stagedFileBytes),
          path: 'assets/articles/article-1.txt',
        },
        {
          metadata: getZipEntryMetadata(streamedBytes),
          path: 'assets/article-pdfs/article-1.pdf',
          stream: () => {
            return [getBytes('streamed-'), getBytes('entry')]
          },
        },
      ],
      outputPath,
    })
    const archiveBytes = new Uint8Array(await readFile(outputPath))
    const read = await readProjectTransferZipPackage({bytes: archiveBytes})
    const entriesByPath = new Map(
      read.entries.map((entry) => {
        return [entry.path, entry]
      }),
    )
    const streamedEntry = entriesByPath.get('assets/article-pdfs/article-1.pdf')
    const stagedFileEntry = entriesByPath.get('assets/articles/article-1.txt')

    expect(result.byteLength).toBe(archiveBytes.byteLength)
    expect(result.checksumSha256).toBe(getSha256Digest(archiveBytes))
    expect(stagedFileEntry).toMatchObject({
      advisoryCrc32: getProjectTransferZipCrc32Digest(stagedFileBytes),
      advisoryUncompressedSize: stagedFileBytes.byteLength,
      checksumSha256: getSha256Digest(stagedFileBytes),
      compressedSize: stagedFileBytes.byteLength,
      uncompressedSize: stagedFileBytes.byteLength,
    })
    expect(streamedEntry).toMatchObject({
      advisoryCrc32: getProjectTransferZipCrc32Digest(streamedBytes),
      advisoryUncompressedSize: streamedBytes.byteLength,
      checksumSha256: getSha256Digest(streamedBytes),
      compressedSize: streamedBytes.byteLength,
      uncompressedSize: streamedBytes.byteLength,
    })
    expect(streamedEntry?.bytes).toEqual(streamedBytes)
  } finally {
    await rm(rootPath, {force: true, recursive: true})
  }
})

test('rejects stream entries when precomputed metadata does not match written bytes', async () => {
  await expectPromiseToRejectWithMessage(
    writeProjectTransferZipPackage({
      entries: [
        {bytes: '{"schemaVersion":1}', path: 'manifest.json'},
        {
          metadata: getZipEntryMetadata(getBytes('expected')),
          path: 'assets/article-pdfs/article-1.pdf',
          stream: () => {
            return [getBytes('actual')]
          },
        },
      ],
    }),
    'Project transfer zip entry_metadata_mismatch',
  )
})

test('reads STORE entry bytes as read-only views backed by the source archive', async () => {
  const manifestBytes = getBytes('{"schemaVersion":1}')
  const articleBytes = getBytes('article-one')
  const written = await writeProjectTransferZipPackage({
    entries: [
      {bytes: manifestBytes, path: 'manifest.json'},
      {bytes: articleBytes, path: 'assets/articles/article-1.txt'},
    ],
  })
  const read = await readProjectTransferZipPackage({bytes: written.bytes})

  expect(read.manifest.bytes).toEqual(manifestBytes)
  expect(
    read.entries.map((entry) => {
      return entry.path
    }),
  ).toEqual(['manifest.json', 'assets/articles/article-1.txt'])
  expect(read.entries[1]?.bytes).toEqual(articleBytes)
  expect(read.entries[1]?.bytes.buffer).toBe(written.bytes.buffer)
  expect(read.entries[1]?.compressedSize).toBe(articleBytes.byteLength)
})

test('reads project-transfer packages using writer bytes for counters and checksums instead of advisory sizes', async () => {
  const manifestChunks = [getBytes('{"schema'), getBytes('Version":1}')]
  const assetChunks = [getBytes('asset-'), getBytes('bytes')]
  const manifestBytes = getBytes('{"schemaVersion":1}')
  const assetBytes = getBytes('asset-bytes')
  const {state, zipModule} = getFakeZipModule([
    getFakeZipEntry({
      chunks: manifestChunks,
      compressedSize: 500,
      filename: 'manifest.json',
      signature: 123,
      uncompressedSize: 999,
      zip64: true,
    }),
    getFakeZipEntry({
      chunks: assetChunks,
      compressedSize: 700,
      filename: 'assets/article-pdfs/article-1.pdf',
      signature: 456,
      uncompressedSize: 888,
    }),
  ])

  const result = await readProjectTransferZipPackage({bytes: getBytes('fake-archive'), zipModule})

  expect(state.readerOptions).toMatchObject({checkSignature: true, useWebWorkers: false})
  expect(state.readerClosed).toBe(true)
  expect(result.manifest).toMatchObject({
    advisoryCompressedSize: 500,
    advisoryCrc32: 123,
    advisoryUncompressedSize: 999,
    checksumSha256: getSha256Digest(manifestBytes),
    path: 'manifest.json',
    uncompressedSize: manifestBytes.byteLength,
    zip64: true,
  })
  expect(result.entries[1]).toMatchObject({
    advisoryUncompressedSize: 888,
    checksumSha256: getSha256Digest(assetBytes),
    path: 'assets/article-pdfs/article-1.pdf',
    uncompressedSize: assetBytes.byteLength,
  })
})

test('runs project-transfer zip read guards before reading entry data', async () => {
  const entry = getFakeZipEntry({filename: 'manifest.json'})
  const {zipModule} = getFakeZipModule([entry])

  await expectPromiseToRejectWithMessage(
    readProjectTransferZipPackage({
      beforeReadEntries: () => {
        throw new Error('metadata rejected')
      },
      bytes: getBytes('fake-archive'),
      zipModule,
    }),
    'metadata rejected',
  )
  expect(entry.readCount()).toBe(0)
})

test('rejects missing root manifest before accepting a project-transfer package', async () => {
  const entry = getFakeZipEntry({filename: 'assets/article-pdfs/article-1.pdf'})
  const {zipModule} = getFakeZipModule([entry])

  await expectPromiseToRejectWithMessage(
    readProjectTransferZipPackage({bytes: getBytes('fake-archive'), zipModule}),
    'Project transfer zip missing_manifest',
  )
  expect(entry.readCount()).toBe(0)
})

test('rejects unsafe project-transfer zip paths before reading entry data', async () => {
  const oversizedPath = `assets/${'a'.repeat(projectTransferPathLimits.maxPathLength)}`
  const cases = [
    ['path_empty_path', ''],
    ['path_raw_backslash', 'assets\\file.pdf'],
    ['path_absolute_path', '/manifest.json'],
    ['path_absolute_path', 'C:/manifest.json'],
    ['path_traversal', '../manifest.json'],
    ['path_traversal', 'assets/../manifest.json'],
    ['path_normalization_changed', 'assets//file.pdf'],
    ['path_normalization_changed', 'assets/./file.pdf'],
    ['path_path_too_long', oversizedPath],
    ['path_disallowed_root', 'tmp/project-transfer/upload.zip'],
  ] as const

  const results = await Promise.all(
    cases.map(async ([code, filename]) => {
      const entry = getFakeZipEntry({filename})
      const {zipModule} = getFakeZipModule([entry])

      await expectPromiseToRejectWithMessage(
        readProjectTransferZipPackage({bytes: getBytes('fake-archive'), zipModule}),
        `Project transfer zip ${code}`,
      )

      return entry.readCount()
    }),
  )

  expect(results).toEqual(
    cases.map(() => {
      return 0
    }),
  )
})

test('rejects duplicate and normalized-colliding archive members', async () => {
  const cases = [
    ['manifest.json', 'manifest.json'],
    ['assets/Report.pdf', 'assets/report.pdf'],
    ['assets/e\u0301.txt', 'assets/\u00e9.txt'],
  ] as const

  const results = await Promise.all(
    cases.map(async ([firstPath, secondPath]) => {
      const firstEntry = getFakeZipEntry({filename: firstPath})
      const secondEntry = getFakeZipEntry({filename: secondPath})
      const {zipModule} = getFakeZipModule([firstEntry, secondEntry])

      await expectPromiseToRejectWithMessage(
        readProjectTransferZipPackage({bytes: getBytes('fake-archive'), zipModule}),
        'Project transfer zip path_duplicate_path',
      )

      return firstEntry.readCount() + secondEntry.readCount()
    }),
  )

  expect(results).toEqual([0, 0, 0])
})

test('rejects symlink and directory entries after path validation', async () => {
  const symlinkModule = getFakeZipModule([
    getFakeZipEntry({filename: 'manifest.json'}),
    getFakeZipEntry({
      externalFileAttributes: getSymlinkExternalFileAttributes(),
      filename: 'assets/article-pdfs/link.pdf',
    }),
  ])
  const directoryModule = getFakeZipModule([
    getFakeZipEntry({filename: 'manifest.json'}),
    getFakeZipEntry({directory: true, filename: 'assets/article-pdfs'}),
  ])

  await expectPromiseToRejectWithMessage(
    readProjectTransferZipPackage({bytes: getBytes('fake-archive'), zipModule: symlinkModule.zipModule}),
    'Project transfer zip symlink_entry',
  )
  await expectPromiseToRejectWithMessage(
    readProjectTransferZipPackage({bytes: getBytes('fake-archive'), zipModule: directoryModule.zipModule}),
    'Project transfer zip directory_entry',
  )
})

test('rejects write packages with unsafe paths or missing manifest before writing entries', async () => {
  const missingManifestModule = getFakeZipModule()
  const unsafePathModule = getFakeZipModule()

  await expectPromiseToRejectWithMessage(
    writeProjectTransferZipPackage({
      entries: [{bytes: 'asset', path: 'assets/article-pdfs/article-1.pdf'}],
      zipModule: missingManifestModule.zipModule,
    }),
    'Project transfer zip missing_manifest',
  )
  await expectPromiseToRejectWithMessage(
    writeProjectTransferZipPackage({
      entries: [
        {bytes: '{}', path: 'manifest.json'},
        {bytes: 'asset', path: 'assets\\article-pdfs\\article-1.pdf'},
      ],
      zipModule: unsafePathModule.zipModule,
    }),
    'Project transfer zip path_raw_backslash',
  )
  expect(missingManifestModule.state.writtenEntries).toEqual([])
  expect(unsafePathModule.state.writtenEntries).toEqual([])
})

type RawZipEntryInput = {compressionMethod: 0 | 8; data: Uint8Array; declaredUncompressedSize?: number; path: string}

const createRawZipBytes = (byteLength: number, write: (view: DataView) => void) => {
  const bytes = new Uint8Array(byteLength)
  write(new DataView(bytes.buffer))
  return bytes
}

const concatRawZipBytes = (chunks: readonly Uint8Array[]) => {
  return new Uint8Array(
    Buffer.concat(
      chunks.map((chunk) => {
        return Buffer.from(chunk)
      }),
    ),
  )
}

const getRawZipEntryBytes = (entry: RawZipEntryInput, localHeaderOffset: number) => {
  const filenameBytes = getBytes(entry.path)
  const payload = entry.compressionMethod === 8 ? new Uint8Array(deflateRawSync(entry.data)) : entry.data
  const crc32 = getProjectTransferZipCrc32Digest(entry.data)
  const uncompressedSize = entry.declaredUncompressedSize ?? entry.data.byteLength
  const localHeader = createRawZipBytes(30, (view) => {
    view.setUint32(0, 0x04034b50, true)
    view.setUint16(4, 20, true)
    view.setUint16(6, 0x0800, true)
    view.setUint16(8, entry.compressionMethod, true)
    view.setUint16(10, 0, true)
    view.setUint16(12, 33, true)
    view.setUint32(14, crc32, true)
    view.setUint32(18, payload.byteLength, true)
    view.setUint32(22, uncompressedSize, true)
    view.setUint16(26, filenameBytes.byteLength, true)
    view.setUint16(28, 0, true)
  })
  const centralHeader = createRawZipBytes(46, (view) => {
    view.setUint32(0, 0x02014b50, true)
    view.setUint16(4, 20, true)
    view.setUint16(6, 20, true)
    view.setUint16(8, 0x0800, true)
    view.setUint16(10, entry.compressionMethod, true)
    view.setUint16(12, 0, true)
    view.setUint16(14, 33, true)
    view.setUint32(16, crc32, true)
    view.setUint32(20, payload.byteLength, true)
    view.setUint32(24, uncompressedSize, true)
    view.setUint16(28, filenameBytes.byteLength, true)
    view.setUint16(30, 0, true)
    view.setUint16(32, 0, true)
    view.setUint16(34, 0, true)
    view.setUint16(36, 0, true)
    view.setUint32(38, 0, true)
    view.setUint32(42, localHeaderOffset, true)
  })

  return {
    central: concatRawZipBytes([centralHeader, filenameBytes]),
    local: concatRawZipBytes([localHeader, filenameBytes, payload]),
  }
}

const getRawZipEnd = ({
  centralDirectoryOffset,
  centralDirectorySize,
  entryCount,
  zip64EntryCount,
}: {
  centralDirectoryOffset: number
  centralDirectorySize: number
  entryCount: number
  zip64EntryCount?: number
}) => {
  const end = createRawZipBytes(22, (view) => {
    view.setUint32(0, 0x06054b50, true)
    view.setUint16(4, 0, true)
    view.setUint16(6, 0, true)
    view.setUint16(8, zip64EntryCount === undefined ? entryCount : 0xffff, true)
    view.setUint16(10, zip64EntryCount === undefined ? entryCount : 0xffff, true)
    view.setUint32(12, centralDirectorySize, true)
    view.setUint32(16, centralDirectoryOffset, true)
    view.setUint16(20, 0, true)
  })

  if (zip64EntryCount === undefined) {
    return end
  }

  const zip64EndOffset = centralDirectoryOffset + centralDirectorySize
  const zip64End = createRawZipBytes(56, (view) => {
    view.setUint32(0, 0x06064b50, true)
    view.setBigUint64(4, 44n, true)
    view.setUint16(12, 45, true)
    view.setUint16(14, 45, true)
    view.setUint32(16, 0, true)
    view.setUint32(20, 0, true)
    view.setBigUint64(24, BigInt(zip64EntryCount), true)
    view.setBigUint64(32, BigInt(zip64EntryCount), true)
    view.setBigUint64(40, BigInt(centralDirectorySize), true)
    view.setBigUint64(48, BigInt(centralDirectoryOffset), true)
  })
  const locator = createRawZipBytes(20, (view) => {
    view.setUint32(0, 0x07064b50, true)
    view.setUint32(4, 0, true)
    view.setBigUint64(8, BigInt(zip64EndOffset), true)
    view.setUint32(16, 1, true)
  })

  return concatRawZipBytes([zip64End, locator, end])
}

const getRawZipBytes = ({entries, zip64EntryCount}: {entries: RawZipEntryInput[]; zip64EntryCount?: number}) => {
  const written = entries.reduce<{centrals: Uint8Array[]; locals: Uint8Array[]; offset: number}>(
    (state, entry) => {
      const entryBytes = getRawZipEntryBytes(entry, state.offset)

      return {
        centrals: [...state.centrals, entryBytes.central],
        locals: [...state.locals, entryBytes.local],
        offset: state.offset + entryBytes.local.byteLength,
      }
    },
    {centrals: [], locals: [], offset: 0},
  )
  const centralDirectory = concatRawZipBytes(written.centrals)
  const end = getRawZipEnd({
    centralDirectoryOffset: written.offset,
    centralDirectorySize: centralDirectory.byteLength,
    entryCount: entries.length,
    zip64EntryCount,
  })

  return concatRawZipBytes([...written.locals, centralDirectory, end])
}

test('inflates DEFLATE entries only up to their declared uncompressed size', async () => {
  const manifestBytes = getBytes('{"schemaVersion":1}')
  const articleBytes = new Uint8Array(4 * 1024 * 1024).fill(97)
  const honestArchive = getRawZipBytes({
    entries: [
      {compressionMethod: 0, data: manifestBytes, path: 'manifest.json'},
      {compressionMethod: 8, data: articleBytes, path: 'assets/articles/article-1.txt'},
    ],
  })
  const bombArchive = getRawZipBytes({
    entries: [
      {compressionMethod: 0, data: manifestBytes, path: 'manifest.json'},
      {compressionMethod: 8, data: articleBytes, declaredUncompressedSize: 64, path: 'assets/articles/article-1.txt'},
    ],
  })

  const honest = await readProjectTransferZipPackage({bytes: honestArchive})

  expect(honest.entries[1]?.bytes).toEqual(articleBytes)
  expect(honest.entries[1]?.uncompressedSize).toBe(articleBytes.byteLength)
  expect(bombArchive.byteLength).toBeLessThan(16 * 1024)
  await expectPromiseToRejectWithMessage(
    readProjectTransferZipPackage({bytes: bombArchive}),
    'Project transfer zip size_mismatch',
  )
})

test('rejects ZIP64 entry counts that cannot fit the central directory before allocating entries', async () => {
  const manifestBytes = getBytes('{"schemaVersion":1}')
  const entries: RawZipEntryInput[] = [
    {compressionMethod: 0, data: manifestBytes, path: 'manifest.json'},
    {compressionMethod: 0, data: getBytes('article-one'), path: 'assets/articles/article-1.txt'},
  ]

  const honest = await readProjectTransferZipPackage({bytes: getRawZipBytes({entries, zip64EntryCount: 2})})

  expect(
    honest.entries.map((entry) => {
      return entry.path
    }),
  ).toEqual(['manifest.json', 'assets/articles/article-1.txt'])
  await expectPromiseToRejectWithMessage(
    readProjectTransferZipPackage({bytes: getRawZipBytes({entries, zip64EntryCount: 1_000_000_000})}),
    'Project transfer zip malformed_central_directory',
  )
  await expectPromiseToRejectWithMessage(
    readProjectTransferZipPackage({bytes: getRawZipBytes({entries, zip64EntryCount: 3})}),
    'Project transfer zip malformed_central_directory',
  )
})
