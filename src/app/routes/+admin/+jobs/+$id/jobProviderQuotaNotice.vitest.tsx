// @vitest-environment happy-dom

import {formatDate} from 'date-fns'
import {render} from 'solid-js/web'
import {afterEach, beforeEach, describe, expect, test} from 'vitest'

import {
  formatProviderQuotaHeadline,
  type JobProviderQuota,
  type JobProviderQuotaHeadline,
  JobProviderQuotaNotice,
} from './jobProviderQuotaNotice.tsx'

const resetsAt = '2026-11-13T20:00:00.000Z'
const observedAt = '2026-11-06T12:34:00.000Z'

const formatExpectedTime = (value: string): string => {
  return formatDate(new Date(value), 'EEE d MMM HH:mm')
}

const buildHeadline = (overrides: Partial<JobProviderQuotaHeadline> = {}): JobProviderQuotaHeadline => {
  return {
    label: 'Claude Max weekly',
    limitKind: 'seven_day',
    observedAt,
    resetsAt,
    utilizationPercent: 34,
    ...overrides,
  }
}

const buildQuota = (headlines: JobProviderQuotaHeadline[]): JobProviderQuota => {
  return {headlines, providerConnectionId: 'connection-claude', providerKind: 'claude-code'}
}

const cleanups: Array<() => void> = []

const renderNotice = (quota: JobProviderQuota | null | undefined): HTMLDivElement => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  cleanups.push(
    render(() => {
      return <JobProviderQuotaNotice quota={quota} />
    }, container),
  )

  return container
}

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  cleanups.splice(0).map((dispose) => {
    return dispose()
  })
})

describe('formatProviderQuotaHeadline', () => {
  test('formats label, percent and reset time', () => {
    expect(formatProviderQuotaHeadline(buildHeadline())).toBe(
      `Claude Max weekly 34 %, resets ${formatExpectedTime(resetsAt)}`,
    )
  })

  test('rounds the percent to one decimal', () => {
    expect(formatProviderQuotaHeadline(buildHeadline({utilizationPercent: 12.345}))).toBe(
      `Claude Max weekly 12.3 %, resets ${formatExpectedTime(resetsAt)}`,
    )
  })

  test('omits the reset time when resetsAt is null', () => {
    expect(formatProviderQuotaHeadline(buildHeadline({resetsAt: null}))).toBe('Claude Max weekly 34 %')
  })
})

describe('JobProviderQuotaNotice', () => {
  test('renders each headline with its read time', () => {
    const container = renderNotice(
      buildQuota([
        buildHeadline(),
        buildHeadline({label: 'Claude Max session', resetsAt: null, utilizationPercent: 12.345}),
      ]),
    )
    const items = Array.from(container.querySelectorAll('[data-testid="job-provider-quota"] li')).map((item) => {
      return item.textContent
    })

    expect(items).toEqual([
      `Claude Max weekly 34 %, resets ${formatExpectedTime(resetsAt)}read ${formatExpectedTime(observedAt)}`,
      `Claude Max session 12.3 %read ${formatExpectedTime(observedAt)}`,
    ])
  })

  test('shows the empty message when the quota has no headlines', () => {
    const container = renderNotice(buildQuota([]))
    const notice = container.querySelector('[data-testid="job-provider-quota"]')

    expect(notice?.textContent).toBe('No subscription quota reading in the last 24 hours.')
    expect(notice?.querySelector('li')).toBeNull()
  })

  test('renders nothing for a null quota', () => {
    const container = renderNotice(null)

    expect(container.querySelector('[data-testid="job-provider-quota"]')).toBeNull()
    expect(container.textContent).toBe('')
  })

  test('renders nothing for an undefined quota', () => {
    const container = renderNotice(undefined)

    expect(container.querySelector('[data-testid="job-provider-quota"]')).toBeNull()
    expect(container.textContent).toBe('')
  })
})
