import {isAbsolute, normalize, resolve} from 'node:path'

type RuntimePathOptions = {cwd?: string}

export const getRuntimeWritableRoot = ({cwd = process.cwd()}: RuntimePathOptions = {}) => {
  return cwd
}

export const resolveRuntimeWritablePath = ({
  cwd = process.cwd(),
  pathValue,
}: RuntimePathOptions & {pathValue: string}) => {
  return resolve(getRuntimeWritableRoot({cwd}), pathValue)
}

export const resolveRuntimeFilePath = ({cwd = process.cwd(), pathValue}: RuntimePathOptions & {pathValue: string}) => {
  return isAbsolute(pathValue) ? normalize(pathValue) : resolveRuntimeWritablePath({cwd, pathValue})
}
