import {existsSync, readFileSync} from 'fs'

const getDatabaseUrlFileValue = () => {
  const filePath = process.env.DATABASE_URL_FILE
  return filePath && existsSync(filePath) ? readFileSync(filePath, 'utf8').trim() : ''
}

const failMissingDatabaseUrl = (): never => {
  throw new Error('DATABASE_URL is not set')
}

export const getDatabaseUrl = () => {
  const databaseUrl = String(process.env.DATABASE_URL ?? '').trim() || getDatabaseUrlFileValue()
  return databaseUrl ? databaseUrl : failMissingDatabaseUrl()
}
