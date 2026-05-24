import {getProjectTransferStrongIdentifierComparisonKeys} from './projectTransferIdentifierNormalization.ts'
import {
  assertProjectTransferPayload,
  type ProjectTransferArticlePayloadRecord,
  type ProjectTransferPayloadByKey,
  type ProjectTransferPayloadCollection,
  type ProjectTransferPayloadRecord,
} from './projectTransferPayloadSchemas.ts'
import {type ProjectTransferPackageWarning, type ProjectTransferPayloadKey} from './projectTransferSchemas.ts'

type JsonRecord = Record<string, unknown>

type ProjectTransferRedactionOutput = {payloads: ProjectTransferPayloadByKey; warnings: ProjectTransferPackageWarning[]}

type RedactionContext = {jsonPointer: string; payloadKey: ProjectTransferPayloadKey; sourceRef?: string}

type RedactedValue<TValue> = {changed: boolean; value: TValue; warnings: ProjectTransferPackageWarning[]}

type RowRedactionResult<TRecord> = {
  omittedSourceIds: string[]
  records: TRecord[]
  warnings: ProjectTransferPackageWarning[]
}

type RedactionMatch = {
  code: 'freeFormValueRedacted' | 'providerSecretRedacted' | 'runtimePathRedacted' | 'urlRedacted'
  message: string
  placeholder: string
}

const redactedValuePlaceholder = '[redacted]'
const redactedUrlPlaceholder = '[redacted-url]'
const redactedLocalPathPlaceholder = '[redacted-local-path]'
const fileUrlPattern = /file:\/\//i
const localPathPattern = /(^|[\s"'(=:])((\/Users\/|\/home\/|\/private\/|\/tmp\/|\/var\/folders\/)|[A-Za-z]:\\)/
const secretPattern =
  /(api[_-]?key|secret|password|passwd|token|bearer)\s*[:=]\s*\S+|sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}/i
const urlProtocolPattern = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//
const privateHostnamePattern = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/
const fullTextDerivedArticleFields = [
  'fullText',
  'fullTextCharCount',
  'fullTextConversionAttempts',
  'fullTextConversionError',
  'fullTextConversionMetadata',
  'fullTextConversionModelId',
  'fullTextConversionStatus',
  'fullTextFetchedAt',
  'fullTextOriginalFormat',
  'fullTextSource',
] as const
const articleJsonFields = [
  'canonicalOriginalData',
  'canonicalSourceMetadata',
  'originalData',
  'scopedImportMetadata',
  'scopedRawPayload',
  'sourceMetadata',
] as const
const articleUrlFields = ['arxivId', 'biorxivId', 'doi', 'medrxivId', 'url'] as const
const promptDecisionFields = ['originalText', 'transformedText'] as const
const judgmentDecisionFields = ['answeredOriginal', 'answeredOriginalAsArray', 'explanation', 'quotes'] as const

const isRecord = (value: unknown): value is JsonRecord => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isString = (value: unknown): value is string => {
  return typeof value === 'string'
}

const pointerSegment = (segment: string | number) => {
  return String(segment).replaceAll('~', '~0').replaceAll('/', '~1')
}

const childPointer = (parent: string, segment: string | number) => {
  return `${parent}/${pointerSegment(segment)}`
}

const getWarning = ({
  action,
  code,
  details,
  jsonPointer,
  message,
  payloadKey,
  severity,
  sourceRef,
}: {
  action: string
  code: string
  details?: unknown
  jsonPointer?: string
  message: string
  payloadKey: ProjectTransferPayloadKey
  severity: ProjectTransferPackageWarning['severity']
  sourceRef?: string
}): ProjectTransferPackageWarning => {
  return {action, code, details, jsonPointer, message, scope: payloadKey, severity, sourceRef}
}

const parseUrlValue = (value: string) => {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

const getUrlValue = (value: string) => {
  return urlProtocolPattern.test(value.trim()) ? parseUrlValue(value) : null
}

const isPrivateHostname = (hostname: string) => {
  const normalized = hostname.toLowerCase()

  return (
    normalized === 'localhost'
    || normalized === '[::1]'
    || normalized === '::1'
    || normalized.endsWith('.local')
    || privateHostnamePattern.test(normalized)
  )
}

const getStringRedactionMatch = (value: string): RedactionMatch | null => {
  const url = getUrlValue(value)
  const isLocalUrl = url && (url.protocol === 'file:' || isPrivateHostname(url.hostname))
  const hasUnsafeUrlParts = url && (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '')
  const hasLocalPath = fileUrlPattern.test(value) || localPathPattern.test(value)

  return isLocalUrl
    ? {
        code: 'runtimePathRedacted',
        message: 'Local URL or runtime path was redacted from the package payload.',
        placeholder: redactedUrlPlaceholder,
      }
    : hasUnsafeUrlParts
      ? {
          code: 'urlRedacted',
          message: 'URL credentials, query, or fragment were redacted from the package payload.',
          placeholder: `${url.origin}${url.pathname}`,
        }
      : hasLocalPath
        ? {
            code: 'runtimePathRedacted',
            message: 'Local runtime path was redacted from the package payload.',
            placeholder: redactedLocalPathPlaceholder,
          }
        : secretPattern.test(value)
          ? {
              code: 'providerSecretRedacted',
              message: 'Secret-like value was redacted from the package payload.',
              placeholder: redactedValuePlaceholder,
            }
          : null
}

const hasUnsafeRedactableValue = (value: unknown): boolean => {
  return isString(value)
    ? getStringRedactionMatch(value) !== null
    : Array.isArray(value)
      ? value.some(hasUnsafeRedactableValue)
      : isRecord(value)
        ? Object.values(value).some(hasUnsafeRedactableValue)
        : false
}

const redactStringValue = (value: string, context: RedactionContext): RedactedValue<string> => {
  const match = getStringRedactionMatch(value)

  return match === null
    ? {changed: false, value, warnings: []}
    : {
        changed: true,
        value: match.placeholder,
        warnings: [
          getWarning({
            action: 'redacted',
            code: match.code,
            details: {reason: match.code},
            jsonPointer: context.jsonPointer,
            message: match.message,
            payloadKey: context.payloadKey,
            severity: 'warning',
            sourceRef: context.sourceRef,
          }),
        ],
      }
}

const redactJsonValue = (value: unknown, context: RedactionContext): RedactedValue<unknown> => {
  return isString(value)
    ? redactStringValue(value, context)
    : Array.isArray(value)
      ? redactJsonArrayValue(value, context)
      : isRecord(value)
        ? redactJsonRecordValue(value, context)
        : {changed: false, value, warnings: []}
}

const redactJsonArrayValue = (value: unknown[], context: RedactionContext): RedactedValue<unknown[]> => {
  const results = value.map((entry, index) => {
    return redactJsonValue(entry, {...context, jsonPointer: childPointer(context.jsonPointer, index)})
  })
  const changed = results.some((result) => {
    return result.changed
  })

  return {
    changed,
    value: changed
      ? results.map((result) => {
          return result.value
        })
      : value,
    warnings: results.flatMap((result) => {
      return result.warnings
    }),
  }
}

const redactJsonRecordValue = (value: JsonRecord, context: RedactionContext): RedactedValue<JsonRecord> => {
  const entries = Object.entries(value).map(([field, entry]) => {
    const result = redactJsonValue(entry, {...context, jsonPointer: childPointer(context.jsonPointer, field)})

    return {field, result}
  })
  const changed = entries.some(({result}) => {
    return result.changed
  })

  return {
    changed,
    value: changed
      ? entries.reduce<JsonRecord>((record, {field, result}) => {
          return {...record, [field]: result.value}
        }, {})
      : value,
    warnings: entries.flatMap(({result}) => {
      return result.warnings
    }),
  }
}

const redactStringField = <TRecord extends JsonRecord>(
  record: TRecord,
  field: string,
  context: RedactionContext,
  required = false,
): RedactedValue<TRecord> => {
  const value = record[field]

  const result = isString(value)
    ? redactStringValue(value, {...context, jsonPointer: childPointer(context.jsonPointer, field)})
    : null
  const nextValue = result?.changed && !required ? null : result?.value

  return result?.changed
    ? {changed: true, value: {...record, [field]: nextValue}, warnings: result.warnings}
    : {changed: false, value: record, warnings: []}
}

const redactJsonField = <TRecord extends JsonRecord>(
  record: TRecord,
  field: string,
  context: RedactionContext,
): RedactedValue<TRecord> => {
  const value = record[field]
  const result = redactJsonValue(value, {...context, jsonPointer: childPointer(context.jsonPointer, field)})

  return result.changed
    ? {changed: true, value: {...record, [field]: result.value}, warnings: result.warnings}
    : {changed: false, value: record, warnings: []}
}

const applyFieldRedactions = <TRecord extends JsonRecord>(
  record: TRecord,
  redactions: Array<(recordValue: TRecord) => RedactedValue<TRecord>>,
): RedactedValue<TRecord> => {
  return redactions.reduce<RedactedValue<TRecord>>(
    (current, redact) => {
      const result = redact(current.value)

      return {
        changed: current.changed || result.changed,
        value: result.value,
        warnings: [...current.warnings, ...result.warnings],
      }
    },
    {changed: false, value: record, warnings: []},
  )
}

const getSourceRef = (prefix: string, value: unknown) => {
  return isString(value) && value.trim() !== '' ? `${prefix}:${value}` : undefined
}

const getRecordSourceRef = (record: JsonRecord) => {
  return (
    getSourceRef('judgment', record.sourceJudgmentId)
    ?? getSourceRef('assessment', record.sourceJudgmentAssessmentId)
    ?? getSourceRef('humanJudgment', record.sourceHumanJudgmentId)
    ?? getSourceRef('humanSummary', record.sourceHumanJudgmentSummaryId)
    ?? getSourceRef('review', record.sourceReviewId)
    ?? getSourceRef('article', record.sourceArticleId)
    ?? getSourceRef('prompt', record.sourcePromptId)
    ?? getSourceRef('model', record.sourceModelId)
    ?? getSourceRef('provider', record.sourceProviderConnectionId)
    ?? getSourceRef('project', record.sourceProjectId)
  )
}

const getCollectionWithRecords = <TRecord extends ProjectTransferPayloadRecord>(
  collection: ProjectTransferPayloadCollection<TRecord>,
  records: TRecord[],
): ProjectTransferPayloadCollection<TRecord> => {
  return {
    ...collection,
    records,
    signature: {
      ...collection.signature,
      records: records.map((record) => {
        return record.signature
      }),
    },
  }
}

const omitRecordWarning = ({
  code,
  jsonPointer,
  message,
  payloadKey,
  sourceRef,
}: {
  code: string
  jsonPointer: string
  message: string
  payloadKey: ProjectTransferPayloadKey
  sourceRef?: string
}) => {
  return getWarning({action: 'omitted', code, jsonPointer, message, payloadKey, severity: 'fidelity', sourceRef})
}

const omitDependentRecordWarning = ({
  jsonPointer,
  payloadKey,
  reason,
  sourceRef,
}: {
  jsonPointer: string
  payloadKey: ProjectTransferPayloadKey
  reason: string
  sourceRef?: string
}) => {
  return getWarning({
    action: 'omitted',
    code: 'dependentPayloadRowOmitted',
    details: {reason},
    jsonPointer,
    message: 'Dependent payload row was omitted because its parent row was omitted.',
    payloadKey,
    severity: 'fidelity',
    sourceRef,
  })
}

const getUnsafeField = (record: JsonRecord, fields: readonly string[]) => {
  return fields.find((field) => {
    return hasUnsafeRedactableValue(record[field])
  })
}

const redactProjectRecord = (
  project: ProjectTransferPayloadByKey['project'],
): RedactedValue<ProjectTransferPayloadByKey['project']> => {
  const context = {jsonPointer: '', payloadKey: 'project' as const, sourceRef: getRecordSourceRef(project)}

  return applyFieldRedactions(project, [
    (record) => {
      return redactStringField(record, 'name', context, true)
    },
    (record) => {
      return redactStringField(record, 'description', context)
    },
    (record) => {
      return redactJsonField(record, 'modelSignature', context)
    },
    (record) => {
      return redactJsonField(record, 'signature', context)
    },
  ])
}

const redactPromptRecords = (
  prompts: ProjectTransferPayloadByKey['prompts'],
): RowRedactionResult<ProjectTransferPayloadByKey['prompts']['records'][number]> => {
  return prompts.records.reduce<RowRedactionResult<ProjectTransferPayloadByKey['prompts']['records'][number]>>(
    (result, record, index) => {
      const jsonPointer = `/records/${index}`
      const sourceRef = getRecordSourceRef(record)
      const unsafeField = getUnsafeField(record, promptDecisionFields)

      const redacted = applyFieldRedactions(record, [
        (recordValue) => {
          return redactStringField(recordValue, 'promptHeading', {jsonPointer, payloadKey: 'prompts', sourceRef})
        },
        (recordValue) => {
          return redactJsonField(recordValue, 'signature', {jsonPointer, payloadKey: 'prompts', sourceRef})
        },
      ])

      return unsafeField
        ? {
            omittedSourceIds: [...result.omittedSourceIds, record.sourcePromptId],
            records: result.records,
            warnings: [
              ...result.warnings,
              omitRecordWarning({
                code: 'decisionPayloadRowOmitted',
                jsonPointer: childPointer(jsonPointer, unsafeField),
                message: 'Prompt row was omitted because a benchmark input field would require redaction.',
                payloadKey: 'prompts',
                sourceRef,
              }),
            ],
          }
        : {
            omittedSourceIds: result.omittedSourceIds,
            records: [...result.records, redacted.value],
            warnings: [...result.warnings, ...redacted.warnings],
          }
    },
    {omittedSourceIds: [], records: [], warnings: []},
  )
}

const getArticleDecisionFields = (project: ProjectTransferPayloadByKey['project']) => {
  return [
    ...(project.settings.useTitle ? ['articleTitle'] : []),
    ...(project.settings.useAbstract ? ['articleSummary'] : []),
  ]
}

const omitFullTextDerivedFields = (record: JsonRecord, context: RedactionContext): RedactedValue<JsonRecord> => {
  return fullTextDerivedArticleFields.reduce<RedactedValue<JsonRecord>>(
    (current, field) => {
      return current.value[field] === null || current.value[field] === undefined
        ? current
        : {
            changed: true,
            value: {...current.value, [field]: null},
            warnings: [
              ...current.warnings,
              getWarning({
                action: 'omitted',
                code: 'articleFullTextOmitted',
                details: {field},
                jsonPointer: childPointer(context.jsonPointer, field),
                message: 'Full-text-derived article field was omitted from the package payload.',
                payloadKey: context.payloadKey,
                severity: 'info',
                sourceRef: context.sourceRef,
              }),
            ],
          }
    },
    {changed: false, value: record, warnings: []},
  )
}

const getArticleSignature = (record: ProjectTransferArticlePayloadRecord) => {
  return {identifierKeys: getProjectTransferStrongIdentifierComparisonKeys(record), title: record.articleTitle}
}

const redactArticleRecord = (
  record: ProjectTransferArticlePayloadRecord,
  context: RedactionContext,
): RedactedValue<ProjectTransferArticlePayloadRecord> => {
  const redacted = applyFieldRedactions(record, [
    (recordValue) => {
      return omitFullTextDerivedFields(recordValue, context) as RedactedValue<ProjectTransferArticlePayloadRecord>
    },
    (recordValue) => {
      return redactJsonField(recordValue, 'fullTextAssets', context)
    },
    (recordValue) => {
      return redactStringField(recordValue, 'fullTextHtml', context)
    },
    (recordValue) => {
      return redactStringField(recordValue, 'fullTextPdf', context)
    },
    ...articleJsonFields.map((field) => {
      return (recordValue: ProjectTransferArticlePayloadRecord) => {
        return redactJsonField(recordValue, field, context)
      }
    }),
    ...articleUrlFields.map((field) => {
      return (recordValue: ProjectTransferArticlePayloadRecord) => {
        return redactStringField(recordValue, field, context)
      }
    }),
    (recordValue) => {
      return redactStringField(recordValue, 'articleSummary', context)
    },
  ])
  const nextRecord = {...redacted.value, signature: getArticleSignature(redacted.value)}

  return {...redacted, value: nextRecord}
}

const redactArticleRecords = (
  articles: ProjectTransferPayloadByKey['articles'],
  project: ProjectTransferPayloadByKey['project'],
): RowRedactionResult<ProjectTransferArticlePayloadRecord> => {
  const decisionFields = getArticleDecisionFields(project)

  return articles.reduce<RowRedactionResult<ProjectTransferArticlePayloadRecord>>(
    (result, record, index) => {
      const jsonPointer = `/${index}`
      const sourceRef = getRecordSourceRef(record)
      const unsafeField = getUnsafeField(record, decisionFields)

      const redacted = redactArticleRecord(record, {jsonPointer, payloadKey: 'articles', sourceRef})

      return unsafeField
        ? {
            omittedSourceIds: [...result.omittedSourceIds, record.sourceArticleId],
            records: result.records,
            warnings: [
              ...result.warnings,
              omitRecordWarning({
                code: 'decisionPayloadRowOmitted',
                jsonPointer: childPointer(jsonPointer, unsafeField),
                message: 'Article row was omitted because a review input field would require redaction.',
                payloadKey: 'articles',
                sourceRef,
              }),
            ],
          }
        : {
            omittedSourceIds: result.omittedSourceIds,
            records: [...result.records, redacted.value],
            warnings: [...result.warnings, ...redacted.warnings],
          }
    },
    {omittedSourceIds: [], records: [], warnings: []},
  )
}

const redactRecordSet = <TRecord extends ProjectTransferPayloadRecord>(
  payloadKey: ProjectTransferPayloadKey,
  records: TRecord[],
  redactRecord: (record: TRecord, context: RedactionContext) => RedactedValue<TRecord>,
): RowRedactionResult<TRecord> => {
  return records.reduce<RowRedactionResult<TRecord>>(
    (result, record, index) => {
      const jsonPointer = `/${index}`
      const sourceRef = getRecordSourceRef(record)
      const redacted = redactRecord(record, {jsonPointer, payloadKey, sourceRef})

      return {
        omittedSourceIds: result.omittedSourceIds,
        records: [...result.records, redacted.value],
        warnings: [...result.warnings, ...redacted.warnings],
      }
    },
    {omittedSourceIds: [], records: [], warnings: []},
  )
}

const redactImportRoutes = (
  importRoutes: ProjectTransferPayloadByKey['importRoutes'],
): RedactedValue<ProjectTransferPayloadByKey['importRoutes']> => {
  const records = redactRecordSet('importRoutes', importRoutes.records, (record, context) => {
    return applyFieldRedactions(record, [
      (recordValue) => {
        return redactStringField(recordValue, 'description', context)
      },
      (recordValue) => {
        return redactStringField(recordValue, 'name', context)
      },
      (recordValue) => {
        return redactStringField(recordValue, 'route', context, true)
      },
    ])
  })

  return {
    changed: records.warnings.length > 0,
    value: getCollectionWithRecords(importRoutes, records.records),
    warnings: records.warnings,
  }
}

const redactArticleImportRoutes = (
  articleImportRoutes: ProjectTransferPayloadByKey['articleImportRoutes'],
): RowRedactionResult<ProjectTransferPayloadByKey['articleImportRoutes'][number]> => {
  return redactRecordSet('articleImportRoutes', articleImportRoutes, (record, context) => {
    return applyFieldRedactions(record, [
      (recordValue) => {
        return redactJsonField(recordValue, 'importMetadata', context)
      },
      (recordValue) => {
        return redactJsonField(recordValue, 'matchMetadata', context)
      },
      (recordValue) => {
        return redactJsonField(recordValue, 'rawPayload', context)
      },
      (recordValue) => {
        return redactStringField(recordValue, 'externalArticleId', context)
      },
      (recordValue) => {
        return redactStringField(recordValue, 'sourceKind', context)
      },
      (recordValue) => {
        return redactStringField(recordValue, 'sourceRecordKey', context, true)
      },
    ])
  })
}

const redactJudgments = (
  judgments: ProjectTransferPayloadByKey['judgments'],
): RowRedactionResult<ProjectTransferPayloadByKey['judgments'][number]> => {
  return judgments.reduce<RowRedactionResult<ProjectTransferPayloadByKey['judgments'][number]>>(
    (result, record, index) => {
      const jsonPointer = `/${index}`
      const sourceRef = getRecordSourceRef(record)
      const unsafeField = getUnsafeField(record, judgmentDecisionFields)

      const redacted = applyFieldRedactions(record, [
        (recordValue) => {
          return redactStringField(recordValue, 'snapshotProjectModelName', {
            jsonPointer,
            payloadKey: 'judgments',
            sourceRef,
          })
        },
      ])

      return unsafeField
        ? {
            omittedSourceIds: [...result.omittedSourceIds, record.sourceJudgmentId],
            records: result.records,
            warnings: [
              ...result.warnings,
              omitRecordWarning({
                code: 'decisionPayloadRowOmitted',
                jsonPointer: childPointer(jsonPointer, unsafeField),
                message: 'Judgment row was omitted because an LLM decision field would require redaction.',
                payloadKey: 'judgments',
                sourceRef,
              }),
            ],
          }
        : {
            omittedSourceIds: result.omittedSourceIds,
            records: [...result.records, redacted.value],
            warnings: [...result.warnings, ...redacted.warnings],
          }
    },
    {omittedSourceIds: [], records: [], warnings: []},
  )
}

const redactJudgmentAssessments = (
  assessments: ProjectTransferPayloadByKey['judgmentAssessments'],
): RowRedactionResult<ProjectTransferPayloadByKey['judgmentAssessments'][number]> => {
  return redactRecordSet('judgmentAssessments', assessments, (record, context) => {
    return applyFieldRedactions(record, [
      (recordValue) => {
        return redactStringField(recordValue, 'assessmentComment', context)
      },
    ])
  })
}

const redactHumanJudgments = (
  judgments: ProjectTransferPayloadByKey['humanJudgments'],
): RowRedactionResult<ProjectTransferPayloadByKey['humanJudgments'][number]> => {
  return judgments.reduce<RowRedactionResult<ProjectTransferPayloadByKey['humanJudgments'][number]>>(
    (result, record, index) => {
      const jsonPointer = `/${index}`
      const sourceRef = getRecordSourceRef(record)
      const redacted = applyFieldRedactions(record, [
        (recordValue) => {
          return redactStringField(recordValue, 'comment', {jsonPointer, payloadKey: 'humanJudgments', sourceRef})
        },
      ])

      return hasUnsafeRedactableValue(record.answer)
        ? {
            omittedSourceIds: [...result.omittedSourceIds, record.sourceHumanJudgmentId],
            records: result.records,
            warnings: [
              ...result.warnings,
              omitRecordWarning({
                code: 'decisionPayloadRowOmitted',
                jsonPointer: childPointer(jsonPointer, 'answer'),
                message: 'Human judgment row was omitted because the answer would require redaction.',
                payloadKey: 'humanJudgments',
                sourceRef,
              }),
            ],
          }
        : {
            omittedSourceIds: result.omittedSourceIds,
            records: [...result.records, redacted.value],
            warnings: [...result.warnings, ...redacted.warnings],
          }
    },
    {omittedSourceIds: [], records: [], warnings: []},
  )
}

const redactHumanJudgmentSummaries = (
  summaries: ProjectTransferPayloadByKey['humanJudgmentSummaries'],
): RowRedactionResult<ProjectTransferPayloadByKey['humanJudgmentSummaries'][number]> => {
  return summaries.reduce<RowRedactionResult<ProjectTransferPayloadByKey['humanJudgmentSummaries'][number]>>(
    (result, record, index) => {
      const jsonPointer = `/${index}`
      const sourceRef = getRecordSourceRef(record)

      return hasUnsafeRedactableValue(record.answer)
        ? {
            omittedSourceIds: [...result.omittedSourceIds, record.sourceHumanJudgmentSummaryId],
            records: result.records,
            warnings: [
              ...result.warnings,
              omitRecordWarning({
                code: 'decisionPayloadRowOmitted',
                jsonPointer: childPointer(jsonPointer, 'answer'),
                message: 'Human judgment summary row was omitted because the answer would require redaction.',
                payloadKey: 'humanJudgmentSummaries',
                sourceRef,
              }),
            ],
          }
        : {omittedSourceIds: result.omittedSourceIds, records: [...result.records, record], warnings: result.warnings}
    },
    {omittedSourceIds: [], records: [], warnings: []},
  )
}

const redactReviews = (
  reviews: ProjectTransferPayloadByKey['reviews'],
): RowRedactionResult<ProjectTransferPayloadByKey['reviews'][number]> => {
  return redactRecordSet('reviews', reviews, (record, context) => {
    const sections = isRecord(record.sections)
      ? Object.entries(record.sections).reduce<JsonRecord>((sectionRecords, [section, value]) => {
          const sectionRecord = isRecord(value) ? value : {}
          const redactedComment = redactStringField(sectionRecord, 'comment', {
            ...context,
            jsonPointer: childPointer(childPointer(context.jsonPointer, 'sections'), section),
          })

          return {...sectionRecords, [section]: redactedComment.value}
        }, {})
      : record.sections
    const warningResults = isRecord(record.sections)
      ? Object.entries(record.sections).flatMap(([section, value]) => {
          return isRecord(value)
            ? redactStringField(value, 'comment', {
                ...context,
                jsonPointer: childPointer(childPointer(context.jsonPointer, 'sections'), section),
              }).warnings
            : []
        })
      : []

    return warningResults.length === 0
      ? {changed: false, value: record, warnings: []}
      : {changed: true, value: {...record, sections}, warnings: warningResults}
  })
}

const ensureProviderSecretWarning = (
  record: ProjectTransferPayloadByKey['providerConnections']['records'][number],
  context: RedactionContext,
) => {
  const warnings = Array.isArray(record.warnings) ? record.warnings : []
  const hasWarning = warnings.some((warning) => {
    return isRecord(warning) && warning.code === 'providerSecretRedacted' && warning.jsonPointer === '/secretRef'
  })
  const warning = getWarning({
    action: 'redacted',
    code: 'providerSecretRedacted',
    jsonPointer: '/secretRef',
    message: 'Provider authentication secret reference was redacted from the package payload.',
    payloadKey: 'providerConnections',
    severity: 'warning',
    sourceRef: context.sourceRef,
  })

  return hasWarning ? record : {...record, warnings: [...warnings, warning]}
}

const redactProviderConnections = (
  providerConnections: ProjectTransferPayloadByKey['providerConnections'],
): RedactedValue<ProjectTransferPayloadByKey['providerConnections']> => {
  const result = redactRecordSet('providerConnections', providerConnections.records, (record, context) => {
    const withSecretWarning = ensureProviderSecretWarning({...record, secretRef: null}, context)

    return applyFieldRedactions(withSecretWarning, [
      (recordValue) => {
        return redactStringField(recordValue, 'baseURL', context)
      },
      (recordValue) => {
        return redactJsonField(recordValue, 'configJson', context)
      },
      (recordValue) => {
        return redactStringField(recordValue, 'lastError', context)
      },
      (recordValue) => {
        return redactJsonField(recordValue, 'signature', context)
      },
    ])
  })

  return {
    changed: result.warnings.length > 0,
    value: getCollectionWithRecords(providerConnections, result.records),
    warnings: result.warnings,
  }
}

const redactModels = (
  models: ProjectTransferPayloadByKey['models'],
): RedactedValue<ProjectTransferPayloadByKey['models']> => {
  const result = redactRecordSet('models', models.records, (record, context) => {
    return applyFieldRedactions(record, [
      (recordValue) => {
        return redactStringField(recordValue, 'displayName', context, true)
      },
      (recordValue) => {
        return redactStringField(recordValue, 'modelName', context, true)
      },
      (recordValue) => {
        return redactStringField(recordValue, 'name', context, true)
      },
      (recordValue) => {
        return redactStringField(recordValue, 'remoteModelId', context)
      },
      (recordValue) => {
        return redactStringField(recordValue, 'source', context)
      },
      (recordValue) => {
        return redactJsonField(recordValue, 'metadataJson', context)
      },
      (recordValue) => {
        return redactJsonField(recordValue, 'signature', context)
      },
    ])
  })

  return {
    changed: result.warnings.length > 0,
    value: getCollectionWithRecords(models, result.records),
    warnings: result.warnings,
  }
}

const omitDependentRecords = <TRecord extends ProjectTransferPayloadRecord>({
  getDependencyId,
  omittedIds,
  payloadKey,
  reason,
  records,
}: {
  getDependencyId: (record: TRecord) => string | null
  omittedIds: Set<string>
  payloadKey: ProjectTransferPayloadKey
  reason: string
  records: TRecord[]
}): RowRedactionResult<TRecord> => {
  return records.reduce<RowRedactionResult<TRecord>>(
    (result, record, index) => {
      const dependencyId = getDependencyId(record)

      return dependencyId && omittedIds.has(dependencyId)
        ? {
            omittedSourceIds: result.omittedSourceIds,
            records: result.records,
            warnings: [
              ...result.warnings,
              omitDependentRecordWarning({
                jsonPointer: `/${index}`,
                payloadKey,
                reason,
                sourceRef: getRecordSourceRef(record),
              }),
            ],
          }
        : {...result, records: [...result.records, record]}
    },
    {omittedSourceIds: [], records: [], warnings: []},
  )
}

const filterCollectionDependencies = <TRecord extends ProjectTransferPayloadRecord>(
  collection: ProjectTransferPayloadCollection<TRecord>,
  dependencyResult: RowRedactionResult<TRecord>,
) => {
  return getCollectionWithRecords(collection, dependencyResult.records)
}

const getOmittedJudgmentIds = (
  originalRows: ProjectTransferPayloadByKey['judgments'],
  exportedRows: ProjectTransferPayloadByKey['judgments'],
) => {
  const exportedJudgmentIdSet = new Set(
    exportedRows.map((row) => {
      return row.sourceJudgmentId
    }),
  )

  return originalRows
    .filter((row) => {
      return !exportedJudgmentIdSet.has(row.sourceJudgmentId)
    })
    .map((row) => {
      return row.sourceJudgmentId
    })
}

const assertRedactedPayloads = (payloads: ProjectTransferPayloadByKey) => {
  return {
    articleImportRoutes: assertProjectTransferPayload('articleImportRoutes', payloads.articleImportRoutes),
    articles: assertProjectTransferPayload('articles', payloads.articles),
    assetManifest: assertProjectTransferPayload('assetManifest', payloads.assetManifest),
    humanJudgmentSummaries: assertProjectTransferPayload('humanJudgmentSummaries', payloads.humanJudgmentSummaries),
    humanJudgments: assertProjectTransferPayload('humanJudgments', payloads.humanJudgments),
    importRoutes: assertProjectTransferPayload('importRoutes', payloads.importRoutes),
    judgmentAssessments: assertProjectTransferPayload('judgmentAssessments', payloads.judgmentAssessments),
    judgments: assertProjectTransferPayload('judgments', payloads.judgments),
    models: assertProjectTransferPayload('models', payloads.models),
    project: assertProjectTransferPayload('project', payloads.project),
    projectArticles: assertProjectTransferPayload('projectArticles', payloads.projectArticles),
    projectImportRoutes: assertProjectTransferPayload('projectImportRoutes', payloads.projectImportRoutes),
    projectPrompts: assertProjectTransferPayload('projectPrompts', payloads.projectPrompts),
    prompts: assertProjectTransferPayload('prompts', payloads.prompts),
    providerConnections: assertProjectTransferPayload('providerConnections', payloads.providerConnections),
    reviews: assertProjectTransferPayload('reviews', payloads.reviews),
  } satisfies ProjectTransferPayloadByKey
}

export const redactProjectTransferPayloads = (
  payloads: ProjectTransferPayloadByKey,
): ProjectTransferRedactionOutput => {
  const project = redactProjectRecord(payloads.project)
  const promptResult = redactPromptRecords(payloads.prompts)
  const articleResult = redactArticleRecords(payloads.articles, project.value)
  const omittedPromptIds = new Set(promptResult.omittedSourceIds)
  const omittedArticleIds = new Set(articleResult.omittedSourceIds)
  const projectPromptDependencies = omitDependentRecords({
    getDependencyId: (record) => {
      return record.sourcePromptId
    },
    omittedIds: omittedPromptIds,
    payloadKey: 'projectPrompts',
    reason: 'sourcePrompt',
    records: payloads.projectPrompts.records,
  })
  const articleImportRouteDependencies = omitDependentRecords({
    getDependencyId: (record) => {
      return record.sourceArticleId
    },
    omittedIds: omittedArticleIds,
    payloadKey: 'articleImportRoutes',
    reason: 'sourceArticle',
    records: payloads.articleImportRoutes,
  })
  const projectArticleDependencies = omitDependentRecords({
    getDependencyId: (record) => {
      return record.sourceArticleId
    },
    omittedIds: omittedArticleIds,
    payloadKey: 'projectArticles',
    reason: 'sourceArticle',
    records: payloads.projectArticles,
  })
  const humanJudgmentArticleDependencies = omitDependentRecords({
    getDependencyId: (record) => {
      return omittedArticleIds.has(record.sourceArticleId) ? record.sourceArticleId : record.sourcePromptId
    },
    omittedIds: new Set([...omittedArticleIds, ...omittedPromptIds]),
    payloadKey: 'humanJudgments',
    reason: 'sourceArticleOrPrompt',
    records: payloads.humanJudgments,
  })
  const humanSummaryArticleDependencies = omitDependentRecords({
    getDependencyId: (record) => {
      return record.sourceArticleId
    },
    omittedIds: omittedArticleIds,
    payloadKey: 'humanJudgmentSummaries',
    reason: 'sourceArticle',
    records: payloads.humanJudgmentSummaries,
  })
  const reviewArticleDependencies = omitDependentRecords({
    getDependencyId: (record) => {
      return record.sourceArticleId
    },
    omittedIds: omittedArticleIds,
    payloadKey: 'reviews',
    reason: 'sourceArticle',
    records: payloads.reviews,
  })
  const judgmentArticlePromptDependencies = omitDependentRecords({
    getDependencyId: (record) => {
      return omittedArticleIds.has(record.sourceArticleId) ? record.sourceArticleId : record.sourcePromptId
    },
    omittedIds: new Set([...omittedArticleIds, ...omittedPromptIds]),
    payloadKey: 'judgments',
    reason: 'sourceArticleOrPrompt',
    records: payloads.judgments,
  })
  const importRoutes = redactImportRoutes(payloads.importRoutes)
  const articleImportRoutes = redactArticleImportRoutes(articleImportRouteDependencies.records)
  const judgments = redactJudgments(judgmentArticlePromptDependencies.records)
  const omittedJudgmentIds = new Set([
    ...getOmittedJudgmentIds(payloads.judgments, judgmentArticlePromptDependencies.records),
    ...judgments.omittedSourceIds,
  ])
  const assessmentJudgmentDependencies = omitDependentRecords({
    getDependencyId: (record) => {
      return record.sourceJudgmentId
    },
    omittedIds: omittedJudgmentIds,
    payloadKey: 'judgmentAssessments',
    reason: 'sourceJudgment',
    records: payloads.judgmentAssessments,
  })
  const judgmentAssessments = redactJudgmentAssessments(assessmentJudgmentDependencies.records)
  const humanJudgments = redactHumanJudgments(humanJudgmentArticleDependencies.records)
  const humanJudgmentSummaries = redactHumanJudgmentSummaries(humanSummaryArticleDependencies.records)
  const reviews = redactReviews(reviewArticleDependencies.records)
  const providerConnections = redactProviderConnections(payloads.providerConnections)
  const models = redactModels(payloads.models)
  const redactedPayloads = assertRedactedPayloads({
    ...payloads,
    articleImportRoutes: articleImportRoutes.records,
    articles: articleResult.records,
    humanJudgmentSummaries: humanJudgmentSummaries.records,
    humanJudgments: humanJudgments.records,
    importRoutes: importRoutes.value,
    judgmentAssessments: judgmentAssessments.records,
    judgments: judgments.records,
    models: models.value,
    project: project.value,
    projectArticles: projectArticleDependencies.records,
    projectImportRoutes: filterCollectionDependencies(payloads.projectImportRoutes, {
      omittedSourceIds: [],
      records: payloads.projectImportRoutes.records,
      warnings: [],
    }),
    projectPrompts: filterCollectionDependencies(payloads.projectPrompts, projectPromptDependencies),
    prompts: getCollectionWithRecords(payloads.prompts, promptResult.records),
    providerConnections: providerConnections.value,
    reviews: reviews.records,
  })

  return {
    payloads: redactedPayloads,
    warnings: [
      ...project.warnings,
      ...promptResult.warnings,
      ...articleResult.warnings,
      ...projectPromptDependencies.warnings,
      ...articleImportRouteDependencies.warnings,
      ...projectArticleDependencies.warnings,
      ...humanJudgmentArticleDependencies.warnings,
      ...humanSummaryArticleDependencies.warnings,
      ...reviewArticleDependencies.warnings,
      ...judgmentArticlePromptDependencies.warnings,
      ...importRoutes.warnings,
      ...articleImportRoutes.warnings,
      ...judgments.warnings,
      ...assessmentJudgmentDependencies.warnings,
      ...judgmentAssessments.warnings,
      ...humanJudgments.warnings,
      ...humanJudgmentSummaries.warnings,
      ...reviews.warnings,
      ...providerConnections.warnings,
      ...models.warnings,
    ],
  }
}
