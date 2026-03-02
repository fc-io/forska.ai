import {type} from 'arktype'

const BoolFromString = type('"true" | "false" | boolean').pipe((v) => {
  return typeof v === 'string' ? v.toLowerCase() === 'true' : v
})

export const FhirEhrPatientsImportBody = type({
  assetsFolder: 'string',
  'importRoute?': 'string',
  'dryRun?': BoolFromString,
})

export type FhirEhrPatientsImportBodyInput = typeof FhirEhrPatientsImportBody.infer

export type FhirEhrPatientsImportBodyNormalized = {assetsFolder: string; importRoute: string; dryRun: boolean}

const normalizeAssetsFolder = (value: string): string => {
  const trimmed = value.trim()
  return trimmed.endsWith('/') ? trimmed.replace(/\/+$/, '') : trimmed
}

const getDatasetIdFromAssetsFolder = (assetsFolder: string): string => {
  const rel = assetsFolder.startsWith('assets/') ? assetsFolder.slice('assets/'.length) : assetsFolder
  const normalized = rel.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized
    .split('/')
    .filter((p) => {
      return p.length > 0
    })
    .join(':')
}

export const deriveFhirImportRouteFromAssetsFolder = (assetsFolder: string): string => {
  const datasetId = getDatasetIdFromAssetsFolder(assetsFolder)
  return `fhir:${datasetId}`
}

export const deriveAssetsFolderFromFhirImportRoute = (importRoute: string): string | null => {
  const trimmed = importRoute.trim()
  if (!trimmed.startsWith('fhir:')) {
    return null
  }
  const afterPrefix = trimmed.slice('fhir:'.length).trim()
  if (afterPrefix.length === 0) {
    return null
  }
  const normalized = afterPrefix.replace(/^\/+/, '').replace(/\\/g, '/').replace(/:/g, '/').replace(/\/+$/, '')
  const withAssetsPrefix = normalized.startsWith('assets/') ? normalized : `assets/${normalized}`
  return withAssetsPrefix
}

const normalizeImportRoute = (value: string): string => {
  return value.trim()
}

const isAssetsFolderValid = (assetsFolder: string): boolean => {
  return assetsFolder.startsWith('assets/')
}

const isImportRouteValid = (importRoute: string): boolean => {
  return importRoute.startsWith('fhir:')
}

export const normalizeFhirEhrPatientsImportBody = (
  value: unknown,
): {ok: true; value: FhirEhrPatientsImportBodyNormalized} | {ok: false; error: string} => {
  const base = FhirEhrPatientsImportBody(value)
  if (Array.isArray(base)) {
    return {ok: false, error: 'Invalid import body'}
  }

  const parsed = base as FhirEhrPatientsImportBodyInput

  const assetsFolder = normalizeAssetsFolder(parsed.assetsFolder)
  if (!isAssetsFolderValid(assetsFolder)) {
    return {ok: false, error: 'assetsFolder must start with assets/'}
  }

  const importRouteRaw = parsed.importRoute
    ? normalizeImportRoute(parsed.importRoute)
    : deriveFhirImportRouteFromAssetsFolder(assetsFolder)
  if (!isImportRouteValid(importRouteRaw)) {
    return {ok: false, error: 'importRoute must start with fhir:'}
  }

  return {ok: true, value: {assetsFolder, importRoute: importRouteRaw, dryRun: Boolean(parsed.dryRun)}}
}

export const FhirNdjsonLine = type({
  resourceType: 'string',
  'id?': 'string',
  'subject?': {'reference?': 'string'},
  'patient?': {'reference?': 'string'},
  'encounter?': {'reference?': 'string'},
  'effectiveDateTime?': 'string',
  'issued?': 'string',
  'date?': 'string',
  'authoredOn?': 'string',
  'recordedDate?': 'string',
  'onsetDateTime?': 'string',
})

export type FhirNdjsonLineType = typeof FhirNdjsonLine.infer

export const FhirPatientLine = type({resourceType: '"Patient"', id: 'string'})

export const FhirEncounterLine = type({resourceType: '"Encounter"', id: 'string', subject: {reference: 'string'}})

export const FhirDocumentReferenceLine = type({
  resourceType: '"DocumentReference"',
  'content?': type({'attachment?': type({'data?': 'string'})}).array(),
})

export const FhirDiagnosticReportLine = type({
  resourceType: '"DiagnosticReport"',
  'presentedForm?': type({'data?': 'string'}).array(),
})
