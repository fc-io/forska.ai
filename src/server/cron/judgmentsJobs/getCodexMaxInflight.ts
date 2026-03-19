import {env} from '../../utils/env.ts'

export const getCodexMaxInflight = (): number => {
  return Math.max(1, env.CODEX_MAX_INFLIGHT)
}
