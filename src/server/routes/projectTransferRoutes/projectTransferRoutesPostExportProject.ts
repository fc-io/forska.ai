import {type as arktype} from 'arktype'

import type {ProjectTransferRawArticleProvenanceMode} from '../../services/projectTransfer/projectTransferContracts.ts'
import {createProjectTransferExport} from '../../services/projectTransfer/projectTransferExportPackage.ts'
import {getExportSourceProjectError} from './getExportSourceProjectError.ts'
import {getProjectTransferApiError} from './getProjectTransferApiError.ts'
import {getProjectTransferPackageHeaders} from './getProjectTransferPackageHeaders.ts'
import {parseRequestBody} from './projectTransferRequestBody.ts'
import type {ProjectTransferRoutesDependencies, RouteSet} from './projectTransferRouteTypes.ts'

type ExportProjectRequest = {rawArticleProvenanceMode?: ProjectTransferRawArticleProvenanceMode}

const exportProjectRequestShape = arktype({'rawArticleProvenanceMode?': '"include" | "omit"'})

const parseExportProjectRequest = (
  body: unknown,
): {error: string; ok: false} | {ok: true; value: ExportProjectRequest} => {
  return parseRequestBody<ExportProjectRequest>(body, exportProjectRequestShape, [
    'rawArticleProvenanceMode',
  ] satisfies Array<keyof ExportProjectRequest>)
}

const getArrayBufferBody = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

export const projectTransferRoutesPostExportProject = async ({
  body,
  dependencies,
  params,
  set,
}: {
  body: unknown
  dependencies: ProjectTransferRoutesDependencies
  params: {id: string}
  set: RouteSet
}) => {
  const request = parseExportProjectRequest(body)

  if (!request.ok) {
    return getProjectTransferApiError(set, 400, request.error)
  }

  const sourceProjectError = await getExportSourceProjectError(set, params.id, dependencies.getExportSourceProject)

  if (sourceProjectError !== null) {
    return sourceProjectError
  }

  const exportInput =
    request.value.rawArticleProvenanceMode === undefined
      ? {projectId: params.id}
      : {projectId: params.id, rawArticleProvenanceMode: request.value.rawArticleProvenanceMode}
  const result = await createProjectTransferExport(exportInput)

  if (result.executionMode === 'inline') {
    return new Response(getArrayBufferBody(result.packageBytes), {
      headers: getProjectTransferPackageHeaders(result.metadata),
    })
  }

  set.status = 202

  return {
    data: {
      downloadUrl: result.metadata.downloadUrl,
      expiresAt: result.metadata.expiresAt,
      exportId: result.sessionId,
      filename: result.metadata.filename,
      status: 'queued',
    },
    error: null,
  }
}
