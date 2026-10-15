import {mkdir, rm, writeFile} from 'node:fs/promises'

import {writeRuntimeOperatorLogEvent} from '../../utils/runtimeLogger.ts'
import {getSqlLiteral} from '../appQueryHelpers.ts'
import {resolveProjectTransferTempWritablePath} from './projectTransferPaths.ts'
import {getProjectTransferImportTempLayout} from './projectTransferSession.ts'

type RuntimePathOptions = {cwd?: string; envValues?: Record<string, string | undefined>}

export type ProjectTransferCommitTempTableFileRoot = RuntimePathOptions & {sessionId: string}

export type ProjectTransferCommitTempTableFile = {columns: Readonly<Record<string, string>>; rows: readonly object[]}

type ProjectTransferCommitTempTableFileInput<TName extends string, TResult> = {
  directoryName: string
  files: Record<TName, ProjectTransferCommitTempTableFile>
  root: ProjectTransferCommitTempTableFileRoot
  work: (sourceSqlByName: Record<TName, string>) => Promise<TResult>
}

const readJsonDefaultMaximumObjectSize = 16_777_216
const maximumUtf8BytesPerUtf16CodeUnit = 3

const getDirectoryPathValue = ({directoryName, sessionId}: {directoryName: string; sessionId: string}) => {
  return `${getProjectTransferImportTempLayout(sessionId).commitTempTablesPath}/${directoryName}`
}

const getProjectedRow = (row: object, fields: readonly string[]) => {
  return fields.reduce<Record<string, unknown>>((projected, field) => {
    projected[field] = (row as Record<string, unknown>)[field]

    return projected
  }, {})
}

const getNdjsonLines = (file: ProjectTransferCommitTempTableFile) => {
  const fields = Object.keys(file.columns)

  return file.rows.map((row) => {
    return JSON.stringify(getProjectedRow(row, fields))
  })
}

const getNdjsonText = (lines: readonly string[]) => {
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

const getMaximumObjectSize = (lines: readonly string[]) => {
  return lines.reduce((size, line) => {
    return line.length * maximumUtf8BytesPerUtf16CodeUnit < size ? size : Math.max(size, Buffer.byteLength(line) + 1)
  }, readJsonDefaultMaximumObjectSize)
}

const getReadJsonColumnsSql = (columns: Readonly<Record<string, string>>) => {
  return `{${Object.entries(columns)
    .map(([field, type]) => {
      return `${getSqlLiteral(field)}: ${getSqlLiteral(type)}`
    })
    .join(', ')}}`
}

const getReadJsonSourceSql = ({
  columns,
  maximumObjectSize,
  pathLiteral,
}: {
  columns: Readonly<Record<string, string>>
  maximumObjectSize: number
  pathLiteral: string
}) => {
  return `read_json(
    ${pathLiteral},
    format = 'newline_delimited',
    columns = ${getReadJsonColumnsSql(columns)},
    maximum_object_size = ${maximumObjectSize}
  )`
}

const writeTempTableFile = async ({
  directoryPathValue,
  file,
  name,
  runtimeOptions,
}: {
  directoryPathValue: string
  file: ProjectTransferCommitTempTableFile
  name: string
  runtimeOptions: RuntimePathOptions
}) => {
  const filePath = resolveProjectTransferTempWritablePath({
    ...runtimeOptions,
    pathValue: `${directoryPathValue}/${name}.ndjson`,
  })
  const lines = getNdjsonLines(file)

  await writeFile(filePath, getNdjsonText(lines))

  return getReadJsonSourceSql({
    columns: file.columns,
    maximumObjectSize: getMaximumObjectSize(lines),
    pathLiteral: getSqlLiteral(filePath),
  })
}

const writeTempTableFiles = async <TName extends string>({
  directoryPathValue,
  files,
  runtimeOptions,
}: {
  directoryPathValue: string
  files: Record<TName, ProjectTransferCommitTempTableFile>
  runtimeOptions: RuntimePathOptions
}) => {
  const entries = await Promise.all(
    (Object.entries(files) as [TName, ProjectTransferCommitTempTableFile][]).map(async ([name, file]) => {
      return [name, await writeTempTableFile({directoryPathValue, file, name, runtimeOptions})] as const
    }),
  )

  return Object.fromEntries(entries) as Record<TName, string>
}

const removeTempTableFiles = async (directoryPath: string) => {
  await rm(directoryPath, {force: true, recursive: true}).catch((error: unknown) => {
    writeRuntimeOperatorLogEvent({
      attrs: {directoryPath, error},
      event: 'project-transfer.commit-temp-table-files.cleanup-failed',
      message: '[project-transfer] commit temp-table file cleanup failed',
      severity: 'WARN',
    })
  })
}

export const withProjectTransferCommitTempTableFiles = async <TName extends string, TResult>({
  directoryName,
  files,
  root: {sessionId, ...runtimeOptions},
  work,
}: ProjectTransferCommitTempTableFileInput<TName, TResult>): Promise<TResult> => {
  const directoryPathValue = getDirectoryPathValue({directoryName, sessionId})
  const directoryPath = resolveProjectTransferTempWritablePath({...runtimeOptions, pathValue: directoryPathValue})

  try {
    await rm(directoryPath, {force: true, recursive: true})
    await mkdir(directoryPath, {recursive: true})

    return await work(await writeTempTableFiles({directoryPathValue, files, runtimeOptions}))
  } finally {
    await removeTempTableFiles(directoryPath)
  }
}
