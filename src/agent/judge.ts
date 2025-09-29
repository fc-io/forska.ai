import OpenAI from 'openai'
import type {ChatCompletion, ChatCompletionMessage} from 'openai/resources/chat/completions'

import type {getNewestArticlesToJudge} from '../components/main/projectsGrid/projectsGridGetNewestArticlesToJudge.ts'
import {env} from '../server/utils/env.ts'
import {apiClient} from '../services/apiClient.ts'
import {judgeGetPrompt} from './judge/judgeGetPrompt.ts'
import {parseJudgment} from './judge/judgeParseJudgment.ts'
import {AIResponseType} from './judge/judgeParseModelResponse.ts'
import {judgeStoreJudgment} from './judge/judgeStoreJudgment.ts'
import {judgeStoreTokenUse} from './judge/judgeStoreTokenUse.ts'
import {SYSTEM_PROMPT} from './judge/judgeSystemPrompt.ts'

const openAIClients = new Map<string, OpenAI>()
const DEFAULT_MODEL_LOOKUP = 'Qwen3-32B-FP8'
const DEFAULT_MODEL_NAME = './models/Qwen3-32B-FP8'

type ModelConfigInput = {modelId?: string | null; modelName?: string | null; baseURL?: string | null}

type AssistantMessageShape = {
  role: 'assistant'
  content: string
  tool_calls?: ChatCompletionMessage['tool_calls']
  reasoning_content?: string
}

const getOpenAIClient = (baseURL: string): OpenAI => {
  const existingClient = openAIClients.get(baseURL)
  if (existingClient) {
    return existingClient
  }
  const client = new OpenAI({apiKey: 'fake_key', dangerouslyAllowBrowser: true, baseURL})
  openAIClients.set(baseURL, client)
  return client
}

const hasReasoningContent = (
  message: ChatCompletionMessage,
): message is ChatCompletionMessage & {reasoning_content: string} => {
  return typeof (message as {reasoning_content?: unknown}).reasoning_content === 'string'
}

const formatAssistantMessage = (message: ChatCompletionMessage): AssistantMessageShape => {
  const reasoningContent = hasReasoningContent(message) ? message.reasoning_content : null
  const textContent = typeof message.content === 'string' ? message.content : ''
  const content = textContent || reasoningContent || ''
  const toolCalls = message.tool_calls && message.tool_calls.length > 0 ? message.tool_calls : undefined

  return {
    role: 'assistant',
    content,
    ...(toolCalls ? {tool_calls: toolCalls} : {}),
    ...(reasoningContent ? {reasoning_content: reasoningContent} : {}),
  }
}

const toChoice = (choice: ChatCompletion['choices'][number]) => {
  return {
    index: choice.index,
    message: formatAssistantMessage(choice.message),
    logprobs: null,
    finish_reason: choice.finish_reason,
    stop_reason: null,
  }
}

const buildResponseBody = (response: ChatCompletion, choices: ReturnType<typeof toChoice>[]) => {
  const usage = response.usage
    ? {
        prompt_tokens: response.usage.prompt_tokens,
        completion_tokens: response.usage.completion_tokens,
        total_tokens: response.usage.total_tokens,
        prompt_tokens_details: null,
      }
    : {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: null}

  return {
    id: response.id,
    object: response.object,
    created: response.created,
    model: response.model,
    choices,
    usage,
    prompt_logprobs: null,
    kv_transfer_params: null,
  }
}

// How many times we should ask the model to retry if the response is invalid
const MAX_RETRIES = 2

// Helper that calls the language model using OpenAI client directly
const generateModelResponse = async ({
  prompt,
  baseURL,
  modelName,
}: {
  prompt: string
  baseURL: string
  modelName: string
}): Promise<typeof AIResponseType.infer> => {
  const client = getOpenAIClient(baseURL)
  try {
    const response = await client.chat.completions.create({
      model: modelName,
      messages: [
        {role: 'system', content: SYSTEM_PROMPT},
        {role: 'user', content: prompt},
      ],
      max_tokens: 2048,
      temperature: 0,
    })

    const message = response.choices[0]?.message
    if (!message) throw new Error('No message in response')
    const assistantMessage = formatAssistantMessage(message)
    const content = assistantMessage.content
    const normalizedChoices = response.choices.map((choice) => {
      return toChoice(choice)
    })
    const finishReason = normalizedChoices[0]?.finish_reason || 'stop'
    const responseBody = buildResponseBody(response, normalizedChoices)

    const aiResponse = {
      text: content,
      files: [],
      reasoningDetails: [],
      toolCalls: [],
      toolResults: [],
      finishReason,
      usage: {
        promptTokens: response.usage?.prompt_tokens || 0,
        completionTokens: response.usage?.completion_tokens || 0,
        totalTokens: response.usage?.total_tokens || 0,
      },
      warnings: [],
      request: {
        body: JSON.stringify({
          model: modelName,
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
        body: responseBody,
        messages: [{...assistantMessage, id: response.id}],
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
  judgmentsJobId,
  modelConfig,
}: {
  articles: ArticlesType
  prompts: PromptsType
  sessionId: string | null
  judgmentsJobId?: string
  modelConfig?: ModelConfigInput
}): Promise<void> => {
  const baseURL = modelConfig?.baseURL || env.VITE_LLM_SERVER_URL
  const modelName = modelConfig?.modelName || DEFAULT_MODEL_NAME
  const modelLookupName = modelConfig?.modelName || DEFAULT_MODEL_LOOKUP

  let modelId: string | undefined = modelConfig?.modelId ?? undefined
  if (!modelId) {
    try {
      const modelResult = await apiClient.api.judgments.model.get({
        query: {name: modelLookupName, provider: 'vLLM', baseURL},
      })
      if (modelResult.data?.success && modelResult.data?.data) {
        modelId = modelResult.data.data.id
      }
    } catch (error) {
      console.error('Failed to get model ID:', error)
    }
  }
  const tokenUse: {promptTokens: number; completionTokens: number; totalTokens: number}[] = []
  const startedAt = new Date().toISOString()
  const startDuration = performance.now()

  await Promise.allSettled(
    articles.map(async (article) => {
      const basePrompt = judgeGetPrompt(article, prompts)
      let prompt = basePrompt
      let attempts = 0
      let lastError: string | null = null
      let lastResponse = ''

      while (attempts < MAX_RETRIES) {
        attempts += 1
        if (attempts > 1) {
          console.log(`${article.id} | Attempt ${attempts} of ${MAX_RETRIES}`)
        }
        try {
          const modelResponse = await generateModelResponse({prompt, baseURL, modelName})
          // console.log('modelResponse', modelResponse)
          lastResponse = modelResponse.text
          const judgment = parseJudgment(lastResponse, prompts)
          const promptIds = prompts.map((p) => {
            return p.id
          })
          await judgeStoreJudgment(article.id, article.articleTitle, judgment, modelId, promptIds)
          tokenUse.push({
            // articleId: article.id,
            promptTokens: modelResponse.usage.promptTokens,
            completionTokens: modelResponse.usage.completionTokens,
            totalTokens: modelResponse.usage.totalTokens,
          })
          return judgment
        } catch (error: unknown) {
          lastError = error instanceof Error ? error.message : 'Unknown error'
          // console.error(`${article.id} | Attempt ${attempts} failed schema validation: ${lastError}`)

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
  // console.log('tokenUse:', tokenUse)
  await judgeStoreTokenUse(tokenUse, sessionId, {startedAt, finishedAt, duration}, judgmentsJobId)
}
