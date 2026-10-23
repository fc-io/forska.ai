import {type as arktype} from 'arktype'

import type {ProjectTransferDependencyResolutionRequest} from '../../../services/projectTransfer/projectTransferDependencyResolution.ts'
import {getUnexpectedBodyKey, isRecord, parseRequestBody} from '../projectTransferRequestBody.ts'

const dependencyProviderSelectionShape = arktype({
  sourceProviderConnectionId: 'string',
  targetProviderConnectionId: 'string',
})
const dependencyCreatedProviderHandoffShape = arktype({
  'setupState?': '"auth_pending" | "complete" | "connection_test_pending" | "discovery_pending"',
  sourceProviderConnectionId: 'string',
  targetProviderConnectionId: 'string',
})
const dependencyModelSelectionShape = arktype({
  'acceptSubstitute?': 'boolean',
  sourceModelId: 'string',
  targetModelId: 'string',
})
const dependencyMaterializedModelHandoffShape = arktype({
  'acceptSubstitute?': 'boolean',
  sourceModelId: 'string',
  targetModelId: 'string',
  'targetProviderConnectionId?': 'string',
})
const dependencyModelOptionsShape = arktype({'thinking?': 'string | null'})
const dependencyModelMaterializationRequestShape = arktype({
  'displayName?': 'string',
  'options?': dependencyModelOptionsShape,
  remoteModelId: 'string',
  sourceModelId: 'string',
  targetProviderConnectionId: 'string',
  'variant?': 'string | null',
})
const dependencyUnresolvedProviderShape = arktype({
  'reason?': 'string',
  sourceProviderConnectionId: 'string',
  'status?': '"ambiguous" | "blocked" | "missing"',
})
const dependencyUnresolvedModelShape = arktype({
  'reason?': 'string',
  sourceModelId: 'string',
  'status?': '"ambiguous" | "blocked" | "missing"',
})
const resolveImportDependenciesRequestShape = arktype({
  'autoResolve?': 'boolean',
  'codexSetupState?': '"complete" | "login_pending" | "not_ready" | "setup_pending"',
  'createdProviderConnections?': dependencyCreatedProviderHandoffShape.array(),
  'materializedModels?': dependencyMaterializedModelHandoffShape.array(),
  'modelMaterializationRequests?': dependencyModelMaterializationRequestShape.array(),
  planRevision: 'number.integer >= 0',
  'selectedModels?': dependencyModelSelectionShape.array(),
  'selectedProviderConnections?': dependencyProviderSelectionShape.array(),
  'unresolvedModels?': dependencyUnresolvedModelShape.array(),
  'unresolvedProviders?': dependencyUnresolvedProviderShape.array(),
})

type ResolveImportDependenciesRequest = ProjectTransferDependencyResolutionRequest

const getUnexpectedNestedArrayKey = ({allowedKeys, value}: {allowedKeys: readonly string[]; value: unknown}) => {
  if (!Array.isArray(value)) {
    return null
  }

  return (
    value
      .map((entry, index) => {
        return isRecord(entry) ? {index, key: getUnexpectedBodyKey(entry, allowedKeys) ?? null} : {index, key: null}
      })
      .find((entry) => {
        return entry.key !== null
      }) ?? null
  )
}

const validateResolveDependenciesNestedKeys = (
  body: Record<string, unknown>,
): {error: string; ok: false} | {ok: true} => {
  const nestedChecks = [
    {allowedKeys: ['sourceProviderConnectionId', 'targetProviderConnectionId'], field: 'selectedProviderConnections'},
    {
      allowedKeys: ['setupState', 'sourceProviderConnectionId', 'targetProviderConnectionId'],
      field: 'createdProviderConnections',
    },
    {allowedKeys: ['acceptSubstitute', 'sourceModelId', 'targetModelId'], field: 'selectedModels'},
    {
      allowedKeys: ['acceptSubstitute', 'sourceModelId', 'targetModelId', 'targetProviderConnectionId'],
      field: 'materializedModels',
    },
    {
      allowedKeys: [
        'displayName',
        'options',
        'remoteModelId',
        'sourceModelId',
        'targetProviderConnectionId',
        'variant',
      ],
      field: 'modelMaterializationRequests',
    },
    {allowedKeys: ['reason', 'sourceProviderConnectionId', 'status'], field: 'unresolvedProviders'},
    {allowedKeys: ['reason', 'sourceModelId', 'status'], field: 'unresolvedModels'},
  ] as const
  const invalidNestedKey =
    nestedChecks
      .map((check) => {
        const invalid = getUnexpectedNestedArrayKey({...check, value: body[check.field]})

        return invalid ? {...invalid, field: check.field} : null
      })
      .find((entry) => {
        return entry !== null
      }) ?? null

  return invalidNestedKey === null
    ? {ok: true}
    : {
        error:
          `Project transfer request body contains unsupported field ${invalidNestedKey.field}`
          + `[${invalidNestedKey.index}].${invalidNestedKey.key}`,
        ok: false,
      }
}

export const parseResolveDependenciesRequest = (
  body: unknown,
): {error: string; ok: false} | {ok: true; value: ResolveImportDependenciesRequest} => {
  const allowedKeys = [
    'autoResolve',
    'codexSetupState',
    'createdProviderConnections',
    'materializedModels',
    'modelMaterializationRequests',
    'planRevision',
    'selectedModels',
    'selectedProviderConnections',
    'unresolvedModels',
    'unresolvedProviders',
  ]
  const request = parseRequestBody<ResolveImportDependenciesRequest>(
    body,
    resolveImportDependenciesRequestShape,
    allowedKeys,
  )

  if (!request.ok) {
    return request
  }

  const nestedValidation = validateResolveDependenciesNestedKeys((body ?? {}) as Record<string, unknown>)

  return nestedValidation.ok ? request : nestedValidation
}
