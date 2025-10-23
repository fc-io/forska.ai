import {type as arktype} from 'arktype'

const envShape = arktype({
  DB_NAME: 'string',
  DB_USER: 'string',
  DB_PASS: 'string',
  POSTGRES_PORT: 'string.integer.parse',
  SSH_ALIAS: 'string',
  STACK_ROOT: 'string',
})

const load = () => {
  const asserted = envShape.assert({...process.env})
  return {...asserted, REMOTE_DATABASE_URL: process.env.REMOTE_DATABASE_URL, DB_VOLUME: process.env.DB_VOLUME}
}
export const env = load()
