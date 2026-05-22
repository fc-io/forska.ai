import {createHash} from 'node:crypto'

import {
  type ProjectTransferPathValidationError,
  validateProjectTransferArchiveMemberPaths,
} from './projectTransferPaths.ts'

export type ProjectTransferZipJsEntry = {
  compressedSize?: number
  directory?: boolean
  externalFileAttributes?: number
  filename: string
  getData: (writer: ProjectTransferZipJsUint8ArrayWriter) => Promise<unknown>
  signature?: number
  uncompressedSize?: number
  unixMode?: number
  zip64?: boolean
}

export type ProjectTransferZipJsUint8ArrayWriter = {getData: () => Promise<Uint8Array> | Uint8Array}

export type ProjectTransferZipJsModule = {
  Uint8ArrayReader: new (bytes: Uint8Array) => unknown
  Uint8ArrayWriter: new () => ProjectTransferZipJsUint8ArrayWriter
  ZipReader: new (
    reader: unknown,
    options?: Record<string, unknown>,
  ) => {close: () => Promise<void>; getEntries: () => Promise<ProjectTransferZipJsEntry[]>}
  ZipWriter: new (
    writer: unknown,
    options?: Record<string, unknown>,
  ) => {
    add: (pathValue: string, reader: unknown, options?: Record<string, unknown>) => Promise<void>
    close: (options?: Record<string, unknown>) => Promise<Uint8Array>
  }
}

export type ProjectTransferZipEntryInput = {bytes: string | Uint8Array; lastModifiedAt?: Date; path: string}

export type ProjectTransferZipEntryDigest = {
  advisoryCompressedSize: number | null
  advisoryCrc32: number | null
  advisoryUncompressedSize: number | null
  checksumSha256: string
  compressedSize: number | null
  path: string
  uncompressedSize: number
  zip64: boolean
}

export type ProjectTransferZipReadEntry = ProjectTransferZipEntryDigest & {bytes: Uint8Array}

export type ProjectTransferZipReadPackage = {
  entries: ProjectTransferZipReadEntry[]
  manifest: ProjectTransferZipReadEntry
}

export type ProjectTransferZipWrittenPackage = {
  bytes: Uint8Array
  checksumSha256: string
  entries: ProjectTransferZipEntryDigest[]
  uncompressedSize: number
}

type ProjectTransferZipReadOptions = {bytes: Uint8Array; zipModule?: ProjectTransferZipJsModule}

type ProjectTransferZipWriteOptions = {
  entries: readonly ProjectTransferZipEntryInput[]
  zipModule?: ProjectTransferZipJsModule
}

const projectTransferManifestPath = 'manifest.json'
const projectTransferZipPackageName = '@zip.js/zip.js'
const projectTransferZipDefaultLastModifiedAt = new Date('1980-01-01T00:00:00.000Z')
const unixFileTypeMask = 0o170000
const unixSymlinkFileType = 0o120000

const getProjectTransferZipModule = async () => {
  return import(projectTransferZipPackageName) as Promise<ProjectTransferZipJsModule>
}

const getPathErrorMessage = (error: ProjectTransferPathValidationError) => {
  return error.conflictingPath
    ? `${error.message}: ${error.path} conflicts with ${error.conflictingPath}`
    : `${error.message}: ${error.path}`
}

const throwProjectTransferZipError = (code: string, message: string): never => {
  throw new Error(`Project transfer zip ${code}: ${message}`)
}

const assertProjectTransferZipPaths = (paths: readonly string[]) => {
  const pathResult = validateProjectTransferArchiveMemberPaths({paths})

  if (!pathResult.ok) {
    return throwProjectTransferZipError(`path_${pathResult.error.code}`, getPathErrorMessage(pathResult.error))
  }

  return pathResult.value
}

const getNumberOrNull = (value: number | undefined) => {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const getProjectTransferZipEntryUnixMode = (entry: ProjectTransferZipJsEntry) => {
  const unixMode = getNumberOrNull(entry.unixMode)
  const externalFileAttributes = getNumberOrNull(entry.externalFileAttributes)

  return unixMode ?? (externalFileAttributes === null ? null : externalFileAttributes >>> 16)
}

const isProjectTransferZipSymlinkEntry = (entry: ProjectTransferZipJsEntry) => {
  const unixMode = getProjectTransferZipEntryUnixMode(entry)

  return unixMode !== null && (unixMode & unixFileTypeMask) === unixSymlinkFileType
}

const assertProjectTransferZipEntryMetadata = (entries: readonly ProjectTransferZipJsEntry[]) => {
  const directoryEntry = entries.find((entry) => {
    return entry.directory === true
  })

  if (directoryEntry) {
    return throwProjectTransferZipError(
      'directory_entry',
      `Directory entries are not supported: ${directoryEntry.filename}`,
    )
  }

  const symlinkEntry = entries.find(isProjectTransferZipSymlinkEntry)

  return symlinkEntry
    ? throwProjectTransferZipError('symlink_entry', `Symlink entries are not supported: ${symlinkEntry.filename}`)
    : undefined
}

const assertProjectTransferZipHasManifest = <TEntry extends {path: string}>(entries: readonly TEntry[]) => {
  const manifest = entries.find((entry) => {
    return entry.path === projectTransferManifestPath
  })

  return manifest ?? throwProjectTransferZipError('missing_manifest', 'manifest.json must exist at the archive root')
}

const getBytes = (bytes: string | Uint8Array) => {
  return typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
}

const getSha256Digest = (bytes: Uint8Array) => {
  return createHash('sha256').update(bytes).digest('hex')
}

const getProjectTransferZipEntryBytes = (value: unknown) => {
  if (value instanceof Uint8Array) {
    return value
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value)
  }

  return ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null
}

const readProjectTransferZipWriterBytes = async ({
  data,
  writer,
}: {
  data: unknown
  writer: ProjectTransferZipJsUint8ArrayWriter
}) => {
  const returnedBytes = getProjectTransferZipEntryBytes(data)

  if (returnedBytes) {
    return returnedBytes
  }

  const writerBytes = getProjectTransferZipEntryBytes(await writer.getData())

  return writerBytes ?? throwProjectTransferZipError('entry_data', 'Entry data writer did not return bytes')
}

const readProjectTransferZipEntryData = async (
  entry: ProjectTransferZipJsEntry,
  zipModule: ProjectTransferZipJsModule,
): Promise<ProjectTransferZipReadEntry> => {
  const writer = new zipModule.Uint8ArrayWriter()
  const bytes = await readProjectTransferZipWriterBytes({data: await entry.getData(writer), writer})

  return {
    advisoryCompressedSize: getNumberOrNull(entry.compressedSize),
    advisoryCrc32: getNumberOrNull(entry.signature),
    advisoryUncompressedSize: getNumberOrNull(entry.uncompressedSize),
    bytes,
    checksumSha256: getSha256Digest(bytes),
    compressedSize: getNumberOrNull(entry.compressedSize),
    path: entry.filename,
    uncompressedSize: bytes.byteLength,
    zip64: entry.zip64 === true,
  }
}

const writeProjectTransferZipEntry = async (
  zipWriter: InstanceType<ProjectTransferZipJsModule['ZipWriter']>,
  zipModule: ProjectTransferZipJsModule,
  entry: ProjectTransferZipEntryInput,
): Promise<ProjectTransferZipEntryDigest> => {
  const bytes = getBytes(entry.bytes)

  await zipWriter.add(entry.path, new zipModule.Uint8ArrayReader(bytes), {
    lastModDate: entry.lastModifiedAt ?? projectTransferZipDefaultLastModifiedAt,
  })

  return {
    advisoryCompressedSize: null,
    advisoryCrc32: null,
    advisoryUncompressedSize: null,
    checksumSha256: getSha256Digest(bytes),
    compressedSize: null,
    path: entry.path,
    uncompressedSize: bytes.byteLength,
    zip64: false,
  }
}

const writeProjectTransferZipEntries = async (
  zipWriter: InstanceType<ProjectTransferZipJsModule['ZipWriter']>,
  zipModule: ProjectTransferZipJsModule,
  entries: readonly ProjectTransferZipEntryInput[],
) => {
  return entries.reduce<Promise<ProjectTransferZipEntryDigest[]>>(async (previousEntries, entry) => {
    const writtenEntries = await previousEntries
    const writtenEntry = await writeProjectTransferZipEntry(zipWriter, zipModule, entry)

    return [...writtenEntries, writtenEntry]
  }, Promise.resolve([]))
}

export const readProjectTransferZipPackage = async ({
  bytes,
  zipModule,
}: ProjectTransferZipReadOptions): Promise<ProjectTransferZipReadPackage> => {
  const resolvedZipModule = zipModule ?? (await getProjectTransferZipModule())
  const zipReader = new resolvedZipModule.ZipReader(new resolvedZipModule.Uint8ArrayReader(bytes), {
    checkSignature: true,
    useWebWorkers: false,
  })

  try {
    const zipEntries = await zipReader.getEntries()
    assertProjectTransferZipPaths(
      zipEntries.map((entry) => {
        return entry.filename
      }),
    )
    assertProjectTransferZipEntryMetadata(zipEntries)
    assertProjectTransferZipHasManifest(
      zipEntries.map((entry) => {
        return {path: entry.filename}
      }),
    )

    const entries = await Promise.all(
      zipEntries.map((entry) => {
        return readProjectTransferZipEntryData(entry, resolvedZipModule)
      }),
    )
    const manifest = assertProjectTransferZipHasManifest(entries)

    return {entries, manifest}
  } finally {
    await zipReader.close()
  }
}

export const writeProjectTransferZipPackage = async ({
  entries,
  zipModule,
}: ProjectTransferZipWriteOptions): Promise<ProjectTransferZipWrittenPackage> => {
  assertProjectTransferZipPaths(
    entries.map((entry) => {
      return entry.path
    }),
  )
  assertProjectTransferZipHasManifest(entries)

  const resolvedZipModule = zipModule ?? (await getProjectTransferZipModule())
  const zipWriter = new resolvedZipModule.ZipWriter(new resolvedZipModule.Uint8ArrayWriter(), {
    keepOrder: true,
    supportZip64SplitFile: true,
    useWebWorkers: false,
  })
  const writtenEntries = await writeProjectTransferZipEntries(zipWriter, resolvedZipModule, entries)
  const bytes = await zipWriter.close({zip64: true})

  return {
    bytes,
    checksumSha256: getSha256Digest(bytes),
    entries: writtenEntries,
    uncompressedSize: writtenEntries.reduce((totalSize, entry) => {
      return totalSize + entry.uncompressedSize
    }, 0),
  }
}
