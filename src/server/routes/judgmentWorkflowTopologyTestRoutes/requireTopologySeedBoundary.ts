import {getCurrentServerRole} from '../../utils/serverRuntimeRole.ts'

const seedTokenEnvKey = 'FORSKA_TEST_JUDGMENT_TOPOLOGY_SEED_TOKEN'

export const requireTopologySeedBoundary = (token: string) => {
  const configuredToken = String(process.env[seedTokenEnvKey] ?? '')

  if (
    process.env.NODE_ENV !== 'test'
    || getCurrentServerRole() !== 'maintenance-worker'
    || configuredToken.length === 0
    || token !== configuredToken
  ) {
    throw new Error('Judgment topology seed boundary is unavailable')
  }
}
