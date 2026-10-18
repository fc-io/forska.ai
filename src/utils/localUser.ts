import {randomUUID} from 'node:crypto'
import {userInfo} from 'node:os'

export const legacyLocalUserId = 'uv2Idd2BF6VNSNjwY5IKmIeoYMKq6zXw'

export const localUserId = `local-${randomUUID()}`

const getDefaultLocalUserName = () => {
  const username = userInfo().username || process.env.USER || process.env.LOGNAME || ''
  const normalizedUsername = username.trim()

  return normalizedUsername || 'Local reviewer'
}

export const localUserName = getDefaultLocalUserName()

export const localUserEmail = `local-${localUserId}@forska.local`

export const localUserRole = null

export const localUserUnpaywallEmail = null

export const localUserFullTextConversionModelId = null

export const localUserDefaults = {
  id: localUserId,
  name: localUserName,
  email: localUserEmail,
  role: localUserRole,
  fullTextConversionModelId: localUserFullTextConversionModelId,
  unpaywallEmail: localUserUnpaywallEmail,
}
