import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

export const createScriptTestDirectory = (name: string, parent = tmpdir()) => {
  const path = mkdtempSync(join(parent, `forska-${name}-`))

  return {
    cleanup: () => {
      rmSync(path, {force: true, recursive: true})
    },
    path,
  }
}
