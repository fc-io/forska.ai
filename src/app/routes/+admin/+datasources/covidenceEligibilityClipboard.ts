export type CovidenceEligibilityDisposition = 'include' | 'exclude'
export type CovidenceEligibilitySectionKey =
  | 'population'
  | 'interventionExposure'
  | 'comparatorContext'
  | 'outcome'
  | 'studyCharacteristics'
  | 'other'
export type CovidenceEligibilitySectionValues = Record<
  CovidenceEligibilitySectionKey,
  Record<CovidenceEligibilityDisposition, string>
>

export const covidenceEligibilitySections: Array<{
  description: string
  key: CovidenceEligibilitySectionKey
  label: string
}> = [
  {
    description: 'Participants, disease state, demographics, setting, or eligibility population details.',
    key: 'population',
    label: 'Population',
  },
  {
    description: 'Treatments, procedures, assessments, programmes, policy, or other changes being evaluated.',
    key: 'interventionExposure',
    label: 'Intervention',
  },
  {
    description: 'Alternatives or reference points against which the intervention is evaluated.',
    key: 'comparatorContext',
    label: 'Comparison',
  },
  {
    description: 'Outcomes, endpoints, follow-up thresholds, or outcome reporting needs.',
    key: 'outcome',
    label: 'Outcome',
  },
  {
    description: 'Research design, publication window, and empirical study-type requirements.',
    key: 'studyCharacteristics',
    label: 'Study Design',
  },
  {
    description: 'Anything else the prompt should screen for that does not fit the PICOS buckets above.',
    key: 'other',
    label: 'Other',
  },
]

export const createEmptyEligibilitySectionValues = (): CovidenceEligibilitySectionValues => {
  return {
    comparatorContext: {exclude: '', include: ''},
    interventionExposure: {exclude: '', include: ''},
    other: {exclude: '', include: ''},
    outcome: {exclude: '', include: ''},
    population: {exclude: '', include: ''},
    studyCharacteristics: {exclude: '', include: ''},
  }
}

const normalizeCovidenceClipboardHeading = (value: string) => {
  return value
    .toLowerCase()
    .replace(/[:：]+$/g, '')
    .replace(/\s*\/\s*/g, ' / ')
    .replace(/\s+/g, ' ')
    .trim()
}

const covidenceEligibilityClipboardSectionAliases: Record<CovidenceEligibilitySectionKey, string[]> = {
  comparatorContext: ['Comparator / Context', 'Comparator', 'Comparators', 'Comparison', 'Context'],
  interventionExposure: [
    'Intervention / Exposure',
    'Intervention',
    'Interventions',
    'Exposure',
    'Intervention or Exposure',
  ],
  other: ['Other'],
  outcome: ['Outcome', 'Outcomes'],
  population: ['Population', 'Participants'],
  studyCharacteristics: ['Study Characteristics', 'Study Design', 'Study Type'],
}

const covidenceEligibilitySectionKeyByLabel = Object.entries(covidenceEligibilityClipboardSectionAliases).reduce(
  (lookup, [sectionKey, aliases]) => {
    aliases.forEach((alias) => {
      lookup[normalizeCovidenceClipboardHeading(alias)] = sectionKey as CovidenceEligibilitySectionKey
    })

    return lookup
  },
  {} as Record<string, CovidenceEligibilitySectionKey>,
)

const appendEligibilityClipboardLine = (currentValue: string, nextLine: string) => {
  return currentValue ? `${currentValue}\n${nextLine}` : nextLine
}

const getCovidenceClipboardDisposition = (line: string): CovidenceEligibilityDisposition | null => {
  const normalizedLine = normalizeCovidenceClipboardHeading(line)

  if (['include', 'included', 'inclusion', 'inclusion criteria'].includes(normalizedLine)) {
    return 'include'
  }

  if (['exclude', 'excluded', 'exclusion', 'exclusion criteria'].includes(normalizedLine)) {
    return 'exclude'
  }

  return null
}

export const parseCovidenceEligibilityClipboardText = (text: string) => {
  const parsed = text
    .split(/\r?\n/)
    .map((line) => {
      return line.trim()
    })
    .reduce(
      (state, line) => {
        if (line === '') {
          return state
        }

        const nextSectionKey = covidenceEligibilitySectionKeyByLabel[normalizeCovidenceClipboardHeading(line)]

        if (nextSectionKey) {
          return {...state, currentDisposition: null, currentSection: nextSectionKey, sawSection: true}
        }

        const nextDisposition = getCovidenceClipboardDisposition(line)

        if (state.currentSection && nextDisposition) {
          return {...state, currentDisposition: nextDisposition}
        }

        if (!state.currentSection || !state.currentDisposition) {
          return state
        }

        state.values[state.currentSection][state.currentDisposition] = appendEligibilityClipboardLine(
          state.values[state.currentSection][state.currentDisposition],
          line,
        )

        return state
      },
      {
        currentDisposition: null as CovidenceEligibilityDisposition | null,
        currentSection: null as CovidenceEligibilitySectionKey | null,
        sawSection: false,
        values: createEmptyEligibilitySectionValues(),
      },
    )

  return parsed.sawSection ? parsed.values : null
}
