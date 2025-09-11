import OpenAI from 'openai'

import type {getNewestArticlesToJudge} from '../components/main/projectsGrid/projectsGridGetNewestArticlesToJudge.ts'
import {apiClient} from '../services/apiClient.ts'
import {judgeGetPrompt} from './judge/judgeGetPrompt.ts'
import {parseJudgment} from './judge/judgeParseJudgment.ts'
import {AIResponseType} from './judge/judgeParseModelResponse.ts'
import {judgeStoreJudgment} from './judge/judgeStoreJudgment.ts'
import {judgeStoreTokenUse} from './judge/judgeStoreTokenUse.ts'
import {SYSTEM_PROMPT} from './judge/judgeSystemPrompt.ts'

// Configure OpenAI client for local vLLM server
const openaiClient = new OpenAI({
  apiKey: 'fake_key',
  dangerouslyAllowBrowser: true,
  baseURL: 'http://localhost:8000/v1',
})

// How many times we should ask the model to retry if the response is invalid
const MAX_RETRIES = 3

// Helper that calls the language model using OpenAI client directly
const generateModelResponseDirect = async (prompt: string): Promise<typeof AIResponseType.infer> => {
  try {
    const response = await openaiClient.chat.completions.create({
      model: './models/Qwen3-32B-FP8',
      messages: [
        {role: 'system', content: SYSTEM_PROMPT},
        {role: 'user', content: prompt},
      ],
      max_tokens: 4000,
      temperature: 0.7,
    })

    // Extract content - handle both content and reasoning_content
    const message = response.choices[0]?.message
    if (!message) throw new Error('No message in response')
    const content = message.content || (message as any).reasoning_content || ''

    // Convert OpenAI response to AI SDK format
    const aiResponse = {
      text: content,
      files: [],
      reasoningDetails: [],
      toolCalls: [],
      toolResults: [],
      finishReason: response.choices[0]?.finish_reason || 'stop',
      usage: {
        promptTokens: response.usage?.prompt_tokens || 0,
        completionTokens: response.usage?.completion_tokens || 0,
        totalTokens: response.usage?.total_tokens || 0,
      },
      warnings: [],
      request: {
        body: JSON.stringify({
          model: './models/Qwen3-32B-FP8',
          messages: [
            {role: 'system', content: SYSTEM_PROMPT},
            {role: 'user', content: prompt},
          ],
        }),
      },
      response: {
        id: response.id,
        timestamp: new Date(response.created * 1000),
        modelId: response.model,
        headers: {'content-length': '0', 'content-type': 'application/json'},
        body: response as any,
        messages: [{role: 'assistant' as const, content: content, id: response.id}],
      },
      steps: [],
      experimental_providerMetadata: {openai: {}},
      providerMetadata: {openai: {}},
      sources: [],
    }

    return aiResponse
  } catch (error) {
    console.error('Error calling OpenAI client:', error)
    throw error
  }
}

// Use the direct OpenAI client implementation
const generateModelResponse = generateModelResponseDirect

// Helper to build a retry prompt given the base prompt, last error and response
const buildRetryPrompt = (basePrompt: string, lastError: string, lastResponse: string): string => {
  return `${basePrompt}

---

Your previous answer did not match the required JSON schema and produced the following validation error:
${lastError}

Here is your previous answer:
${lastResponse}

Please try again, ensuring you respond ONLY with valid JSON matching the schema.`
}

type ArticlesType = Awaited<ReturnType<typeof getNewestArticlesToJudge>>['articles']

type PromptsType = Awaited<ReturnType<typeof getNewestArticlesToJudge>>['prompts']

export const judge = async ({
  articles,
  prompts,
  sessionId,
}: {
  articles: ArticlesType
  prompts: PromptsType
  sessionId: string
}): Promise<void> => {
  // Get or create model ID for the vLLM model
  let modelId: string | undefined
  try {
    const modelResult = await apiClient.api.judgments.model.get({query: {name: 'Qwen3-32B-FP8', provider: 'vLLM'}})
    if (modelResult.data?.success && modelResult.data?.data) {
      modelId = modelResult.data.data.id
    }
  } catch (error) {
    console.error('Failed to get model ID:', error)
  }
  let tokenUse: {promptTokens: number; completionTokens: number; totalTokens: number}[] = []
  const startedAt = new Date().toISOString()
  const startDuration = performance.now()

  await Promise.all(
    articles.map(async (article) => {
      const basePrompt = judgeGetPrompt(article, prompts)
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
          const judgment = parseJudgment(lastResponse, prompts)
          const promptIds = prompts.map((p) => {
            return p.id
          })
          await judgeStoreJudgment(article.id, article.articleTitle, judgment, modelId, promptIds)

          return judgment
        } catch (error: unknown) {
          lastError = error instanceof Error ? error.message : 'Unknown error'
          console.error(`${article.id} | Attempt ${attempts} failed schema validation: ${lastError}`)

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
  await judgeStoreTokenUse(tokenUse, sessionId, {startedAt, finishedAt, duration})
}
