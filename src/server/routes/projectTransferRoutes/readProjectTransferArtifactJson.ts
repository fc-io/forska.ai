import {resolveProjectTransferTempWritablePath} from '../../services/projectTransfer/projectTransferPaths.ts'

export const readProjectTransferArtifactJson = async <TValue>(pathValue: string): Promise<TValue | null> => {
  try {
    const file = globalThis.Bun.file(resolveProjectTransferTempWritablePath({pathValue}))

    if (!(await file.exists())) {
      return null
    }

    return JSON.parse(await file.text()) as TValue
  } catch {
    return null
  }
}
