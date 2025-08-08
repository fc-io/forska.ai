import {drizzle} from 'drizzle-orm/node-postgres'
import {seed} from 'drizzle-seed'

import * as authSchema from '../../auth-schema.ts'
import {env} from '../server/utils/env.ts'
import * as schema from './schema.ts'

const main = async () => {
  const db = drizzle(env.DATABASE_URL)

  await seed(db, {...schema, ...authSchema}).refine((funcs) => {
    return {
      user: {count: 5, with: {session: {count: [1, 2]}}},
      profiles: {
        count: 5,
        columns: {
          fullName: funcs.fullName(),
          avatarUrl: funcs.loremIpsum({sentencesCount: 0}),
          isAdmin: funcs.weightedRandom([
            {weight: 0.2, value: funcs.default({defaultValue: true})},
            {weight: 0.8, value: funcs.default({defaultValue: false})},
          ]),
        },
        with: {projects: {count: [1, 3]}},
      },
      projects: {
        columns: {
          name: funcs.companyName(),
          description: funcs.loremIpsum({sentencesCount: 2}),
        },
        with: {prompts: {count: [2, 5]}, projectMembers: {count: [1, 3]}},
      },
      prompts: {
        columns: {
          originalText: funcs.loremIpsum({sentencesCount: 3}),
          transformedText: funcs.loremIpsum({sentencesCount: 3}),
          promptHeading: funcs.loremIpsum({sentencesCount: 1}),
          order: funcs.int({minValue: 1, maxValue: 10}),
          archived: funcs.weightedRandom([
            {weight: 0.1, value: funcs.default({defaultValue: true})},
            {weight: 0.9, value: funcs.default({defaultValue: false})},
          ]),
        },
      },
      models: {
        count: 6,
        columns: {
          name: funcs.valuesFromArray({
            values: [
              'GPT-4',
              'GPT-3.5-turbo',
              'Claude-3-Opus',
              'Claude-3-Sonnet',
              'Gemini-Pro',
              'Llama-3-70B',
            ],
          }),
          provider: funcs.valuesFromArray({
            values: [
              'OpenAI',
              'OpenAI',
              'Anthropic',
              'Anthropic',
              'Google',
              'Meta',
            ],
          }),
          modelName: funcs.valuesFromArray({
            values: [
              'gpt-4',
              'gpt-3.5-turbo',
              'claude-3-opus',
              'claude-3-sonnet',
              'gemini-pro',
              'llama-3-70b',
            ],
          }),
          version: funcs.valuesFromArray({
            values: [
              '1.0.0',
              '1.0.0',
              '2024-02-29',
              '2024-02-29',
              '1.5',
              '3.0',
            ],
          }),
          apiKeyVariable: funcs.valuesFromArray({
            values: [
              'OPENAI_API_KEY',
              'OPENAI_API_KEY',
              'ANTHROPIC_API_KEY',
              'ANTHROPIC_API_KEY',
              'GOOGLE_API_KEY',
              'META_API_KEY',
            ],
          }),
        },
      },
      articles: {
        count: 20,
        columns: {
          articleTitle: funcs.loremIpsum({sentencesCount: 1}),
          articleAuthors: funcs.default({
            defaultValue: ['John Doe', 'Jane Smith'],
          }),
          articleCreatedAt: funcs.date({
            minDate: '2023-01-01',
            maxDate: '2024-12-31',
          }),
          articleUpdatedAt: funcs.date({
            minDate: '2023-01-01',
            maxDate: '2024-12-31',
          }),
          articleId: funcs.uuid(),
          articleSummary: funcs.loremIpsum({sentencesCount: 5}),
          articleVersion: funcs.int({minValue: 1, maxValue: 5}),
          arxivId: funcs.string(),
          doi: funcs.string(),
          pubmedId: funcs.string(),
          url: funcs.string(),
          contentHash: funcs.string(),
          publicationStatus: funcs.valuesFromArray({
            values: [
              'preprint',
              'submitted',
              'accepted',
              'published',
              'retracted',
            ],
          }),
        },
        with: {judgments: {count: [3, 8]}},
      },
      judgments: {
        columns: {
          answeredOriginal: funcs.valuesFromArray({
            values: ['yes', 'no', 'unsure'],
          }),
          answeredTransformed: funcs.valuesFromArray({
            values: ['yes', 'no', 'unsure'],
          }),
          confidenceOriginal: funcs.int({minValue: 1, maxValue: 100}),
          explanation: funcs.loremIpsum({sentencesCount: 3}),
          quotes: funcs.default({
            defaultValue: {quotes: ['Sample quote text']},
          }),
        },
      },
      tokenUse: {
        count: 50,
        columns: {
          requests: funcs.int({minValue: 1, maxValue: 10}),
          totalPromptTokens: funcs.int({minValue: 100, maxValue: 5000}),
          totalCompletionTokens: funcs.int({minValue: 50, maxValue: 2000}),
          totalTokens: funcs.int({minValue: 150, maxValue: 7000}),
          startedAt: funcs.date({minDate: '2024-01-01', maxDate: '2024-12-31'}),
          finishedAt: funcs.date({
            minDate: '2024-01-01',
            maxDate: '2024-12-31',
          }),
          duration: funcs.int({minValue: 100, maxValue: 10000}),
        },
      },
    }
  })

  console.log('✅ Database seeded successfully')
}

void main()
