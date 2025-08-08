import {drizzle} from 'drizzle-orm/node-postgres'
import {seed} from 'drizzle-seed'

import * as authSchema from '../../auth-schema.ts'
import {env} from '../server/utils/env.ts'
import * as schema from './schema.ts'

const main = async () => {
  const db = drizzle(env.DATABASE_URL)

  // Clear existing data first in correct order (respecting foreign keys)
  console.log('🗑️  Clearing existing data...')
  await db.delete(schema.tokenUse)
  await db.delete(schema.judgments)
  await db.delete(schema.articles)
  await db.delete(schema.prompts)
  await db.delete(schema.projectMembers)
  await db.delete(schema.projects)
  await db.delete(schema.profiles)
  await db.delete(authSchema.session)
  await db.delete(authSchema.verification)
  await db.delete(authSchema.user)
  await db.delete(schema.models)

  console.log('🌱 Seeding database...')

  // Seed the database - exclude tables with complex relationships for now
  await seed(db, {
    user: authSchema.user,
    models: schema.models,
    articles: schema.articles,
  }).refine((funcs) => {
    return {
      user: {
        count: 5,
        columns: {
          id: funcs.string(),
          name: funcs.fullName(),
          email: funcs.email(),
          emailVerified: funcs.boolean(),
          image: funcs.loremIpsum({sentencesCount: 0}),
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
      },
    }
  })

  // Now manually add profiles linked to users
  const users = await db.select().from(authSchema.user)
  console.log(`Creating profiles for ${users.length} users...`)
  
  for (const user of users) {
    await db
      .insert(schema.profiles)
      .values({
        userId: user.id,
        fullName: user.name,
        avatarUrl: `https://avatar.placeholder.com/${user.id}`,
        isAdmin: Math.random() < 0.2,
      })
  }

  // Add some projects
  const profiles = await db.select().from(schema.profiles)
  console.log(`Creating projects for ${profiles.length} profiles...`)
  
  for (const profile of profiles) {
    const projectCount = Math.floor(Math.random() * 3) + 1
    for (let i = 0; i < projectCount; i++) {
      const projectId = await db
        .insert(schema.projects)
        .values({
          name: `Project ${i + 1} for ${profile.fullName}`,
          description: `Description for project ${i + 1}`,
          ownerId: profile.id,
        })
        .returning({id: schema.projects.id})

      // Add prompts to each project
      const promptCount = Math.floor(Math.random() * 4) + 2
      for (let j = 0; j < promptCount; j++) {
        await db
          .insert(schema.prompts)
          .values({
            projectId: projectId[0].id,
            originalText: `Original text for prompt ${j + 1}`,
            transformedText: `Transformed text for prompt ${j + 1}`,
            promptHeading: `Prompt ${j + 1}`,
            order: j + 1,
            archived: Math.random() < 0.1,
          })
      }
    }
  }

  // Add judgments to articles
  const articles = await db.select().from(schema.articles)
  const prompts = await db.select().from(schema.prompts)
  const models = await db.select().from(schema.models)
  
  console.log(`Creating judgments for ${articles.length} articles...`)
  
  for (const article of articles) {
    if (prompts.length === 0 || models.length === 0 || profiles.length === 0) {
      console.log('Skipping judgments - missing required data')
      break
    }
    const judgmentCount = Math.floor(Math.random() * 6) + 3
    for (let i = 0; i < judgmentCount; i++) {
      const prompt = prompts[Math.floor(Math.random() * prompts.length)]
      const model = models[Math.floor(Math.random() * models.length)]
      const profile = profiles[Math.floor(Math.random() * profiles.length)]

      await db
        .insert(schema.judgments)
        .values({
          articleId: article.id!,
          promptId: prompt.id!,
          modelId: model.id!,
          profileId: profile.id!,
          answeredOriginal: ['yes', 'no', 'unsure'][
            Math.floor(Math.random() * 3)
          ] as 'yes' | 'no' | 'unsure',
          answeredTransformed: ['yes', 'no', 'unsure'][
            Math.floor(Math.random() * 3)
          ] as 'yes' | 'no' | 'unsure',
          confidenceOriginal: Math.floor(Math.random() * 100) + 1,
          explanation: `Explanation for judgment ${i + 1}`,
          quotes: {quotes: [`Quote ${i + 1} from article`]},
        })
    }
  }

  console.log('✅ Database seeded successfully')
}

void main()