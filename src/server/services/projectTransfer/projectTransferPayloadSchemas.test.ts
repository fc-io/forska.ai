import {expect, test} from 'bun:test'

import {
  getProjectTransferPayloadFixture,
  normalizeProjectTransferModelVariant,
  parseProjectTransferPayload,
  projectTransferPayloadFixtures,
  projectTransferPayloadOmissionCodes,
  projectTransferPayloadRedactionCodes,
  type ProjectTransferPayloadValidationResult,
  projectTransferPayloadValidatorsByKey,
  projectTransferPayloadWarningCodes,
  serializeProjectTransferPayload,
  validateProjectTransferPayload,
} from './projectTransferPayloadSchemas.ts'
import type {ProjectTransferPayloadKey} from './projectTransferSchemas.ts'
import {projectTransferPayloadKeys} from './projectTransferSchemas.ts'

const getValidationError = <TKey extends ProjectTransferPayloadKey>(
  result: ProjectTransferPayloadValidationResult<TKey>,
) => {
  return result.ok ? null : result.error.message
}

const getOnlyRecord = <TRecord>(records: TRecord[]) => {
  const record = records[0]

  if (record === undefined) {
    throw new Error('Expected fixture record')
  }

  return record
}

test('validates and round-trips every manifest-declared payload fixture', () => {
  const validatorKeys = Object.keys(projectTransferPayloadValidatorsByKey).sort()
  const expectedValidatorKeys = [...projectTransferPayloadKeys].sort()
  const fixtureResults = projectTransferPayloadKeys.map((key) => {
    const fixture = getProjectTransferPayloadFixture(key)
    const validation = validateProjectTransferPayload(key, fixture)
    const serialized = serializeProjectTransferPayload(key, fixture)
    const parsed = parseProjectTransferPayload(key, serialized)

    return {key, ok: validation.ok, roundTrips: JSON.stringify(parsed) === JSON.stringify(fixture)}
  })

  expect(validatorKeys).toEqual(expectedValidatorKeys)
  expect(fixtureResults).toEqual(
    projectTransferPayloadKeys.map((key) => {
      return {key, ok: true, roundTrips: true}
    }),
  )
})

test('locks project settings and warning, omission, and redaction code fixtures', () => {
  const project = getProjectTransferPayloadFixture('project')
  const article = getOnlyRecord(getProjectTransferPayloadFixture('articles'))
  const providerConnection = getOnlyRecord(getProjectTransferPayloadFixture('providerConnections'))
  const invalidSettingsResult = validateProjectTransferPayload('project', {
    ...project,
    settings: {
      ...project.settings,
      useAbstract: false,
      useFulltext: false,
      useFulltextNoImages: false,
      useTitle: false,
    },
  })
  const invalidWarningResult = validateProjectTransferPayload('articles', [
    {
      ...article,
      warnings: [
        {action: 'redacted', code: 'secretOmitted', message: 'fixture', scope: 'articles', severity: 'warning'},
      ],
    },
  ])

  expect(projectTransferPayloadWarningCodes).toEqual([
    'articleFullTextOmitted',
    'freeFormValueRedacted',
    'identifierConflict',
    'identifierRejected',
    'nonLocalUrlPreserved',
    'payloadOmitted',
    'projectSettingUnsupported',
    'providerConfigValueRedacted',
    'providerSecretRedacted',
    'runtimePathRedacted',
    'urlRedacted',
  ])
  expect(projectTransferPayloadOmissionCodes).toContain('articleFullTextOmitted')
  expect(projectTransferPayloadOmissionCodes).toContain('providerSecretRedacted')
  expect(projectTransferPayloadRedactionCodes).toContain('providerSecretRedacted')
  expect(article.warnings).toEqual([
    {
      action: 'omitted',
      code: 'articleFullTextOmitted',
      jsonPointer: '/fullText',
      message: 'Article full text was omitted from the package payload.',
      scope: 'articles',
      severity: 'info',
    },
  ])
  expect(providerConnection.warnings).toEqual([
    {
      action: 'redacted',
      code: 'providerSecretRedacted',
      jsonPointer: '/secretRef',
      message: 'Provider authentication secret was redacted.',
      scope: 'providerConnections',
      severity: 'warning',
    },
  ])
  expect(getValidationError(invalidSettingsResult)).toContain('must enable at least one article content field')
  expect(getValidationError(invalidWarningResult)).toContain('unknown code secretOmitted')
})

test('rejects missing required signature fields and source ids outside provenance', () => {
  const project = getProjectTransferPayloadFixture('project')
  const article = getOnlyRecord(getProjectTransferPayloadFixture('articles'))
  const judgment = getOnlyRecord(getProjectTransferPayloadFixture('judgments'))
  const humanJudgment = getOnlyRecord(getProjectTransferPayloadFixture('humanJudgments'))
  const judgmentInputSignature = judgment.judgmentInputSignature as Record<string, unknown>
  const humanReviewInputSignature = humanJudgment.humanReviewInputSignature as Record<string, unknown>
  const {modelSignature: _modelSignature, ...signatureWithoutModel} = project.signature
  const {judgmentInputSignature: _judgmentInputSignature, ...judgmentWithoutInputSignature} = judgment
  const missingSignatureResult = validateProjectTransferPayload('project', {
    ...project,
    signature: signatureWithoutModel,
  })
  const missingJudgmentInputSignatureResult = validateProjectTransferPayload('judgments', [
    judgmentWithoutInputSignature,
  ])
  const sourceIdInSignatureResult = validateProjectTransferPayload('project', {
    ...project,
    signature: {...project.signature, sourceProjectId: 'source-project-1'},
  })
  const sourceIdInJudgmentInputSignatureResult = validateProjectTransferPayload('judgments', [
    {...judgment, judgmentInputSignature: {...judgmentInputSignature, sourceArticleId: 'article-1'}},
  ])
  const targetIdInHumanReviewInputSignatureResult = validateProjectTransferPayload('humanJudgments', [
    {...humanJudgment, humanReviewInputSignature: {...humanReviewInputSignature, targetPromptId: 'prompt-1'}},
  ])
  const genericSourceIdInSignatureResult = validateProjectTransferPayload('project', {
    ...project,
    signature: {...project.signature, sourceId: 'source-project-1'},
  })
  const genericTargetIdInSignatureResult = validateProjectTransferPayload('project', {
    ...project,
    signature: {...project.signature, targetId: 'target-project-1'},
  })
  const targetIdResult = validateProjectTransferPayload('articles', [{...article, id: 'target-article-1'}])

  expect(getValidationError(missingSignatureResult)).toContain('missing required field modelSignature')
  expect(getValidationError(missingJudgmentInputSignatureResult)).toContain(
    'missing required field judgmentInputSignature',
  )
  expect(getValidationError(sourceIdInSignatureResult)).toContain('must not contain source or target ids')
  expect(getValidationError(sourceIdInJudgmentInputSignatureResult)).toContain('must not contain source or target ids')
  expect(getValidationError(targetIdInHumanReviewInputSignatureResult)).toContain(
    'must not contain source or target ids',
  )
  expect(getValidationError(genericSourceIdInSignatureResult)).toContain('must not contain source or target ids')
  expect(getValidationError(genericTargetIdInSignatureResult)).toContain('must not contain source or target ids')
  expect(getValidationError(targetIdResult)).toContain('source ids must stay in provenance fields')
})

test('locks article identifier signature boundaries with shared DOI, PMID, arXiv, bioRxiv, and medRxiv semantics', () => {
  const article = getOnlyRecord(getProjectTransferPayloadFixture('articles'))
  const mismatchedSignatureResult = validateProjectTransferPayload('articles', [
    {...article, signature: {...article.signature, identifierKeys: ['doi:10.9999/not-the-article']}},
  ])
  const rejectedIdentifierResult = validateProjectTransferPayload('articles', [
    {...article, doi: '10.1000', signature: {...article.signature, identifierKeys: []}},
  ])
  const publisherUrlResult = validateProjectTransferPayload('articles', [
    {...article, url: 'https://www.thelancet.com/journals/lancet/article/piis0140-6736(23)00000-0/fulltext'},
  ])

  expect(article.signature.identifierKeys).toEqual(['arxiv:2401.12345', 'doi:10.1101/2024.01.01.123456', 'pmid:12345'])
  expect(getValidationError(mismatchedSignatureResult)).toContain('must match normalized strong identifiers')
  expect(getValidationError(rejectedIdentifierResult)).toContain('rejected identifier inputs')
  expect(publisherUrlResult.ok).toBe(true)
})

test('rejects provider/model edge cases while normalizing empty model variants to null', () => {
  const providerConnections = getProjectTransferPayloadFixture('providerConnections')
  const models = getProjectTransferPayloadFixture('models')
  const providerConnection = getOnlyRecord(providerConnections)
  const model = getOnlyRecord(models)
  const secretResult = validateProjectTransferPayload('providerConnections', [
    {...providerConnection, secretRef: 'secret://local/provider'},
  ])
  const blankRemoteModelResult = validateProjectTransferPayload('models', [{...model, remoteModelId: ''}])
  const nullableRemoteModelResult = validateProjectTransferPayload('models', [
    {
      ...model,
      displayName: model.name,
      modelName: model.name,
      remoteModelId: null,
      signature: {...model.signature, displayName: model.name, modelName: model.name, remoteModelId: null},
    },
  ])
  const nullableRemoteWithoutDisplayNameResult = validateProjectTransferPayload('models', [
    {
      ...model,
      displayName: null,
      modelName: model.name,
      remoteModelId: null,
      signature: {...model.signature, displayName: null, modelName: model.name, remoteModelId: null},
    },
  ])
  const emptyVariantResult = validateProjectTransferPayload('models', [
    {...model, signature: {...model.signature, variant: null}, variant: ''},
  ])
  const mismatchedVariantResult = validateProjectTransferPayload('models', [
    {...model, signature: {...model.signature, variant: ''}, variant: ''},
  ])

  expect(normalizeProjectTransferModelVariant('')).toBe(null)
  expect(getValidationError(secretResult)).toContain('secretRef must be null')
  expect(getValidationError(blankRemoteModelResult)).toContain('remoteModelId must not be empty')
  expect(nullableRemoteModelResult.ok).toBe(true)
  expect(getValidationError(nullableRemoteWithoutDisplayNameResult)).toContain(
    'displayName is required when remoteModelId is null',
  )
  expect(emptyVariantResult.ok).toBe(true)
  expect(getValidationError(mismatchedVariantResult)).toContain(
    'signature.variant must normalize null and empty variants',
  )
})

test('rejects invalid asset package paths and checksum signatures', () => {
  const assetManifest = getProjectTransferPayloadFixture('assetManifest')
  const asset = getOnlyRecord(assetManifest.entries)
  const invalidPathResult = validateProjectTransferPayload('assetManifest', {
    ...assetManifest,
    entries: [{...asset, packagePath: '../assets/file.pdf'}],
  })
  const invalidChecksumResult = validateProjectTransferPayload('assetManifest', {
    ...assetManifest,
    entries: [{...asset, checksumSha256: 'not-a-sha'}],
  })
  const oldEnvelopeResult = validateProjectTransferPayload('assetManifest', {
    assets: [{...asset, packagePath: 'assets/file.pdf'}],
    provenance: {sourceProjectId: 'source-project-1'},
    signature: {assets: []},
  })

  expect(projectTransferPayloadFixtures.assetManifest.entries).toHaveLength(1)
  expect(getValidationError(invalidPathResult)).toContain('Project transfer path contains traversal')
  expect(getValidationError(invalidChecksumResult)).toContain('checksumSha256 must be lowercase SHA-256 hex')
  expect(getValidationError(oldEnvelopeResult)).toContain('assetManifest payload must use top-level entries only')
})

test('serializes internal payload annotations into package warnings', () => {
  const article = getOnlyRecord(getProjectTransferPayloadFixture('articles'))
  const annotatedArticle = {
    ...article,
    omissions: [
      {
        action: 'omitted',
        code: 'articleFullTextOmitted' as const,
        jsonPointer: '/fullText',
        message: 'Article full text was omitted from the package payload.',
        scope: 'articles',
        severity: 'info' as const,
      },
    ],
    redactions: [
      {
        action: 'redacted',
        code: 'runtimeAssetPathRedacted' as const,
        jsonPointer: '/fullTextPdf',
        message: 'Runtime asset path was redacted from the package payload.',
        scope: 'articles',
        severity: 'warning' as const,
      },
    ],
  }
  const [serializedArticle] = serializeProjectTransferPayload('articles', [annotatedArticle])
    .trim()
    .split('\n')
    .map((line) => {
      return JSON.parse(line) as Record<string, unknown>
    })

  expect(serializedArticle?.omissions).toBeUndefined()
  expect(serializedArticle?.redactions).toBeUndefined()
  expect(serializedArticle?.warnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({code: 'articleFullTextOmitted', scope: 'articles'}),
      expect.objectContaining({code: 'runtimeAssetPathRedacted', scope: 'articles'}),
    ]),
  )
})
