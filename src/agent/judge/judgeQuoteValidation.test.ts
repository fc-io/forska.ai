import {expect, test} from 'bun:test'

import type {ArticleRecord} from '../../db/schemaTypes.ts'
import {validateSinglePromptJudgmentQuotes} from '../judge.ts'
import {getSinglePromptJudgmentRequest} from './getSinglePromptJudgmentRequest.ts'
import {type SystemPromptVariant, systemPromptVariants} from './systemPromptVariant.ts'

test('single prompt quote validation accepts matching quotes', () => {
  const result = validateSinglePromptJudgmentQuotes({
    attempt: 1,
    judgment: {
      answer: 'yes',
      explanation: 'because',
      quotes: ['Effect of an educational intervention among Lebanese dentists'],
    },
    lastResponse: '{"answer":"yes"}',
    maxRetries: 2,
    recordText: 'Effect of an educational intervention among Lebanese dentists on antibiotic prescribing.',
    retryBasePrompt: 'base prompt',
  })

  expect(result.kind).toBe('valid')
})

test('single prompt quote validation repairs case-only quote differences to source text', () => {
  const result = validateSinglePromptJudgmentQuotes({
    attempt: 1,
    judgment: {
      answer: 'no',
      explanation: 'because',
      quotes: ['association between oral health and frailty among older cancer patients: a cross-sectional study.'],
    },
    lastResponse: '{"answer":"no"}',
    maxRetries: 2,
    recordText: 'Association between oral health and frailty among older cancer patients: a cross-sectional study.',
    retryBasePrompt: 'base prompt',
  })

  expect(result).toEqual({
    judgment: {
      answer: 'no',
      explanation: 'because',
      quotes: ['Association between oral health and frailty among older cancer patients: a cross-sectional study.'],
    },
    kind: 'valid',
  })
})

test('single prompt quote validation drops blank quotes', () => {
  const result = validateSinglePromptJudgmentQuotes({
    attempt: 1,
    judgment: {answer: 'no', explanation: 'because', quotes: ['', '   ']},
    lastResponse: '{"answer":"no","quotes":[""]}',
    maxRetries: 2,
    recordText: 'Local article text only.',
    retryBasePrompt: 'base prompt',
  })

  expect(result).toEqual({judgment: {answer: 'no', explanation: 'because', quotes: []}, kind: 'valid'})
})

test('single prompt quote validation accepts quotes wrapped in harmless outer quotes', () => {
  const result = validateSinglePromptJudgmentQuotes({
    attempt: 1,
    judgment: {
      answer: 'yes',
      explanation: 'because',
      quotes: ['"Effect of an educational intervention among Lebanese dentists"'],
    },
    lastResponse: '{"answer":"yes"}',
    maxRetries: 2,
    recordText: 'Effect of an educational intervention among Lebanese dentists on antibiotic prescribing.',
    retryBasePrompt: 'base prompt',
  })

  expect(result).toEqual({
    judgment: {
      answer: 'yes',
      explanation: 'because',
      quotes: ['Effect of an educational intervention among Lebanese dentists'],
    },
    kind: 'valid',
  })
})

test('single prompt quote validation accepts quotes wrapped in smart quotes', () => {
  const result = validateSinglePromptJudgmentQuotes({
    attempt: 1,
    judgment: {
      answer: 'yes',
      explanation: 'because',
      quotes: ['\u201cEffect of an educational intervention among Lebanese dentists\u201d'],
    },
    lastResponse: '{"answer":"yes"}',
    maxRetries: 2,
    recordText: 'Effect of an educational intervention among Lebanese dentists on antibiotic prescribing.',
    retryBasePrompt: 'base prompt',
  })

  expect(result).toEqual({
    judgment: {
      answer: 'yes',
      explanation: 'because',
      quotes: ['Effect of an educational intervention among Lebanese dentists'],
    },
    kind: 'valid',
  })
})

test('single prompt quote validation normalizes apostrophes back to the source substring', () => {
  const result = validateSinglePromptJudgmentQuotes({
    attempt: 1,
    judgment: {
      answer: 'no',
      explanation: 'because',
      quotes: [
        "Our purpose is to characterise lesions' features, helping diagnose, treat and emphasize the relevance of an adequate anamnesis.",
      ],
    },
    lastResponse: '{"answer":"no"}',
    maxRetries: 2,
    recordText:
      'Our purpose is to characterise lesions’ features, helping diagnose, treat and emphasize the relevance of an adequate anamnesis.',
    retryBasePrompt: 'base prompt',
  })

  expect(result).toEqual({
    judgment: {
      answer: 'no',
      explanation: 'because',
      quotes: [
        'Our purpose is to characterise lesions’ features, helping diagnose, treat and emphasize the relevance of an adequate anamnesis.',
      ],
    },
    kind: 'valid',
  })
})

test('single prompt quote validation normalizes internal double quotes back to the source substring', () => {
  const result = validateSinglePromptJudgmentQuotes({
    attempt: 1,
    judgment: {
      answer: 'no',
      explanation: 'because',
      quotes: ['The leading causes were dose selection (C3) (1264, 61.9%) and "other domain" (C9) (543, 26.6%)'],
    },
    lastResponse: '{"answer":"no"}',
    maxRetries: 2,
    recordText: 'The leading causes were dose selection (C3) (1264, 61.9%) and “other domain” (C9) (543, 26.6%)',
    retryBasePrompt: 'base prompt',
  })

  expect(result).toEqual({
    judgment: {
      answer: 'no',
      explanation: 'because',
      quotes: ['The leading causes were dose selection (C3) (1264, 61.9%) and “other domain” (C9) (543, 26.6%)'],
    },
    kind: 'valid',
  })
})

test('single prompt quote validation repairs visible text across HTML tags to source text', () => {
  const result = validateSinglePromptJudgmentQuotes({
    attempt: 1,
    judgment: {answer: 'no', explanation: 'because', quotes: ['PM2.5 concentrations']},
    lastResponse: '{"answer":"no"}',
    maxRetries: 2,
    recordText: 'Portable air cleaners reduce PM<sub>2.5</sub> concentrations in homes.',
    retryBasePrompt: 'base prompt',
  })

  expect(result).toEqual({
    judgment: {answer: 'no', explanation: 'because', quotes: ['PM<sub>2.5</sub> concentrations']},
    kind: 'valid',
  })
})

test('single prompt quote validation repairs visible text across escaped HTML tags to source text', () => {
  const sourceQuote = 'Metabolic changes using &lt;sup&gt;18&lt;/sup&gt;F-FDG PET/CT'
  const result = validateSinglePromptJudgmentQuotes({
    attempt: 1,
    judgment: {answer: 'no', explanation: 'because', quotes: ['Metabolic changes using <sup>18</sup>F-FDG PET/CT']},
    lastResponse: '{"answer":"no"}',
    maxRetries: 2,
    recordText: sourceQuote,
    retryBasePrompt: 'base prompt',
  })

  expect(result).toEqual({judgment: {answer: 'no', explanation: 'because', quotes: [sourceQuote]}, kind: 'valid'})
})

test('single prompt quote validation repairs malformed HTML quote tags to source text', () => {
  const sourceQuote = 'Pt<sub><i>x</i></sub>Sn<sub><i>y</i></sub> intermetallic compounds are widely used as catalysts'
  const result = validateSinglePromptJudgmentQuotes({
    attempt: 1,
    judgment: {
      answer: 'no',
      explanation: 'because',
      quotes: ['Pt<sub>x</i></sub>Sn<sub><i>y</i></sub> intermetallic compounds are widely used as catalysts'],
    },
    lastResponse: '{"answer":"no"}',
    maxRetries: 2,
    recordText: sourceQuote,
    retryBasePrompt: 'base prompt',
  })

  expect(result).toEqual({judgment: {answer: 'no', explanation: 'because', quotes: [sourceQuote]}, kind: 'valid'})
})

test('single prompt quote validation keeps exact quotes that already include source quotation marks', () => {
  const result = validateSinglePromptJudgmentQuotes({
    attempt: 1,
    judgment: {answer: 'yes', explanation: 'because', quotes: ['"Intervention arm"']},
    lastResponse: '{"answer":"yes"}',
    maxRetries: 2,
    recordText: 'The report labels this cohort as "Intervention arm" in the methods section.',
    retryBasePrompt: 'base prompt',
  })

  expect(result).toEqual({
    judgment: {answer: 'yes', explanation: 'because', quotes: ['"Intervention arm"']},
    kind: 'valid',
  })
})

test('single prompt quote validation still rejects ellipsized quotes', () => {
  const result = validateSinglePromptJudgmentQuotes({
    attempt: 1,
    judgment: {answer: 'yes', explanation: 'because', quotes: ['Local article...text only.']},
    lastResponse: '{"answer":"yes","quotes":["Local article...text only."]}',
    maxRetries: 2,
    recordText: 'Local article text only.',
    retryBasePrompt: 'base prompt',
  })

  expect(result.kind).toBe('retry')
})

test('single prompt quote validation drops criteria quotes when article quotes remain valid', () => {
  const retryBasePrompt = `## article_title

Barriers in implementing antibiotic stewardship programmes at paediatric units in academic hospitals in Thailand

## article_summary

OBJECTIVE: To explore the barriers that hinder and the facilitators that strengthen the implementation of the antimicrobial stewardship (AMS) programme at paediatric units in academic hospitals in Thailand.

## Question

Inclusion criteria:
Antimicrobial stewardship can also be an intervention`
  const result = validateSinglePromptJudgmentQuotes({
    attempt: 1,
    judgment: {
      answer: 'yes',
      explanation: 'because',
      quotes: [
        'implementation of the antimicrobial stewardship (AMS) programme at paediatric units in academic hospitals in Thailand',
        'Antimicrobial stewardship can also be an intervention',
      ],
    },
    lastResponse: '{"answer":"yes"}',
    maxRetries: 2,
    recordText:
      'Barriers in implementing antibiotic stewardship programmes at paediatric units in academic hospitals in Thailand\n\nOBJECTIVE: To explore the barriers that hinder and the facilitators that strengthen the implementation of the antimicrobial stewardship (AMS) programme at paediatric units in academic hospitals in Thailand.',
    retryBasePrompt,
  })

  expect(result).toEqual({
    judgment: {
      answer: 'yes',
      explanation: 'because',
      quotes: [
        'implementation of the antimicrobial stewardship (AMS) programme at paediatric units in academic hospitals in Thailand',
      ],
    },
    kind: 'valid',
  })
})

test('single prompt quote validation accepts empty quotes when only criteria text was quoted', () => {
  const retryBasePrompt = `## article_title

Antibiotic use and resistance: Information sources and application by dentists in Jordan.

## article_summary

The present study aimed to evaluate dentists' preferred sources of information.

## Question

Inclusion criteria:
Interventions aimed at improving antibiotic prescribing/use`
  const result = validateSinglePromptJudgmentQuotes({
    attempt: 1,
    judgment: {
      answer: 'no',
      explanation: 'because',
      quotes: ['Interventions aimed at improving antibiotic prescribing/use'],
    },
    lastResponse: '{"answer":"no"}',
    maxRetries: 2,
    recordText:
      "Antibiotic use and resistance: Information sources and application by dentists in Jordan.\n\nThe present study aimed to evaluate dentists' preferred sources of information.",
    retryBasePrompt,
  })

  expect(result).toEqual({judgment: {answer: 'no', explanation: 'because', quotes: []}, kind: 'valid'})
})

test('single prompt quote validation repairs invalid quotes to empty quotes for no answers', () => {
  const result = validateSinglePromptJudgmentQuotes({
    attempt: 1,
    judgment: {answer: 'no', explanation: 'because', quotes: ['foreign quote']},
    lastResponse: '{"answer":"no","quotes":["foreign quote"]}',
    maxRetries: 2,
    recordText: 'Local article text only.',
    retryBasePrompt: 'base prompt',
  })

  expect(result).toEqual({judgment: {answer: 'no', explanation: 'because', quotes: []}, kind: 'valid'})
})

test('single prompt quote validation keeps valid quotes when repairing no answers', () => {
  const result = validateSinglePromptJudgmentQuotes({
    attempt: 1,
    judgment: {answer: 'no', explanation: 'because', quotes: ['PM2.5 concentrations', 'invented quote']},
    lastResponse: '{"answer":"no","quotes":["PM2.5 concentrations","invented quote"]}',
    maxRetries: 2,
    recordText: 'Portable air cleaners reduce PM<sub>2.5</sub> concentrations in homes.',
    retryBasePrompt: 'base prompt',
  })

  expect(result).toEqual({
    judgment: {answer: 'no', explanation: 'because', quotes: ['PM<sub>2.5</sub> concentrations']},
    kind: 'valid',
  })
})

test('single prompt quote validation requests a retry before the final attempt for yes answers', () => {
  const result = validateSinglePromptJudgmentQuotes({
    attempt: 1,
    judgment: {answer: 'yes', explanation: 'because', quotes: ['foreign quote']},
    lastResponse: '{"answer":"yes","quotes":["foreign quote"]}',
    maxRetries: 2,
    recordText: 'Local article text only.',
    retryBasePrompt: 'base prompt',
  })

  expect(result.kind).toBe('retry')

  if (result.kind === 'retry') {
    expect(result.nextPrompt).toContain('foreign quote')
    expect(result.nextPrompt).toContain(
      'never from the question, inclusion criteria, exclusion criteria, or any instructions',
    )
    expect(result.nextPrompt).toContain('Do not add surrounding quotation marks unless they appear in the source text.')
    expect(result.nextPrompt).toContain('Do not shorten quotes with ellipses.')
    expect(result.nextPrompt).toContain('Do not include wrapper markers in quotes.')
    expect(result.error).toBe('Invalid quotes: not substrings of record text')
  }
})

test('single prompt quote validation retries when only some quotes can be repaired', () => {
  const result = validateSinglePromptJudgmentQuotes({
    attempt: 1,
    judgment: {answer: 'yes', explanation: 'because', quotes: ['PM2.5 concentrations', 'invented quote']},
    lastResponse: '{"answer":"yes","quotes":["PM2.5 concentrations","invented quote"]}',
    maxRetries: 2,
    recordText: 'Portable air cleaners reduce PM<sub>2.5</sub> concentrations in homes.',
    retryBasePrompt: 'base prompt',
  })

  expect(result.kind).toBe('retry')

  if (result.kind === 'retry') {
    expect(result.nextPrompt).toContain('invented quote')
    expect(result.nextPrompt).not.toContain('- "PM2.5 concentrations"')
  }
})

test('single prompt quote validation requeues after the final invalid attempt', () => {
  const result = validateSinglePromptJudgmentQuotes({
    attempt: 2,
    judgment: {answer: 'yes', explanation: 'because', quotes: ['foreign quote']},
    lastResponse: '{"answer":"yes","quotes":["foreign quote"]}',
    maxRetries: 2,
    recordText: 'Local article text only.',
    retryBasePrompt: 'base prompt',
  })

  expect(result).toEqual({error: 'Invalid quotes: not substrings of record text', kind: 'requeue'})
})

test('single prompt quote validation drops quotes copied from the article_metadata block instead of retrying', () => {
  const retryBasePrompt = `## article_title

Weekly pharmacist review of antibiotic orders

## article_metadata

journal: Journal of Antimicrobial Chemotherapy
year: 2019

## article_summary

Antibiotic prescriptions per 100 admissions fell from 62 to 41.

## Question

Is the study set in a hospital?`
  const result = validateSinglePromptJudgmentQuotes({
    attempt: 1,
    judgment: {
      answer: 'yes',
      explanation: 'because',
      quotes: ['Journal of Antimicrobial Chemotherapy', 'fell from 62 to 41'],
    },
    lastResponse: '{"answer":"yes"}',
    maxRetries: 2,
    recordText:
      'Weekly pharmacist review of antibiotic orders\n\nAntibiotic prescriptions per 100 admissions fell from 62 to 41.\n\n',
    retryBasePrompt,
  })

  expect(result).toEqual({
    judgment: {answer: 'yes', explanation: 'because', quotes: ['fell from 62 to 41']},
    kind: 'valid',
  })
})

const getMetadataQuoteRequest = (input: {
  sourceMetadata?: ArticleRecord['sourceMetadata']
  systemPromptVariant: SystemPromptVariant
  useMetadata: boolean
}) => {
  return getSinglePromptJudgmentRequest({
    article: {
      articleAuthors: null,
      articleCreatedAt: null,
      articleId: 'article:metadata',
      articleSummary: 'Antibiotic prescriptions per 100 admissions fell from 62 to 41.',
      articleTitle: 'Weekly pharmacist review of antibiotic orders',
      articleUpdatedAt: null,
      articleVersion: null,
      arxivId: null,
      biorxivId: null,
      contentHash: null,
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      doi: null,
      fullText: null,
      fullTextAssets: null,
      fullTextCharCount: null,
      fullTextConversionAttempts: null,
      fullTextConversionError: null,
      fullTextConversionMetadata: null,
      fullTextConversionModelId: null,
      fullTextConversionStatus: null,
      fullTextFetchedAt: null,
      fullTextHtml: null,
      fullTextOriginalFormat: null,
      fullTextPDF: null,
      fullTextSource: null,
      id: 'article-metadata',
      importRoute: null,
      medrxivId: null,
      originalData: null,
      publicationStatus: null,
      pubmedId: null,
      sourceMetadata:
        input.sourceMetadata === undefined
          ? {journalTitle: 'Journal of Antimicrobial Chemotherapy', publicationYear: 2019}
          : input.sourceMetadata,
      updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      url: null,
    },
    contentSettings: {
      useAbstract: true,
      useFulltext: false,
      useFulltextNoImages: false,
      useMetadata: input.useMetadata,
      useTitle: true,
    },
    prompt: {
      id: 'prompt-metadata',
      originalText: 'Is the study set in a hospital?',
      order: 1,
      promptHeading: null,
      type: `'yes' | 'no' | 'maybe'`,
    },
    provider: 'anthropic',
    systemPromptVariant: input.systemPromptVariant,
  })
}

const getValidatedMetadataQuotes = (request: ReturnType<typeof getMetadataQuoteRequest>, quotes: string[]) => {
  const result = validateSinglePromptJudgmentQuotes({
    attempt: 1,
    judgment: {answer: 'yes', explanation: 'because', quotes},
    lastResponse: '{"answer":"yes"}',
    maxRetries: 2,
    recordText: request.recordText,
    retryBasePrompt: request.userPrompt,
  })

  return result.kind === 'valid' ? result.judgment.quotes : result.kind
}

test('only screening_v2 to screening_v5 with use_metadata on keep a quote copied from the article_metadata block', () => {
  const quotes = ['Journal of Antimicrobial Chemotherapy', 'year: 2019', 'fell from 62 to 41']

  expect(
    systemPromptVariants.flatMap((systemPromptVariant) => {
      return [false, true].map((useMetadata) => {
        return [
          `${systemPromptVariant}:${useMetadata ? 'metadata' : 'no-metadata'}`,
          getValidatedMetadataQuotes(getMetadataQuoteRequest({systemPromptVariant, useMetadata}), quotes),
        ]
      })
    }),
  ).toEqual([
    ['legacy:no-metadata', 'retry'],
    ['legacy:metadata', ['fell from 62 to 41']],
    ['screening_v1:no-metadata', 'retry'],
    ['screening_v1:metadata', ['fell from 62 to 41']],
    ['screening_v2:no-metadata', 'retry'],
    ['screening_v2:metadata', quotes],
    ['screening_v3:no-metadata', 'retry'],
    ['screening_v3:metadata', quotes],
    ['screening_v4:no-metadata', 'retry'],
    ['screening_v4:metadata', quotes],
    ['screening_v5:no-metadata', 'retry'],
    ['screening_v5:metadata', quotes],
  ])
})

test('screening_v3 with use_metadata on keeps quotes of the registry id and source url of a registry record', () => {
  const sourceMetadata = {
    accessionNumber: 'NCT01234567',
    journalTitle: null,
    publicationYear: 2017,
    sourceUrl: 'https://clinicaltrials.gov/study/NCT01234567',
  }
  const quotes = ['registry_id: NCT01234567', 'https://clinicaltrials.gov/study/NCT01234567', 'fell from 62 to 41']
  const v3Request = getMetadataQuoteRequest({sourceMetadata, systemPromptVariant: 'screening_v3', useMetadata: true})
  const v1Request = getMetadataQuoteRequest({sourceMetadata, systemPromptVariant: 'screening_v1', useMetadata: true})

  expect(v3Request.userPrompt).toContain(
    '## article_metadata\n\nyear: 2017\nregistry_id: NCT01234567\nsource_url: https://clinicaltrials.gov/study/NCT01234567\n\n',
  )
  expect(v1Request.userPrompt).toContain(
    '## article_metadata\n\nyear: 2017\nregistry_id: NCT01234567\nsource_url: https://clinicaltrials.gov/study/NCT01234567\n\n',
  )
  expect(getValidatedMetadataQuotes(v3Request, quotes)).toEqual(quotes)
  expect(getValidatedMetadataQuotes(v1Request, quotes)).toEqual(['fell from 62 to 41'])
})

test('screening_v2 still drops the article_metadata heading and none available', () => {
  const request = getMetadataQuoteRequest({
    sourceMetadata: null,
    systemPromptVariant: 'screening_v2',
    useMetadata: true,
  })

  expect(request.userPrompt).toContain('## article_metadata\n\nnone available\n\n')
  expect(getValidatedMetadataQuotes(request, ['none available', 'article_metadata', 'fell from 62 to 41'])).toEqual([
    'fell from 62 to 41',
  ])
})
