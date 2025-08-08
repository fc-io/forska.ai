import {type as arktype} from 'arktype'

const envShape = arktype({
  DATABASE_URL: 'string',
  BETTER_AUTH_SECRET: 'string',
  BETTER_AUTH_URL: 'string',
  VITE_PORT: 'string.integer.parse',
})

const loadEnv = (): typeof envShape.infer => {
  return envShape.assert(process.env)
}

export const env = loadEnv()
