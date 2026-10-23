import {getAppDatabaseService} from '../../../services/appDatabaseService.ts'
import {escapeSqlString, getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import {computePromptContentHash} from '../../../utils/computePromptContentHash.ts'
import type {PromptRow} from '../promptRow.ts'

type PromptCollision = {hash: string; promptIds: string[]}
type PromptHashUpdate = {id: string; hash: string}

export const withHashes = (rows: PromptRow[]) => {
  return rows.map((row) => {
    return {...row, hash: computePromptContentHash(row.originalText, row.transformedText, row.promptHeading, row.type)}
  })
}

export const groupCollisions = (rows: Array<PromptRow & {hash: string}>) => {
  return rows.reduce<Map<string, string[]>>((map, row) => {
    const current = map.get(row.hash) ?? []
    current.push(row.id)
    map.set(row.hash, current)
    return map
  }, new Map<string, string[]>())
}

export const getCollisions = (groups: Map<string, string[]>) => {
  return Array.from(groups.entries())
    .filter(([, ids]) => {
      return ids.length > 1
    })
    .map<PromptCollision>(([hash, ids]) => {
      return {hash, promptIds: ids}
    })
}

export const safeUpdates = (rows: Array<PromptRow & {hash: string}>, collisions: PromptCollision[]) => {
  const blocked = new Set(
    collisions.map((collision) => {
      return collision.hash
    }),
  )
  return rows
    .filter((row) => {
      return !blocked.has(row.hash)
    })
    .map<PromptHashUpdate>((row) => {
      return {id: row.id, hash: row.hash}
    })
}

export const applyHashUpdates = async (updates: PromptHashUpdate[]) => {
  if (updates.length === 0) {
    return 0
  }

  await Promise.all(
    updates.map((update) => {
      return getAppDatabaseService().run(`
        UPDATE app.prompt
        SET content_hash = ${getSqlLiteral(update.hash)},
            updated_at = current_timestamp
        WHERE id = '${escapeSqlString(update.id)}'
      `)
    }),
  )

  return updates.length
}
