import {runCovidenceRematch} from '../../services/covidenceRematchService.ts'

export const dataSourcesRoutesPostCovidenceRematch = async ({
  body,
  params,
}: {
  body: {baseImportRoute: string; dryRun: boolean}
  params: {id: string}
}) => {
  return {
    data: await runCovidenceRematch({
      baseImportRoute: body.baseImportRoute.trim(),
      dataSourceId: params.id,
      dryRun: body.dryRun,
    }),
  }
}
