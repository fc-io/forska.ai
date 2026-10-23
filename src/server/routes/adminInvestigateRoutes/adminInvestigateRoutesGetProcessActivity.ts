import {getProcessActivitySnapshot} from '../../utils/processActivityState.ts'
import {getCurrentServerRole} from '../../utils/serverRuntimeRole.ts'

export const adminInvestigateRoutesGetProcessActivity = ({query}: {query: {limit?: string}}) => {
  const parsedLimit = Number(query.limit ?? 50)

  return {
    data: {
      activity: getProcessActivitySnapshot({limit: Number.isFinite(parsedLimit) ? parsedLimit : 50}),
      process: {pid: process.pid, role: getCurrentServerRole(), serverRole: process.env.SERVER_ROLE ?? null},
    },
    error: null,
  }
}
