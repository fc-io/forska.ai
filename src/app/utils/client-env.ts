import {type as arktype} from 'arktype'

const envShape = arktype({
  VITE_DATABASE_URL: 'string',
  VITE_SERVER_API: 'string',
})

const loadEnv = (): typeof envShape.infer => {
  return envShape.assert(import.meta.env)
}

export const env = loadEnv()
