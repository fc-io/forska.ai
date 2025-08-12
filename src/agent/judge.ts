import {createOpenAI} from '@ai-sdk/openai'
import {generateText} from 'ai'

import type {getNewestArticlesToJudge} from '../components/main/projectsGrid/projectsGridGetNewestArticlesToJudge.ts'
import {judgeGetPrompt} from './judge/judgeGetPrompt.ts'
import {parseJudgment} from './judge/judgeParseJudgment.ts'
import {
  AIResponseType,
  parseModelResponse,
} from './judge/judgeParseModelResponse.ts'
import {judgeStoreJudgment} from './judge/judgeStoreJudgment.ts'
import {judgeStoreTokenUse} from './judge/judgeStoreTokenUse.ts'
import {SYSTEM_PROMPT} from './judge/judgeSystemPrompt.ts'

// Configure OpenAI to use local endpoint and create the model in one step
const model = createOpenAI({
  apiKey: 'fake_key',
  baseURL: 'http://localhost:8000/v1',
})('./models/Qwen3-32B-FP8')

// How many times we should ask the model to retry if the response is invalid
const MAX_RETRIES = 3

// Helper that calls the language model and returns raw text
const generateModelResponse = async (
  prompt: string,
): Promise<typeof AIResponseType.infer> => {
  const response = await generateText({model, system: SYSTEM_PROMPT, prompt})

  return parseModelResponse(response)
}

// Helper to build a retry prompt given the base prompt, last error and response
const buildRetryPrompt = (
  basePrompt: string,
  lastError: string,
  lastResponse: string,
): string => {
  return `${basePrompt}

---

Your previous answer did not match the required JSON schema and produced the following validation error:
${lastError}

Here is your previous answer:
${lastResponse}

Please try again, ensuring you respond ONLY with valid JSON matching the schema.`
}

type ArticlesType = Awaited<ReturnType<typeof getNewestArticlesToJudge>>

export const judge = async ({
  articles,
  sessionId,
}: {
  articles: ArticlesType
  sessionId: string
}): Promise<void> => {
  let tokenUse: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }[] = []
  const startedAt = new Date().toISOString()
  const startDuration = performance.now()

  await Promise.all(
    articles.map(async (article) => {
      const basePrompt = judgeGetPrompt(article)
      debugger
      let prompt = basePrompt
      let attempts = 0
      let lastError: string | null = null
      let lastResponse = ''

      while (attempts < MAX_RETRIES) {
        attempts += 1
        try {
          const modelResponse = await generateModelResponse(prompt)
          tokenUse.push({
            // articleId: article.id,
            promptTokens: modelResponse.usage.promptTokens,
            completionTokens: modelResponse.usage.completionTokens,
            totalTokens: modelResponse.usage.totalTokens,
          })
          // console.log('modelResponse', modelResponse)
          lastResponse = modelResponse.text
          const judgment = parseJudgment(lastResponse)
          await judgeStoreJudgment(article.id, article.articleTitle, judgment)

          return judgment
        } catch (error: unknown) {
          lastError = error instanceof Error ? error.message : 'Unknown error'
          console.error(
            `${article.id} | Attempt ${attempts} failed schema validation: ${lastError}`,
          )

          // Prepare prompt for next retry (memory + error context)
          if (attempts < MAX_RETRIES) {
            prompt = buildRetryPrompt(basePrompt, lastError, lastResponse)
          } else {
            console.error(`${article.id} | Aborting: ${lastError}`)
          }
        }
      }
      // If we exit the loop without returning, we failed all retries
      // return {
      //   error: lastError ?? 'Unknown error after retries',
      //   raw_response: lastResponse,
      // }
    }),
  )
  const duration = performance.now() - startDuration
  const finishedAt = new Date().toISOString()
  await judgeStoreTokenUse(tokenUse, sessionId, {
    startedAt,
    finishedAt,
    duration,
  })
}
