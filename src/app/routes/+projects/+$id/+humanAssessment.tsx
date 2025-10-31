import {createFileRoute, Link} from '@tanstack/solid-router'
import {For, createMemo, createSignal} from 'solid-js'

import {Button} from '../../../../components/ui/button'

type PromptAnswer = {
  prompt: string
  answer: 'yes' | 'no' | 'unsure' | null
  notes: string
}

const placeholderTitle = 'Article title will appear here'
const placeholderAbstract =
  "Abstract text will appear here. This is placeholder content to show where the article's abstract will be displayed for human assessment."

const defaultPrompts = [
  'Is this article relevant to the project objectives?',
  'Does the abstract indicate sufficient methodological rigor?',
  'Would you include this article for further review?'
]

export const HumanAssessment = () => {
  const params = Route.useParams()
  const projectId = createMemo(() => {
    return params().id
  })

  const [answers, setAnswers] = createSignal<PromptAnswer[]>(
    defaultPrompts.map((p) => {
      return {prompt: p, answer: null, notes: ''}
    }),
  )

  const setAnswer = (index: number, value: PromptAnswer['answer']) => {
    setAnswers((prev) => {
      const next = [...prev]
      next[index] = {...next[index], answer: value}
      return next
    })
  }

  const setNotes = (index: number, value: string) => {
    setAnswers((prev) => {
      const next = [...prev]
      next[index] = {...next[index], notes: value}
      return next
    })
  }

  const handleSubmit = () => {
    // No API integration yet – log locally
    console.log('Human assessment draft', {
      projectId: projectId(),
      answers: answers(),
    })
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <div class="flex justify-between items-center mb-6">
        <div class="flex items-center gap-4">
          <Button as={Link} to="/projects/$id" params={{id: projectId()}} variant="outline" size="sm">
            ← Back to Project
          </Button>
          <h1 class="text-2xl font-bold">Human Assessment</h1>
        </div>
      </div>

      <div class="max-w-5xl mx-auto">
        <div class="space-y-6">
          <section class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <div class="space-y-3">
              <div>
                <div class="text-sm text-gray-500 mb-1">Title</div>
                <div class="text-gray-900">{placeholderTitle}</div>
              </div>
              <div>
                <div class="text-sm text-gray-500 mb-1">Abstract</div>
                <div class="text-gray-900 leading-relaxed">
                  {placeholderAbstract}
                </div>
              </div>
            </div>
          </section>

          <section class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <div class="space-y-6">
              <For each={answers()}>
                {(item, i) => {
                  return (
                    <div class="border rounded-md p-4">
                      <div class="font-medium mb-3">{item.prompt}</div>
                      <div class="flex items-center gap-4 mb-3">
                        <label class="inline-flex items-center gap-2 text-sm">
                          <input
                            type="radio"
                            name={`answer-${i()}`}
                            class="accent-blue-600"
                            checked={item.answer === 'yes'}
                            onChange={() => {
                              return setAnswer(i(), 'yes')
                            }}
                          />
                          Yes
                        </label>
                        <label class="inline-flex items-center gap-2 text-sm">
                          <input
                            type="radio"
                            name={`answer-${i()}`}
                            class="accent-blue-600"
                            checked={item.answer === 'no'}
                            onChange={() => {
                              return setAnswer(i(), 'no')
                            }}
                          />
                          No
                        </label>
                        <label class="inline-flex items-center gap-2 text-sm">
                          <input
                            type="radio"
                            name={`answer-${i()}`}
                            class="accent-blue-600"
                            checked={item.answer === 'unsure'}
                            onChange={() => {
                              return setAnswer(i(), 'unsure')
                            }}
                          />
                          Unsure
                        </label>
                      </div>
                    </div>
                  )
                }}
              </For>
            </div>
          </section>

          <div class="flex items-center gap-3">
            <Button onClick={handleSubmit}>Submit Assessment (no-op)</Button>
          </div>
        </div>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/projects/$id/humanAssessment')({component: HumanAssessment})

