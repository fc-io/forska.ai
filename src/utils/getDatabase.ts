// import {eq} from 'drizzle-orm'
import {drizzle} from 'drizzle-orm/node-postgres'
// import {usersTable} from './db/schema'

const getDatabaseUrl = (): string => {
  if (typeof import.meta.env.VITE_DATABASE_URL === 'string') {
    console.log(
      'import.meta.env.VITE_DATABASE_URL',
      import.meta.env.VITE_DATABASE_URL,
    )
    return import.meta.env.VITE_DATABASE_URL
  } else if (typeof process.env.VITE_DATABASE_URL === 'string') {
    console.log('process.env.VITE_DATABASE_URL', process.env.VITE_DATABASE_URL)
    return process.env.VITE_DATABASE_URL
  } else {
    throw new Error('getDatabaseUrl: DATABASE_URL is not set')
  }
}
const db = drizzle(getDatabaseUrl())

export const getDatabase = () => {
  return db
}
