import {createHash} from 'node:crypto'

import {expect, test} from 'bun:test'

import {projectTransferPathLimits} from './projectTransferPaths.ts'
import {
  type ProjectTransferZipJsEntry,
  type ProjectTransferZipJsModule,
  readProjectTransferZipPackage,
  writeProjectTransferZipPackage,
} from './projectTransferZip.ts'

type FakeZipReadEntry = ProjectTransferZipJsEntry & {readCount: () => number}

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

const writeFakeChunks = async (writer: WritableStreamDefaultWriter<Uint8Array>, chunks: readonly Uint8Array[]) => {
  await chunks.reduce<Promise<void>>(async (previousWrite, chunk) => {
    await previousWrite
    await writer.write(chunk)
  }, Promise.resolve())
  await writer.close()
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
      await writeFakeChunks(writable.getWriter(), chunks)
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

  class FakeUint8ArrayWriter {}

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

test('reads project-transfer packages using streamed counters and checksums instead of advisory sizes', async () => {
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

test('rejects missing root manifest before accepting a project-transfer package', async () => {
  const {zipModule} = getFakeZipModule([getFakeZipEntry({filename: 'assets/article-pdfs/article-1.pdf'})])

  await expectPromiseToRejectWithMessage(
    readProjectTransferZipPackage({bytes: getBytes('fake-archive'), zipModule}),
    'Project transfer zip missing_manifest',
  )
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
