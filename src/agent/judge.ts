import OpenAI from 'openai'
import type {ChatCompletion, ChatCompletionMessage} from 'openai/resources/chat/completions'

import * as schema from '../db/schema.ts'
import {judgeGetPrompt, type PromptForJudging} from './judge/judgeGetPrompt.ts'
import {parseJudgment} from './judge/judgeParseJudgment.ts'
import {AIResponseType} from './judge/judgeParseModelResponse.ts'
import {judgeStoreJudgment} from './judge/judgeStoreJudgment.ts'
import {judgeStoreTokenUse} from './judge/judgeStoreTokenUse.ts'
import {SYSTEM_PROMPT} from './judge/judgeSystemPrompt.ts'

const openAIClients = new Map<string, OpenAI>()

type ModelConfigInput = {modelId: string; modelName: string; baseURL: string}

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
  const client = new OpenAI({
    apiKey: 'fake_key',
    dangerouslyAllowBrowser: true,
    baseURL,
    timeout: 900_000, // 15 minutes
    maxRetries: 0, // Handle retries at application level
  })
  openAIClients.set(baseURL, client)
  return client
}

const normalizeVllmModelName = (name: string): string => {
  if (name.startsWith('./models/')) {
    return `/${name.slice(2)}`
  }
  if (name.startsWith('models/')) {
    return `/${name}`
  }
  return name
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
    const modelToUse = normalizeVllmModelName(modelName)
    const response = await client.chat.completions.create({
      model: modelToUse,
      messages: [
        {role: 'system', content: SYSTEM_PROMPT},
        {role: 'user', content: prompt},
      ],
      max_completion_tokens: 5000,
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
          model: modelToUse,
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

type ArticlesType = (typeof schema.articles.$inferSelect)[]

type PromptsType = PromptForJudging

const attemptJudgment = async ({
  prompt,
  baseURL,
  modelName,
  article,
  prompts,
  modelId,
}: {
  prompt: string
  baseURL: string
  modelName: string
  article: ArticlesType[number]
  prompts: PromptsType
  modelId: string
}): Promise<
  | {success: true; judgment: unknown; usage: {promptTokens: number; completionTokens: number; totalTokens: number}}
  | {success: false; error: string; lastResponse: string}
> => {
  const modelResponse = await generateModelResponse({prompt, baseURL, modelName}).catch((error) => {
    return {error: error instanceof Error ? error.message : 'Unknown error'}
  })

  if ('error' in modelResponse) {
    return {success: false, error: modelResponse.error, lastResponse: ''}
  }

  const parseResult = await Promise.resolve()
    .then(() => {
      return {success: true as const, value: parseJudgment(modelResponse.text, prompts)}
    })
    .catch((error) => {
      return {success: false as const, error: error instanceof Error ? error.message : 'Parse error'}
    })

  if (!parseResult.success) {
    return {success: false, error: parseResult.error, lastResponse: modelResponse.text}
  }

  const judgment = parseResult.value
  const promptIds = prompts.map((p) => {
    return p.id
  })

  await judgeStoreJudgment(article.id, article.articleTitle, judgment, modelId, promptIds)

  return {
    success: true,
    judgment,
    usage: {
      promptTokens: modelResponse.usage.promptTokens,
      completionTokens: modelResponse.usage.completionTokens,
      totalTokens: modelResponse.usage.totalTokens,
    },
  }
}
let abortCount = 0
let successCount = 0
let errorCount = 0

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
  judgmentsJobId: string
  modelConfig: ModelConfigInput
}): Promise<void> => {
  const {baseURL, modelName, modelId} = modelConfig
  if (!baseURL) {
    console.log('missing baseURL', modelConfig, baseURL)
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

      while (attempts <= MAX_RETRIES) {
        attempts += 1
        const result = await attemptJudgment({prompt, baseURL, modelName, article, prompts, modelId})

        if (result.success) {
          // console.log('judgment success')
          successCount += 1
          tokenUse.push(result.usage)
          return result.judgment
        } else {
          // console.log('judgment error')
          errorCount += 1

          lastError = result.error
          lastResponse = result.lastResponse

          if (attempts < MAX_RETRIES) {
            prompt = buildRetryPrompt(basePrompt, lastError, lastResponse)
          } else {
            abortCount += 1
            // console.error(`${article.id} | Aborting: ${lastError}`)
          }
        }
      }
    }),
  )
  const duration = performance.now() - startDuration
  const finishedAt = new Date().toISOString()
  // console.log('tokenUse:', tokenUse)
  if (
    (errorCount % 100 === 0 && errorCount > 0)
    || (abortCount % 100 === 0 && abortCount > 0)
    || successCount % 100 === 0
  ) {
    console.log(`Total: ${errorCount} errorCount,${abortCount} aborts, ${successCount} successes`)
  }
  await judgeStoreTokenUse(tokenUse, sessionId, {startedAt, finishedAt, duration}, judgmentsJobId).catch((error) => {
    console.error('judgeStoreTokenUse failed; continuing', error instanceof Error ? error.message : error)
  })
}
