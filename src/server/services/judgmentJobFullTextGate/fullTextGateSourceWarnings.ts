import {getDateValue} from '../appQueryHelpers.ts'
import {getHealthDetail} from '../fullTextModelStatus.ts'
import {getLocalUserConfigWhereClauseSql} from '../userConfigQueryService.ts'

type FullTextGateSourceRunner = {queryJson: <T>(statement: string) => Promise<T[]>}

export type FullTextGateArticleFetchSettings = {unpaywallEmailSet: boolean}

export type FullTextGateModelConnectionHealth = {
  lastCheckedAt: unknown
  lastError: string | null
  providerLabel: string
}

export const unpaywallEmailMissingWarning =
  'No Unpaywall email is set in Settings; PDFs are fetched only from publisher URLs and arXiv.'

export const getArticleFetchWarnings = (settings: FullTextGateArticleFetchSettings): string[] => {
  return settings.unpaywallEmailSet ? [] : [unpaywallEmailMissingWarning]
}

export const getModelConnectionHealthWarnings = ({
  connectionHealth,
  modelReference,
}: {
  connectionHealth: FullTextGateModelConnectionHealth | null
  modelReference: string
}): string[] => {
  const lastError = connectionHealth?.lastError?.trim() ?? ''
  const healthDetail = connectionHealth
    ? getHealthDetail({
        lastCheckedAt: getDateValue(connectionHealth.lastCheckedAt),
        lastError,
        providerLabel: connectionHealth.providerLabel,
        state: 'failed',
      })
    : ''

  return lastError === ''
    ? []
    : [
        `Judging model ${modelReference}: ${healthDetail} Its context window and image input come from the last successful model refresh.`,
      ]
}

export const getArticleFetchSettings = async (
  runner: FullTextGateSourceRunner,
): Promise<FullTextGateArticleFetchSettings> => {
  const [row] = await runner.queryJson<{unpaywallEmail: string | null}>(`
    SELECT NULLIF(TRIM(uc.unpaywall_email), '') AS unpaywallEmail
    FROM app.user_config uc
    WHERE ${getLocalUserConfigWhereClauseSql('uc.id')}
    LIMIT 1
  `)

  return {unpaywallEmailSet: Boolean(row?.unpaywallEmail)}
}
