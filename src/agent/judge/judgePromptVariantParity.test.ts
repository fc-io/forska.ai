import {createHash} from 'node:crypto'

import {expect, test} from 'bun:test'

import type {ArticleRecord} from '../../db/schemaTypes.ts'
import {getSinglePromptJudgmentRequest} from './getSinglePromptJudgmentRequest.ts'
import {getFullTextChunkJudgingUserPrompt, getFullTextMergeJudgingUserPrompt} from './judgeGetPrompt.ts'
import type {SystemPromptVariant} from './systemPromptVariant.ts'

const article = {
  articleAuthors: null,
  articleCreatedAt: new Date('2018-03-01T00:00:00.000Z'),
  articleId: 'covidence:1',
  articleSummary: 'Weekly pharmacist review of antibiotic orders cut prescriptions from 62 to 41 per 100 admissions.',
  articleTitle: 'Pharmacist-led antibiotic review in a district hospital',
  articleUpdatedAt: null,
  articleVersion: null,
  arxivId: null,
  biorxivId: null,
  contentHash: null,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  doi: '10.1000/parity',
  fullText: 'Stored full text.',
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
  id: 'article-parity',
  importRoute: null,
  medrxivId: null,
  originalData: null,
  publicationStatus: 'published',
  pubmedId: '31234567',
  sourceMetadata: {
    issue: '3',
    journalTitle: 'J Antimicrob Chemother',
    pages: '100-110',
    publicationYear: 2019,
    volume: '74',
  },
  updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  url: null,
} satisfies ArticleRecord

const prompt = {
  id: 'prompt-parity',
  originalText: 'Is the study set in a hospital?',
  order: 1,
  promptHeading: 'Setting',
  type: `'yes' | 'no' | 'maybe'`,
}

const getSha256 = (value: string) => {
  return createHash('sha256').update(value).digest('hex')
}

const getVariantPromptStrings = (input: {
  provider: string
  systemPromptVariant: SystemPromptVariant
  useMetadata: boolean
}) => {
  const contentSettings = {
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useMetadata: input.useMetadata,
    useTitle: true,
  }
  const fullTextSettings = {...contentSettings, useFulltext: true}
  const titleAbstract = getSinglePromptJudgmentRequest({
    article,
    contentSettings,
    prompt,
    provider: input.provider,
    systemPromptVariant: input.systemPromptVariant,
  })
  const fullText = getSinglePromptJudgmentRequest({
    article,
    contentSettings: fullTextSettings,
    prompt,
    provider: input.provider,
    renderedFullText: '## Methods\n\nWe reviewed antibiotic orders on the medical wards.',
    systemPromptVariant: input.systemPromptVariant,
  })
  const part = getFullTextChunkJudgingUserPrompt({
    article,
    chunkCount: 3,
    chunkIndex: 1,
    chunkText: '## Results\n\nPrescriptions fell from 62 to 41.',
    contentSettings: fullTextSettings,
    prompt,
    systemPromptVariant: input.systemPromptVariant,
  })
  const merge = getFullTextMergeJudgingUserPrompt({
    article,
    chunkJudgments: [
      {
        answer: 'yes',
        chunkIndex: 0,
        confidence: 0.9,
        explanation: 'Wards.',
        headingPath: 'Methods',
        quotes: ['medical wards'],
      },
    ],
    contentSettings: fullTextSettings,
    prompt,
    systemPromptVariant: input.systemPromptVariant,
  })

  return {
    fullTextRecordText: fullText.recordText,
    fullTextSystemPrompt: fullText.systemPrompt,
    fullTextUserPrompt: fullText.userPrompt,
    merge,
    part,
    titleAbstractRecordText: titleAbstract.recordText,
    titleAbstractSystemPrompt: titleAbstract.systemPrompt,
    titleAbstractUserPrompt: titleAbstract.userPrompt,
  }
}

const getVariantPromptDigest = (input: Parameters<typeof getVariantPromptStrings>[0]) => {
  return getSha256(JSON.stringify(getVariantPromptStrings(input)))
}

const mainVariants = ['legacy', 'screening_v1'] as const satisfies readonly SystemPromptVariant[]

const getVariantPromptDigests = (systemPromptVariants: readonly SystemPromptVariant[]) => {
  return Object.fromEntries(
    systemPromptVariants.flatMap((systemPromptVariant) => {
      return [false, true].flatMap((useMetadata) => {
        return ['anthropic', 'openai'].map((provider) => {
          return [
            `${systemPromptVariant}:${useMetadata ? 'metadata' : 'no-metadata'}:${provider}`,
            getVariantPromptDigest({provider, systemPromptVariant, useMetadata}),
          ]
        })
      })
    }),
  )
}

test('legacy and screening_v1 prompts and recordText stay byte-identical to main with use_metadata on or off', () => {
  expect(getVariantPromptDigests(mainVariants)).toEqual({
    'legacy:metadata:anthropic': 'e6506f818a176ef361526dbcf21e765108925238d5b2e80371dd7e12b46c0cdc',
    'legacy:metadata:openai': '2198e357ac85c7c3a058bccca9196466a4aac4e452e82d268e97d66c2e4e8f84',
    'legacy:no-metadata:anthropic': 'ff239513dfde8a186e1be7ae0c2678c5ae957035db3ef3015843466d3468e2c7',
    'legacy:no-metadata:openai': '1b1eb2083cc758b9527f0566ea15b618e27ad863a18e0c68ba18f2aa0ca45b7b',
    'screening_v1:metadata:anthropic': '72459bacbbc9c921df7d00a369a133de39ca1f0c618f18d1ae31b54336a43d00',
    'screening_v1:metadata:openai': '03924e40a1b11ca3c3fdb7cf4a8e280fbb69fddda564419a7dc4ee23ea881570',
    'screening_v1:no-metadata:anthropic': 'f113b4c1fe5295b34b77c900e5ed1b72fe962b0fe290ff38bb6a4f91ece3e2fa',
    'screening_v1:no-metadata:openai': '6906841c9de7a9e874c2b2f4ab2d8ea3584468ef3a849d9f2d014308fba40b29',
  })
})

test('screening_v2 differs from screening_v1 only in the system prompt, plus the metadata quote changes when use_metadata is on', () => {
  const providers = ['anthropic', 'openai']
  const metadataQuoteSources = 'the title, the metadata or the summary'
  const recordQuoteSources = 'the title or the summary'

  providers.map((provider) => {
    const v1Off = getVariantPromptStrings({provider, systemPromptVariant: 'screening_v1', useMetadata: false})
    const v2Off = getVariantPromptStrings({provider, systemPromptVariant: 'screening_v2', useMetadata: false})
    const v1On = getVariantPromptStrings({provider, systemPromptVariant: 'screening_v1', useMetadata: true})
    const v2On = getVariantPromptStrings({provider, systemPromptVariant: 'screening_v2', useMetadata: true})
    const metadataLines =
      'journal: J Antimicrob Chemother\nyear: 2019\nvolume/issue/pages: 74(3):100-110\npublication_type: published\ndoi: 10.1000/parity\npmid: 31234567'

    expect(v2Off.titleAbstractSystemPrompt).not.toBe(v1Off.titleAbstractSystemPrompt)
    expect({...v2Off, fullTextSystemPrompt: null, titleAbstractSystemPrompt: null}).toEqual({
      ...v1Off,
      fullTextSystemPrompt: null,
      titleAbstractSystemPrompt: null,
    })
    expect(v2On.titleAbstractUserPrompt).toBe(v1On.titleAbstractUserPrompt)
    expect(v2On.fullTextUserPrompt).toBe(v1On.fullTextUserPrompt)
    expect(v2On.part.replace(metadataQuoteSources, recordQuoteSources)).toBe(v1On.part)
    expect(v2On.merge.replace(metadataQuoteSources, recordQuoteSources)).toBe(v1On.merge)
    expect(v2On.titleAbstractRecordText).toBe(
      v1On.titleAbstractRecordText.replace(
        'Pharmacist-led antibiotic review in a district hospital\n\n',
        `Pharmacist-led antibiotic review in a district hospital\n\n${metadataLines}\n\n`,
      ),
    )
    return expect(v2On.fullTextRecordText).toContain(metadataLines)
  })
})
