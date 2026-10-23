import type {ProjectFullTextGate} from '../../services/judgmentJobFullTextGate.ts'

export const getProjectFullTextGateApi = (gate: ProjectFullTextGate): ProjectFullTextGate => {
  return {errors: gate.errors, warnings: gate.warnings}
}
