import {expect, test} from 'bun:test'

import {
  getProjectTransferPayloadFixtureMap,
  type ProjectTransferPayloadByKey,
  serializeProjectTransferPayload,
} from './projectTransferPayloadSchemas.ts'
import {redactProjectTransferPayloads} from './projectTransferRedaction.ts'

const getPayloads = () => {
  return getProjectTransferPayloadFixtureMap()
}

const getSharedShapeResult = (
  warnings: readonly {action: string; code: string; message: string; scope: string; severity: string}[] | undefined,
) => {
  return (warnings ?? []).every((warning) => {
    return warning.action && warning.code && warning.message && warning.scope && warning.severity
  })
}

test('project-transfer redaction removes package-boundary secrets, local paths, URLs, and full-text-derived fields', () => {
  const payloads = getPayloads()

  payloads.project.description = 'Local note at /Users/fredrik/secret-project.txt'
  payloads.articles[0] = {
    ...payloads.articles[0],
    fullText: 'Full text copied from /Users/fredrik/article.pdf',
    fullTextHtml: '<p>Full text</p>',
    fullTextPdf: '/Users/fredrik/article.pdf',
    originalData: {apiKey: 'api_key=secret-value', nested: {path: '/Users/fredrik/raw.json'}},
    sourceMetadata: {url: 'http://localhost:9999/private?token=secret-value'},
    url: 'http://localhost:9999/article?token=secret-value',
  }
  payloads.humanJudgments[0] = {
    ...payloads.humanJudgments[0],
    comment: 'Reviewer machine path /Users/fredrik/review.txt',
  }
  payloads.reviews[0] = {
    ...payloads.reviews[0],
    sections: {...payloads.reviews[0].sections, title: {comment: 'Bearer token=secret-value', reviewed: true}},
  }
  payloads.judgmentAssessments[0] = {
    ...payloads.judgmentAssessments[0],
    assessmentComment: 'Assessment note file:///Users/fredrik/assessment.txt',
  }
  payloads.providerConnections.records[0] = {
    ...payloads.providerConnections.records[0],
    baseURL: 'http://127.0.0.1:11434/v1?token=secret-value',
    configJson: {cachePath: '/Users/fredrik/.cache/provider', token: 'api_key=secret-value'},
  }
  payloads.models.records[0] = {
    ...payloads.models.records[0],
    metadataJson: {localPath: '/Users/fredrik/model.json', options: {thinking: 'medium'}},
  }

  const redacted = redactProjectTransferPayloads(payloads)
  const article = redacted.payloads.articles[0]
  const humanJudgment = redacted.payloads.humanJudgments[0]
  const review = redacted.payloads.reviews[0]
  const assessment = redacted.payloads.judgmentAssessments[0]
  const providerConnection = redacted.payloads.providerConnections.records[0]
  const model = redacted.payloads.models.records[0]

  expect(redacted.payloads.project.description).toBeNull()
  expect(article?.fullText).toBeNull()
  expect(article?.fullTextHtml).toBeNull()
  expect(article?.fullTextPdf).toBeNull()
  expect(article?.url).toBeNull()
  expect(article?.originalData).toEqual({apiKey: '[redacted]', nested: {path: '[redacted-local-path]'}})
  expect(article?.sourceMetadata).toEqual({url: '[redacted-url]'})
  expect(humanJudgment?.comment).toBeNull()
  expect(review?.sections).toMatchObject({title: {comment: null, reviewed: true}})
  expect(assessment?.assessmentComment).toBeNull()
  expect(providerConnection?.baseURL).toBeNull()
  expect(providerConnection?.configJson).toEqual({cachePath: '[redacted-local-path]', token: '[redacted]'})
  expect(model?.metadataJson).toEqual({localPath: '[redacted-local-path]', options: {thinking: 'medium'}})
  expect(getSharedShapeResult(redacted.warnings)).toBe(true)
  expect(
    redacted.warnings.map((warning) => {
      return warning.code
    }),
  ).toContain('articleFullTextOmitted')
  expect(
    redacted.warnings.map((warning) => {
      return warning.code
    }),
  ).toContain('runtimePathRedacted')
  expect(
    redacted.warnings.map((warning) => {
      return warning.code
    }),
  ).toContain('providerSecretRedacted')
})

test('project-transfer redaction omits decision-bearing rows instead of sanitizing decisions in place', () => {
  const payloads = getPayloads()

  payloads.judgments[0] = {...payloads.judgments[0], answeredOriginal: 'answer from /Users/fredrik/private-output.json'}
  payloads.humanJudgments[0] = {...payloads.humanJudgments[0], answer: 'api_key=secret-value'}
  payloads.humanJudgmentSummaries[0] = {
    ...payloads.humanJudgmentSummaries[0],
    answer: 'token=secret-value' as ProjectTransferPayloadByKey['humanJudgmentSummaries'][number]['answer'],
  }

  const redacted = redactProjectTransferPayloads(payloads)

  expect(redacted.payloads.judgments).toEqual([])
  expect(redacted.payloads.judgmentAssessments).toEqual([])
  expect(redacted.payloads.humanJudgments).toEqual([])
  expect(redacted.payloads.humanJudgmentSummaries).toEqual([])
  expect(
    redacted.warnings.find((warning) => {
      return warning.scope === 'judgments'
    }),
  ).toMatchObject({
    action: 'omitted',
    code: 'decisionPayloadRowOmitted',
    jsonPointer: '/0/answeredOriginal',
    severity: 'fidelity',
  })
  expect(
    redacted.warnings.find((warning) => {
      return warning.scope === 'judgmentAssessments'
    }),
  ).toMatchObject({action: 'omitted', code: 'dependentPayloadRowOmitted', severity: 'fidelity'})
  expect(
    redacted.warnings.find((warning) => {
      return warning.scope === 'humanJudgments'
    }),
  ).toMatchObject({
    action: 'omitted',
    code: 'decisionPayloadRowOmitted',
    jsonPointer: '/0/answer',
    severity: 'fidelity',
  })
  expect(
    redacted.warnings.find((warning) => {
      return warning.scope === 'humanJudgmentSummaries'
    }),
  ).toMatchObject({
    action: 'omitted',
    code: 'decisionPayloadRowOmitted',
    jsonPointer: '/0/answer',
    severity: 'fidelity',
  })
})

test('project-transfer redaction omits unsafe parent rows and dependent review payload rows', () => {
  const payloads = getPayloads()

  payloads.articles[0] = {...payloads.articles[0], articleTitle: '/Users/fredrik/private-title.txt'}
  payloads.prompts.records[0] = {
    ...payloads.prompts.records[0],
    originalText: 'Prompt includes sk-secret-value-for-redaction',
  }

  const redacted = redactProjectTransferPayloads(payloads)

  expect(redacted.payloads.articles).toEqual([])
  expect(redacted.payloads.prompts.records).toEqual([])
  expect(redacted.payloads.projectArticles).toEqual([])
  expect(redacted.payloads.projectPrompts.records).toEqual([])
  expect(redacted.payloads.articleImportRoutes).toEqual([])
  expect(redacted.payloads.judgments).toEqual([])
  expect(redacted.payloads.judgmentAssessments).toEqual([])
  expect(redacted.payloads.humanJudgments).toEqual([])
  expect(redacted.payloads.reviews).toEqual([])
  expect(
    redacted.warnings.find((warning) => {
      return warning.scope === 'articles'
    }),
  ).toMatchObject({code: 'decisionPayloadRowOmitted', severity: 'fidelity'})
  expect(
    redacted.warnings.find((warning) => {
      return warning.scope === 'prompts'
    }),
  ).toMatchObject({code: 'decisionPayloadRowOmitted', severity: 'fidelity'})
  expect(
    redacted.warnings.find((warning) => {
      return warning.scope === 'reviews'
    }),
  ).toMatchObject({code: 'dependentPayloadRowOmitted', severity: 'fidelity'})
})

test('project-transfer payload serialization migrates internal annotations into package warnings', () => {
  const payloads = getPayloads()
  const article = {
    ...payloads.articles[0],
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
  const [serializedArticle] = serializeProjectTransferPayload('articles', [article])
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
