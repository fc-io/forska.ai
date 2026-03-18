import type {UserRecord} from '../../db/schemaTypes.ts'
import {localUserDefaults} from '../../utils/localUser.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {getDateValue, getSqlLiteral} from './appQueryHelpers.ts'

type UserConfigRow = {
  id: string
  name: string
  email: string
  role: string | null
  openalexMailto: string | null
  unpaywallEmail: string | null
  createdAt: unknown
  updatedAt: unknown
}

const userConfigSelectClause = `
  id,
  name,
  email,
  role,
  openalex_mailto AS openalexMailto,
  unpaywall_email AS unpaywallEmail,
  created_at AS createdAt,
  updated_at AS updatedAt
`

const getNullableTrimmedValue = (value: string | null | undefined): string | null => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

const getValueOrFallback = (value: string | null | undefined, fallback: string): string => {
  return getNullableTrimmedValue(value) ?? fallback
}

const getDefaultUserRecord = (): UserRecord => {
  const now = new Date()

  return {
    id: localUserDefaults.id,
    name: localUserDefaults.name,
    email: localUserDefaults.email,
    role: localUserDefaults.role,
    openalexMailto: localUserDefaults.openalexMailto,
    unpaywallEmail: localUserDefaults.unpaywallEmail,
    createdAt: now,
    updatedAt: now,
  }
}

const getUserConfigValue = (row: UserConfigRow): UserRecord => {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    openalexMailto: row.openalexMailto,
    unpaywallEmail: row.unpaywallEmail,
    createdAt: getDateValue(row.createdAt) ?? new Date(0),
    updatedAt: getDateValue(row.updatedAt) ?? new Date(0),
  }
}

const getUserConfig = async (): Promise<UserRecord | null> => {
  const [row] = await getAppDatabaseService().queryJson<UserConfigRow>(`
    SELECT ${userConfigSelectClause}
    FROM app.user_config
    LIMIT 1
  `)

  return row ? getUserConfigValue(row) : null
}

const insertDefaultUserConfig = async (): Promise<UserRecord | null> => {
  const [row] = await getAppDatabaseService().queryJson<UserConfigRow>(`
    INSERT INTO app.user_config (
      id,
      name,
      email,
      role,
      openalex_mailto,
      unpaywall_email
    )
    SELECT
      ${getSqlLiteral(localUserDefaults.id)},
      ${getSqlLiteral(localUserDefaults.name)},
      ${getSqlLiteral(localUserDefaults.email)},
      ${getSqlLiteral(localUserDefaults.role)},
      ${getSqlLiteral(localUserDefaults.openalexMailto)},
      ${getSqlLiteral(localUserDefaults.unpaywallEmail)}
    WHERE NOT EXISTS (
      SELECT 1
      FROM app.user_config
    )
    RETURNING ${userConfigSelectClause}
  `)

  return row ? getUserConfigValue(row) : null
}

const getOrCreateUserConfig = async (): Promise<UserRecord> => {
  const existing = await getUserConfig()
  const inserted = existing ? null : await insertDefaultUserConfig()
  const loaded = existing ?? inserted ?? (await getUserConfig())

  return loaded ?? getDefaultUserRecord()
}

const updateUserConfig = async ({
  email,
  name,
  unpaywallEmail,
}: {
  email: string
  name: string
  unpaywallEmail: string | null
}): Promise<UserRecord> => {
  const current = await getOrCreateUserConfig()

  const [row] = await getAppDatabaseService().queryJson<UserConfigRow>(`
    UPDATE app.user_config
    SET name = ${getSqlLiteral(getValueOrFallback(name, current.name))},
        email = ${getSqlLiteral(getValueOrFallback(email, current.email))},
        unpaywall_email = ${getSqlLiteral(getNullableTrimmedValue(unpaywallEmail))},
        updated_at = current_timestamp
    WHERE id = ${getSqlLiteral(localUserDefaults.id)}
    RETURNING ${userConfigSelectClause}
  `)

  return row ? getUserConfigValue(row) : getOrCreateUserConfig()
}

const getUnpaywallEmail = async (): Promise<string | null> => {
  const userConfig = await getOrCreateUserConfig()
  const normalized = String(userConfig.unpaywallEmail ?? '').trim()

  return normalized === '' ? null : normalized
}

export const userConfigQueryService = {getOrCreateUserConfig, getUnpaywallEmail, updateUserConfig}

export const getUserConfigQueryService = () => {
  return userConfigQueryService
}
