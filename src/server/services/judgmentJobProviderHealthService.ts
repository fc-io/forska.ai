import {getAppDatabaseService} from './appDatabaseService.ts'
import {getDateValue, getQuotedStringList, getSqlLiteral, getTimestampLiteral} from './appQueryHelpers.ts'

export type JudgmentJobProviderFailureKind =
  | 'auth'
  | 'endpoint_unavailable'
  | 'network'
  | 'other'
  | 'rate_limited'
  | 'timeout'
  | 'usage_limit'

export type JudgmentJobProviderHealthStatus = 'failing' | 'recovered'

export type JudgmentJobProviderHealth = {
  consecutiveFailureCount: number
  failureCode: string | null
  failureKind: JudgmentJobProviderFailureKind
  failureMessage: string | null
  firstFailedAt: Date
  jobId: string
  lastFailedAt: Date
  lastSuccessAt: Date | null
  modelId: string | null
  recoveredAt: Date | null
  retryAfterAt: Date | null
  status: JudgmentJobProviderHealthStatus
  totalFailureCount: number
  updatedAt: Date
}

export type JudgmentJobProviderHealthApi = Omit<
  JudgmentJobProviderHealth,
  'firstFailedAt' | 'lastFailedAt' | 'lastSuccessAt' | 'recoveredAt' | 'retryAfterAt' | 'updatedAt'
> & {
  firstFailedAt: string
  isActive: boolean
  lastFailedAt: string
  lastSuccessAt: string | null
  recoveredAt: string | null
  retryAfterAt: string | null
  updatedAt: string
}

export type JudgmentJobProviderHealthReadDatabase = {queryJson: <T>(statement: string) => Promise<T[]>}

type JudgmentJobProviderHealthRow = {
  consecutiveFailureCount: number | null
  failureCode: string | null
  failureKind: string
  failureMessage: string | null
  firstFailedAt: unknown
  jobId: string
  lastFailedAt: unknown
  lastSuccessAt: unknown
  modelId: string | null
  recoveredAt: unknown
  retryAfterAt: unknown
  status: string
  totalFailureCount: number | null
  updatedAt: unknown
}

type ProviderFailureClassificationInput = {
  connectionFailureKind?: string | null
  failureCode?: string | null
  message?: string | null
  statusCode?: number | null
}

type ProviderFailureClassificationRule = {
  kind: JudgmentJobProviderFailureKind
  matches: (input: {connectionFailureKind: string | null; statusCode: number | null; text: string}) => boolean
}

type ProviderRetryAfterParser = (message: string, now: Date) => Date | null

type FailingJobCacheEntry = Pick<
  JudgmentJobProviderHealth,
  'consecutiveFailureCount' | 'failureKind' | 'lastFailedAt' | 'retryAfterAt' | 'status'
> & {probeClaimedAt: Date | null}

type JudgmentJobProviderClaimGate = {backoffUntil: Date | null; claimsAllowed: boolean; maxClaims: number | null}

const providerHealthTableName = 'app.judgment_job_provider_health'
const providerFailureMessageMaxLength = 1000
const providerFailureCodeMaxLength = 200
const providerRetryAfterPastGraceMs = 60 * 60 * 1000
const secondMs = 1000
const minuteMs = 60 * secondMs
const hourMs = 60 * minuteMs
const dayMs = 24 * hourMs
const usageLimitMinDelayMs = minuteMs
const usageLimitMaxDelayMs = 30 * minuteMs
const usageLimitDefaultDelayMs = 5 * minuteMs
const rateLimitedDelayMs = minuteMs
const authDelayMs = 5 * minuteMs
const transportBackoffBaseMs = 30 * secondMs
const transportBackoffMaxExponent = 5
const transportBackoffMaxMs = 5 * minuteMs
const otherBackoffFirstFailureCount = 3
const otherBackoffBaseMs = 15 * secondMs
const otherBackoffMaxMs = 5 * minuteMs
const providerProbeOutstandingMaxAgeMs = 15 * minuteMs

const providerFailureKinds = new Set<JudgmentJobProviderFailureKind>([
  'auth',
  'endpoint_unavailable',
  'network',
  'other',
  'rate_limited',
  'timeout',
  'usage_limit',
])

const usageLimitPattern = /usage limit|quota|insufficient[_ ]credits|purchase more credits|out of credits|billing/i
const rateLimitedPattern = /rate limit|too many requests/i
const authPattern = /unauthori[sz]ed|forbidden|invalid api key|authentication/i
const timeoutPattern = /timed out|timeout/i
const networkPattern = /econnrefused|econnreset|fetch failed|network/i
const messageStatusCodePatterns = [
  /\bHTTP(?:\s+error)?\s*:?\s*(?<status>\d{3})\b/i,
  /\bfailed\s*\((?<status>\d{3})\)/i,
  /\bstatus(?:\s+code)?\s*[:=]?\s*(?<status>\d{3})\b/i,
  /^\s*(?<status>\d{3})\s+(?:status code\b|[a-z])/i,
]

const monthIndexByPrefix: Record<string, number> = {
  apr: 3,
  aug: 7,
  dec: 11,
  feb: 1,
  jan: 0,
  jul: 6,
  jun: 5,
  mar: 2,
  may: 4,
  nov: 10,
  oct: 9,
  sep: 8,
}

const retryAfterLeadInSource = String.raw`\b(?:try again|retry|resets?|available again)\s+(?:at|after|on)\s+(?:about\s+|around\s+)?`
const clockTimeSource = String.raw`(?<hour>\d{1,2}):(?<minute>\d{2})(?::(?<second>\d{2}))?(?:\s*(?<meridiem>[ap])\.?\s?m\b\.?)?`
const monthNameSource = String.raw`(?<month>jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`
const calendarRetryAfterPattern = new RegExp(
  String.raw`${retryAfterLeadInSource}${monthNameSource}\.?\s+(?<day>\d{1,2})(?:st|nd|rd|th)?\b,?(?:\s+(?<year>\d{4})\b)?,?\s+(?:at\s+)?${clockTimeSource}`,
  'i',
)
const clockRetryAfterPattern = new RegExp(String.raw`${retryAfterLeadInSource}${clockTimeSource}`, 'i')
const isoRetryAfterPattern = new RegExp(
  String.raw`${retryAfterLeadInSource}(?<iso>\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)`,
  'i',
)
const durationUnitSource = String.raw`(?:milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)`
const durationPartSource = String.raw`\d+(?:\.\d+)?\s*${durationUnitSource}\b`
const relativeRetryAfterPattern = new RegExp(
  String.raw`\b(?:try again|retry|retrying)\s+(?:in|after)\s+(?:about\s+|approximately\s+|~\s*)?(?<duration>${durationPartSource}(?:[\s,]*(?:and\s+)?${durationPartSource})*)`,
  'i',
)
const durationPartPattern = new RegExp(String.raw`(?<amount>\d+(?:\.\d+)?)\s*(?<unit>${durationUnitSource})\b`, 'gi')
const retryAfterMsHeaderPattern = /\bretry[-_]after[-_]ms\s*[:=]\s*"?(?<amount>\d+(?:\.\d+)?)/i
const retryAfterSecondsHeaderPattern = /\bretry[-_ ]after\s*[:=]\s*"?(?<amount>\d+(?:\.\d+)?)\b/i
const retryAfterHttpDateHeaderPattern =
  /\bretry[-_ ]after\s*[:=]\s*"?(?<httpDate>[a-z]{3},\s+\d{1,2}\s+[a-z]{3}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT)/i

const failingJobs = new Map<string, FailingJobCacheEntry>()
const failingJobsCacheState: {
  loadPromise: Promise<void> | null
  loaded: boolean
  touchedJobIdsDuringLoad: Set<string> | null
} = {loadPromise: null, loaded: false, touchedJobIdsDuringLoad: null}
const openClaimGate: JudgmentJobProviderClaimGate = {backoffUntil: null, claimsAllowed: true, maxClaims: null}

const getNonEmptyText = (value: string | null | undefined) => {
  const text = typeof value === 'string' ? value.trim() : ''

  return text.length > 0 ? text : null
}

const getFiniteNumberOrNull = (value: number | null | undefined) => {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const providerFailureClassificationRules: ProviderFailureClassificationRule[] = [
  {
    kind: 'usage_limit',
    matches: ({text}) => {
      return usageLimitPattern.test(text)
    },
  },
  {
    kind: 'rate_limited',
    matches: ({connectionFailureKind, statusCode, text}) => {
      return statusCode === 429 || connectionFailureKind === 'rate_limited' || rateLimitedPattern.test(text)
    },
  },
  {
    kind: 'auth',
    matches: ({statusCode, text}) => {
      return statusCode === 401 || statusCode === 403 || authPattern.test(text)
    },
  },
  {
    kind: 'endpoint_unavailable',
    matches: ({connectionFailureKind, statusCode}) => {
      return (
        connectionFailureKind === 'endpoint_unavailable'
        || connectionFailureKind === 'endpoint_misconfigured'
        || statusCode === 404
        || (statusCode !== null && statusCode >= 500 && statusCode <= 599)
      )
    },
  },
  {
    kind: 'timeout',
    matches: ({text}) => {
      return timeoutPattern.test(text)
    },
  },
  {
    kind: 'network',
    matches: ({connectionFailureKind, text}) => {
      return connectionFailureKind === 'network_unavailable' || networkPattern.test(text)
    },
  },
]

const getMessageStatusCode = (message: string | null | undefined) => {
  const statusCode = messageStatusCodePatterns.reduce<number | null>((foundStatusCode, pattern) => {
    return foundStatusCode ?? getFiniteNumberOrNull(Number(pattern.exec(message ?? '')?.groups?.status))
  }, null)

  return statusCode !== null && statusCode >= 400 && statusCode <= 599 ? statusCode : null
}

export const classifyJudgmentJobProviderFailure = (
  input: ProviderFailureClassificationInput,
): JudgmentJobProviderFailureKind => {
  const ruleInput = {
    connectionFailureKind: getNonEmptyText(input.connectionFailureKind),
    statusCode: getFiniteNumberOrNull(input.statusCode) ?? getMessageStatusCode(input.message),
    text: [input.message, input.failureCode]
      .filter((part): part is string => {
        return typeof part === 'string'
      })
      .join(' '),
  }
  const matchingRule = providerFailureClassificationRules.find((rule) => {
    return rule.matches(ruleInput)
  })

  return matchingRule?.kind ?? 'other'
}

const getValidDateOrNull = (date: Date) => {
  return Number.isNaN(date.getTime()) ? null : date
}

const getMeridiemHour24 = ({hour, meridiem}: {hour: number; meridiem: string}) => {
  return hour >= 1 && hour <= 12 ? (hour % 12) + (meridiem === 'p' ? 12 : 0) : null
}

const getHour24 = ({hour, meridiem}: {hour: number; meridiem: string | undefined}) => {
  return meridiem === undefined
    ? hour >= 0 && hour <= 23
      ? hour
      : null
    : getMeridiemHour24({hour, meridiem: meridiem.toLowerCase()})
}

const getClockTime = (groups: Record<string, string | undefined>) => {
  const hour = getHour24({hour: Number(groups.hour), meridiem: groups.meridiem})
  const minute = Number(groups.minute)
  const second = groups.second === undefined ? 0 : Number(groups.second)

  return hour !== null && minute >= 0 && minute <= 59 && second >= 0 && second <= 59 ? {hour, minute, second} : null
}

const getExactLocalDate = (input: {
  day: number
  hour: number
  minute: number
  monthIndex: number
  second: number
  year: number
}) => {
  const date = new Date(input.year, input.monthIndex, input.day, input.hour, input.minute, input.second, 0)

  return date.getFullYear() === input.year && date.getMonth() === input.monthIndex && date.getDate() === input.day
    ? date
    : null
}

const isBeforeRetryAfterGrace = (date: Date | null, now: Date) => {
  return date === null || date.getTime() < now.getTime() - providerRetryAfterPastGraceMs
}

const getNextLocalCalendarOccurrence = (input: {
  day: number
  hour: number
  minute: number
  monthIndex: number
  now: Date
  second: number
}) => {
  const currentYearDate = getExactLocalDate({...input, year: input.now.getFullYear()})

  return isBeforeRetryAfterGrace(currentYearDate, input.now)
    ? getExactLocalDate({...input, year: input.now.getFullYear() + 1})
    : currentYearDate
}

const parseCalendarRetryAfterAt: ProviderRetryAfterParser = (message, now) => {
  const groups = calendarRetryAfterPattern.exec(message)?.groups
  const clockTime = groups ? getClockTime(groups) : null
  const monthIndex = groups?.month ? monthIndexByPrefix[groups.month.slice(0, 3).toLowerCase()] : undefined
  const day = Number(groups?.day)
  const dateInput = clockTime && monthIndex !== undefined ? {...clockTime, day, monthIndex} : null

  return dateInput === null
    ? null
    : groups?.year
      ? getExactLocalDate({...dateInput, year: Number(groups.year)})
      : getNextLocalCalendarOccurrence({...dateInput, now})
}

const parseClockRetryAfterAt: ProviderRetryAfterParser = (message, now) => {
  const groups = clockRetryAfterPattern.exec(message)?.groups
  const clockTime = groups ? getClockTime(groups) : null
  const todayDate = clockTime
    ? new Date(now.getFullYear(), now.getMonth(), now.getDate(), clockTime.hour, clockTime.minute, clockTime.second, 0)
    : null

  return todayDate !== null && isBeforeRetryAfterGrace(todayDate, now)
    ? new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
        todayDate.getHours(),
        todayDate.getMinutes(),
        todayDate.getSeconds(),
        0,
      )
    : todayDate
}

const parseIsoRetryAfterAt: ProviderRetryAfterParser = (message) => {
  const iso = isoRetryAfterPattern.exec(message)?.groups?.iso

  return iso ? getValidDateOrNull(new Date(iso.replace(' ', 'T'))) : null
}

const getDurationUnitMs = (unit: string) => {
  const normalizedUnit = unit.toLowerCase()

  return normalizedUnit === 'ms' || normalizedUnit.startsWith('milli')
    ? 1
    : normalizedUnit.startsWith('d')
      ? dayMs
      : normalizedUnit.startsWith('h')
        ? hourMs
        : normalizedUnit.startsWith('m')
          ? minuteMs
          : secondMs
}

const getDurationMs = (duration: string) => {
  return [...duration.matchAll(durationPartPattern)].reduce((totalMs, match) => {
    return totalMs + Number(match.groups?.amount ?? 0) * getDurationUnitMs(match.groups?.unit ?? 's')
  }, 0)
}

const getDateAfterMs = (now: Date, delayMs: number) => {
  return Number.isFinite(delayMs) && delayMs >= 0 ? getValidDateOrNull(new Date(now.getTime() + delayMs)) : null
}

const parseRelativeRetryAfterAt: ProviderRetryAfterParser = (message, now) => {
  const duration = relativeRetryAfterPattern.exec(message)?.groups?.duration

  return duration ? getDateAfterMs(now, getDurationMs(duration)) : null
}

const parseRetryAfterMsHeader: ProviderRetryAfterParser = (message, now) => {
  const amount = retryAfterMsHeaderPattern.exec(message)?.groups?.amount

  return amount ? getDateAfterMs(now, Number(amount)) : null
}

const parseRetryAfterSecondsHeader: ProviderRetryAfterParser = (message, now) => {
  const amount = retryAfterSecondsHeaderPattern.exec(message)?.groups?.amount

  return amount ? getDateAfterMs(now, Number(amount) * secondMs) : null
}

const parseRetryAfterHttpDateHeader: ProviderRetryAfterParser = (message) => {
  const httpDate = retryAfterHttpDateHeaderPattern.exec(message)?.groups?.httpDate

  return httpDate ? getValidDateOrNull(new Date(httpDate)) : null
}

const providerRetryAfterParsers: ProviderRetryAfterParser[] = [
  parseCalendarRetryAfterAt,
  parseIsoRetryAfterAt,
  parseClockRetryAfterAt,
  parseRelativeRetryAfterAt,
  parseRetryAfterMsHeader,
  parseRetryAfterSecondsHeader,
  parseRetryAfterHttpDateHeader,
]

const getFirstParsedRetryAfterAt = (message: string, now: Date) => {
  return providerRetryAfterParsers.reduce<Date | null>((parsedDate, parser) => {
    return parsedDate ?? parser(message, now)
  }, null)
}

export const parseProviderRetryAfterAt = (message: string | null | undefined, now: Date = new Date()): Date | null => {
  try {
    return typeof message === 'string' && message.length > 0 && !Number.isNaN(now.getTime())
      ? getFirstParsedRetryAfterAt(message, now)
      : null
  } catch {
    return null
  }
}

const clampNumber = (value: number, min: number, max: number) => {
  return Math.min(Math.max(value, min), max)
}

const getFailureCount = (consecutiveFailureCount: number) => {
  return Number.isFinite(consecutiveFailureCount) ? Math.max(1, Math.floor(consecutiveFailureCount)) : 1
}

const getUsageLimitRetryDelayMs = ({now, retryAfterAt}: {now: Date; retryAfterAt: Date | null}) => {
  const retryAfterMs = retryAfterAt ? retryAfterAt.getTime() - now.getTime() : Number.NaN

  return Number.isFinite(retryAfterMs)
    ? clampNumber(retryAfterMs, usageLimitMinDelayMs, usageLimitMaxDelayMs)
    : usageLimitDefaultDelayMs
}

const getTransportRetryDelayMs = (consecutiveFailureCount: number) => {
  const exponent = Math.min(getFailureCount(consecutiveFailureCount), transportBackoffMaxExponent) - 1

  return Math.min(transportBackoffBaseMs * 2 ** exponent, transportBackoffMaxMs)
}

const getOtherRetryDelayMs = (consecutiveFailureCount: number) => {
  const failureCount = getFailureCount(consecutiveFailureCount)

  return failureCount < otherBackoffFirstFailureCount
    ? null
    : Math.min(otherBackoffBaseMs * 2 ** (failureCount - otherBackoffFirstFailureCount), otherBackoffMaxMs)
}

export const getProviderFailureRetryDelayMs = (input: {
  consecutiveFailureCount: number
  failureKind: JudgmentJobProviderFailureKind
  now?: Date
  retryAfterAt: Date | null
}): number | null => {
  const delayByKind: Record<JudgmentJobProviderFailureKind, () => number | null> = {
    auth: () => {
      return authDelayMs
    },
    endpoint_unavailable: () => {
      return getTransportRetryDelayMs(input.consecutiveFailureCount)
    },
    network: () => {
      return getTransportRetryDelayMs(input.consecutiveFailureCount)
    },
    other: () => {
      return getOtherRetryDelayMs(input.consecutiveFailureCount)
    },
    rate_limited: () => {
      return rateLimitedDelayMs
    },
    timeout: () => {
      return getTransportRetryDelayMs(input.consecutiveFailureCount)
    },
    usage_limit: () => {
      return getUsageLimitRetryDelayMs({now: input.now ?? new Date(), retryAfterAt: input.retryAfterAt})
    },
  }

  return (delayByKind[input.failureKind] ?? delayByKind.other)()
}

const getProviderFailureKind = (value: string): JudgmentJobProviderFailureKind => {
  return providerFailureKinds.has(value as JudgmentJobProviderFailureKind)
    ? (value as JudgmentJobProviderFailureKind)
    : 'other'
}

const getProviderHealthStatus = (value: string): JudgmentJobProviderHealthStatus => {
  return value === 'failing' ? 'failing' : 'recovered'
}

const mapProviderHealthRow = (row: JudgmentJobProviderHealthRow): JudgmentJobProviderHealth => {
  return {
    consecutiveFailureCount: Number(row.consecutiveFailureCount ?? 0),
    failureCode: row.failureCode,
    failureKind: getProviderFailureKind(row.failureKind),
    failureMessage: row.failureMessage,
    firstFailedAt: getDateValue(row.firstFailedAt) ?? new Date(0),
    jobId: row.jobId,
    lastFailedAt: getDateValue(row.lastFailedAt) ?? new Date(0),
    lastSuccessAt: getDateValue(row.lastSuccessAt),
    modelId: row.modelId,
    recoveredAt: getDateValue(row.recoveredAt),
    retryAfterAt: getDateValue(row.retryAfterAt),
    status: getProviderHealthStatus(row.status),
    totalFailureCount: Number(row.totalFailureCount ?? 0),
    updatedAt: getDateValue(row.updatedAt) ?? new Date(0),
  }
}

const getFailingJobCacheEntry = (health: JudgmentJobProviderHealth): FailingJobCacheEntry => {
  return {
    consecutiveFailureCount: health.consecutiveFailureCount,
    failureKind: health.failureKind,
    lastFailedAt: health.lastFailedAt,
    probeClaimedAt: null,
    retryAfterAt: health.retryAfterAt,
    status: health.status,
  }
}

const setFailingJobCacheEntry = (jobId: string, entry: FailingJobCacheEntry) => {
  const existingEntry = failingJobs.get(jobId)

  return existingEntry && existingEntry.lastFailedAt.getTime() > entry.lastFailedAt.getTime()
    ? failingJobs
    : failingJobs.set(jobId, entry)
}

const getProviderHealthSelectColumnsSql = () => {
  return `
    job_id AS jobId,
    model_id AS modelId,
    status,
    failure_kind AS failureKind,
    failure_code AS failureCode,
    failure_message AS failureMessage,
    retry_after_at AS retryAfterAt,
    first_failed_at AS firstFailedAt,
    last_failed_at AS lastFailedAt,
    CAST(consecutive_failure_count AS INTEGER) AS consecutiveFailureCount,
    CAST(total_failure_count AS INTEGER) AS totalFailureCount,
    last_success_at AS lastSuccessAt,
    recovered_at AS recoveredAt,
    updated_at AS updatedAt
  `
}

const getTrimmedText = (value: string | null | undefined, maxLength: number) => {
  return getNonEmptyText(value)?.slice(0, maxLength) ?? null
}

const getRecordFailureSql = (input: {
  failureCode: string | null
  failureKind: JudgmentJobProviderFailureKind
  failureMessage: string | null
  jobId: string
  modelId: string | null
  now: Date
  retryAfterAt: Date | null
}) => {
  const nowLiteral = getTimestampLiteral(input.now)

  return `
    INSERT INTO ${providerHealthTableName} (
      job_id,
      model_id,
      status,
      failure_kind,
      failure_code,
      failure_message,
      retry_after_at,
      first_failed_at,
      last_failed_at,
      consecutive_failure_count,
      total_failure_count,
      last_success_at,
      recovered_at,
      created_at,
      updated_at
    ) VALUES (
      ${getSqlLiteral(input.jobId)},
      ${getSqlLiteral(input.modelId)},
      'failing',
      ${getSqlLiteral(input.failureKind)},
      ${getSqlLiteral(input.failureCode)},
      ${getSqlLiteral(input.failureMessage)},
      ${getSqlLiteral(input.retryAfterAt)},
      ${nowLiteral},
      ${nowLiteral},
      1,
      1,
      NULL,
      NULL,
      ${nowLiteral},
      ${nowLiteral}
    )
    ON CONFLICT (job_id) DO UPDATE SET
      model_id = COALESCE(EXCLUDED.model_id, model_id),
      status = 'failing',
      failure_kind = EXCLUDED.failure_kind,
      failure_code = EXCLUDED.failure_code,
      failure_message = EXCLUDED.failure_message,
      retry_after_at = EXCLUDED.retry_after_at,
      first_failed_at = CASE WHEN status = 'failing' THEN first_failed_at ELSE EXCLUDED.first_failed_at END,
      last_failed_at = EXCLUDED.last_failed_at,
      consecutive_failure_count = CASE WHEN status = 'failing' THEN consecutive_failure_count + 1 ELSE 1 END,
      total_failure_count = total_failure_count + 1,
      recovered_at = CASE WHEN status = 'failing' THEN recovered_at ELSE NULL END,
      updated_at = EXCLUDED.updated_at
    RETURNING ${getProviderHealthSelectColumnsSql()}
  `
}

export const recordJudgmentJobProviderFailure = async (input: {
  connectionFailureKind?: string | null
  failureCode?: string | null
  jobId: string
  message?: string | null
  modelId?: string | null
  now?: Date
  statusCode?: number | null
}): Promise<JudgmentJobProviderHealth> => {
  const now = input.now ?? new Date()
  const failureMessage = getTrimmedText(input.message, providerFailureMessageMaxLength)
  const sql = getRecordFailureSql({
    failureCode: getTrimmedText(input.failureCode, providerFailureCodeMaxLength),
    failureKind: classifyJudgmentJobProviderFailure(input),
    failureMessage,
    jobId: input.jobId,
    modelId: getNonEmptyText(input.modelId),
    now,
    retryAfterAt: parseProviderRetryAfterAt(input.message, now),
  })
  const [row] = await getAppDatabaseService().transaction((runner) => {
    return runner.queryJson<JudgmentJobProviderHealthRow>(sql)
  })

  if (!row) {
    throw new Error(`Provider health upsert returned no row for judgment job ${input.jobId}`)
  }

  const health = mapProviderHealthRow(row)

  failingJobsCacheState.touchedJobIdsDuringLoad?.add(input.jobId)
  setFailingJobCacheEntry(input.jobId, getFailingJobCacheEntry(health))

  return health
}

const loadFailingJobs = async () => {
  const touchedJobIds = new Set<string>()

  failingJobsCacheState.touchedJobIdsDuringLoad = touchedJobIds

  try {
    const rows = await getAppDatabaseService().queryJson<JudgmentJobProviderHealthRow>(`
      SELECT ${getProviderHealthSelectColumnsSql()}
      FROM ${providerHealthTableName}
      WHERE status = 'failing'
    `)

    rows
      .filter((row) => {
        return !touchedJobIds.has(row.jobId)
      })
      .map((row) => {
        return setFailingJobCacheEntry(row.jobId, getFailingJobCacheEntry(mapProviderHealthRow(row)))
      })
    failingJobsCacheState.loaded = true
  } finally {
    failingJobsCacheState.touchedJobIdsDuringLoad = null
  }
}

const ensureFailingJobsLoaded = async () => {
  if (failingJobsCacheState.loaded) {
    return
  }

  failingJobsCacheState.loadPromise ??= loadFailingJobs().finally(() => {
    failingJobsCacheState.loadPromise = null
  })

  await failingJobsCacheState.loadPromise
}

const restoreFailingJobCacheEntry = (jobId: string, entry: FailingJobCacheEntry | undefined) => {
  if (entry && !failingJobs.has(jobId)) {
    failingJobs.set(jobId, entry)
  }
}

const markJobRecovered = async ({jobId, now}: {jobId: string; now: Date}) => {
  const nowLiteral = getTimestampLiteral(now)
  const previousEntry = failingJobs.get(jobId)

  failingJobsCacheState.touchedJobIdsDuringLoad?.add(jobId)
  failingJobs.delete(jobId)

  try {
    await getAppDatabaseService().run(`
      UPDATE ${providerHealthTableName}
      SET
        status = 'recovered',
        recovered_at = ${nowLiteral},
        last_success_at = ${nowLiteral},
        consecutive_failure_count = 0,
        updated_at = ${nowLiteral}
      WHERE job_id = ${getSqlLiteral(jobId)}
        AND status = 'failing'
    `)
  } catch (error) {
    restoreFailingJobCacheEntry(jobId, previousEntry)
    throw error
  }
}

export const recordJudgmentJobProviderSuccess = async (input: {jobId: string; now?: Date}): Promise<void> => {
  await ensureFailingJobsLoaded()

  if (!failingJobs.has(input.jobId)) {
    return
  }

  await markJobRecovered({jobId: input.jobId, now: input.now ?? new Date()})
}

const getProviderHealthRows = async ({
  database,
  jobIds,
}: {
  database: JudgmentJobProviderHealthReadDatabase
  jobIds: string[]
}) => {
  return jobIds.length === 0
    ? []
    : database.queryJson<JudgmentJobProviderHealthRow>(`
        SELECT ${getProviderHealthSelectColumnsSql()}
        FROM ${providerHealthTableName}
        WHERE job_id IN (${getQuotedStringList(jobIds).join(', ')})
        ORDER BY job_id ASC
      `)
}

export const getJudgmentJobProviderHealth = async (
  jobId: string,
  options?: {database?: JudgmentJobProviderHealthReadDatabase},
): Promise<JudgmentJobProviderHealth | null> => {
  const [row] = await getProviderHealthRows({database: options?.database ?? getAppDatabaseService(), jobIds: [jobId]})

  return row ? mapProviderHealthRow(row) : null
}

export const getJudgmentJobProviderHealthMap = async (
  jobIds: string[],
  options?: {database?: JudgmentJobProviderHealthReadDatabase},
): Promise<Map<string, JudgmentJobProviderHealth>> => {
  const rows = await getProviderHealthRows({
    database: options?.database ?? getAppDatabaseService(),
    jobIds: [...new Set(jobIds)],
  })

  return rows.reduce((map, row) => {
    map.set(row.jobId, mapProviderHealthRow(row))
    return map
  }, new Map<string, JudgmentJobProviderHealth>())
}

export const isJudgmentJobProviderHealthActive = (
  row: Pick<JudgmentJobProviderHealth, 'consecutiveFailureCount' | 'failureKind' | 'status'>,
): boolean => {
  return (
    row.status === 'failing'
    && (row.failureKind !== 'other' || row.consecutiveFailureCount >= otherBackoffFirstFailureCount)
  )
}

const getIsoStringOrNull = (value: Date | null) => {
  return value ? value.toISOString() : null
}

export const toJudgmentJobProviderHealthApi = (row: JudgmentJobProviderHealth): JudgmentJobProviderHealthApi => {
  return {
    ...row,
    firstFailedAt: row.firstFailedAt.toISOString(),
    isActive: isJudgmentJobProviderHealthActive(row),
    lastFailedAt: row.lastFailedAt.toISOString(),
    lastSuccessAt: getIsoStringOrNull(row.lastSuccessAt),
    recoveredAt: getIsoStringOrNull(row.recoveredAt),
    retryAfterAt: getIsoStringOrNull(row.retryAfterAt),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export const resetJudgmentJobProviderHealthCacheForTests = (): void => {
  failingJobs.clear()
  failingJobsCacheState.loadPromise = null
  failingJobsCacheState.loaded = false
  failingJobsCacheState.touchedJobIdsDuringLoad = null
}

const isProviderProbeOutstanding = (entry: FailingJobCacheEntry, now: Date) => {
  return (
    entry.probeClaimedAt !== null
    && entry.probeClaimedAt.getTime() > entry.lastFailedAt.getTime()
    && now.getTime() - entry.probeClaimedAt.getTime() < providerProbeOutstandingMaxAgeMs
  )
}

const getActiveClaimGate = (entry: FailingJobCacheEntry, now: Date): JudgmentJobProviderClaimGate => {
  const delayMs = getProviderFailureRetryDelayMs({...entry, now: entry.lastFailedAt}) ?? 0
  const backoffUntil = new Date(entry.lastFailedAt.getTime() + delayMs)

  return now.getTime() < backoffUntil.getTime() || isProviderProbeOutstanding(entry, now)
    ? {backoffUntil, claimsAllowed: false, maxClaims: 0}
    : {backoffUntil, claimsAllowed: true, maxClaims: 1}
}

export const getJudgmentJobProviderClaimGate = async (
  jobId: string,
  now: Date = new Date(),
): Promise<{backoffUntil: Date | null; claimsAllowed: boolean; maxClaims: number | null}> => {
  await ensureFailingJobsLoaded()

  const entry = failingJobs.get(jobId)

  return entry && isJudgmentJobProviderHealthActive(entry) ? getActiveClaimGate(entry, now) : {...openClaimGate}
}

export const markJudgmentJobProviderProbeClaimed = (jobId: string, now: Date = new Date()): void => {
  const entry = failingJobs.get(jobId)

  if (entry) {
    failingJobs.set(jobId, {...entry, probeClaimedAt: now})
  }
}
