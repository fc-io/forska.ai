import {useQuery} from '@tanstack/solid-query'
import {createEffect, createSignal, Match, on, Show, Suspense, Switch} from 'solid-js'

import {apiClient} from '../../../../../../services/apiClient.ts'
import {
  type JudgmentsJobStopConditionsPatch,
  updateJudgmentsJobStopConditions,
} from '../../../../../../services/judgmentsJobsService'
import {handleApiResponse} from '../../../../../../services/utils/handleApiResponse'
import {
  type JudgmentJobStopConditions,
  maxJudgmentJobStopAfterArticles,
  maxJudgmentJobStopAfterTotalTokens,
} from '../../../../../../utils/judgmentJobStopConditions.ts'
import {formatJudgmentJobStopTime, formatNumber, getActionErrorMessage} from '../../jobsPageShared'
import {StopConditionCustomView} from './jobStopConditionCustomView.tsx'
import {StopConditionDeadlinePicker} from './jobStopConditionDeadlinePicker.tsx'
import {
  getArticleCapDefaults,
  getDeadlineDefaults,
  getDefaultPickDateTime,
  getServerClockOffsetMs,
  getTokenBudgetDefaults,
  type StopConditionDefaultsData,
} from './jobStopConditionDefaults.ts'
import {
  StopConditionMenuHeader,
  StopConditionMenuItem,
  stopConditionMenuItemSelector,
  StopConditionMenuSeparator,
} from './jobStopConditionMenuItems.tsx'
import {
  StopConditionCountOptions,
  StopConditionDeadlineOptions,
  StopConditionMenuNote,
} from './jobStopConditionMenuViews.tsx'

type StopConditionMenuView =
  | 'articles'
  | 'articlesCustom'
  | 'deadline'
  | 'deadlinePick'
  | 'root'
  | 'tokens'
  | 'tokensCustom'

type StopConditionMenuKeyAction = 'back' | 'next' | 'open' | 'previous' | null

type StopConditionDefaults = (StopConditionDefaultsData & {serverClockOffsetMs: number}) | null

type JobStopConditionMenuProps = {
  conditions: JudgmentJobStopConditions
  isMainDisabled: boolean
  jobId: string
  mainActionLabel: string
  onMainAction: () => void
  onSaved: () => Promise<unknown>
  resumeHint: string | null
}

const parentViews: Record<StopConditionMenuView, StopConditionMenuView> = {
  articles: 'root',
  articlesCustom: 'articles',
  deadline: 'root',
  deadlinePick: 'deadline',
  root: 'root',
  tokens: 'root',
  tokensCustom: 'tokens',
}

const fetchStopConditionDefaults = async (jobId: string): Promise<StopConditionDefaults> => {
  const response = await apiClient.api.judgmentsjobs({id: jobId})['stop-condition-defaults'].get()
  const body = handleApiResponse(response, 'Failed to load stop condition defaults') as {
    data?: StopConditionDefaultsData
  } | null
  const data = body?.data

  return data ? {...data, serverClockOffsetMs: getServerClockOffsetMs(data.serverNow, Date.now())} : null
}

const getServerNow = (defaults: StopConditionDefaults | undefined) => {
  return new Date(Date.now() + (defaults?.serverClockOffsetMs ?? 0))
}

const formatOptionalCount = (value: number | null) => {
  return value === null ? 'off' : formatNumber(value)
}

const getArticleCapCaption = (defaults: StopConditionDefaults | undefined) => {
  return defaults
    ? `${formatNumber(defaults.admittedArticleCount)} admitted of ${formatNumber(defaults.articleCount)} articles`
    : 'Suggestions are unavailable.'
}

const getTokenBudgetCaption = (defaults: StopConditionDefaults | undefined) => {
  return defaults ? `Current total: ${formatNumber(defaults.totalTokens)} tokens` : 'Suggestions are unavailable.'
}

const getMenuKeyAction = (event: KeyboardEvent, view: StopConditionMenuView): StopConditionMenuKeyAction => {
  const target = event.target instanceof HTMLElement ? event.target : null
  const isEditable = target?.closest('input, select, textarea') != null
  const canGoBack = view !== 'root' && target?.closest('[data-scope="date-picker"]') == null
  const keyActions: Record<string, StopConditionMenuKeyAction> = {
    ArrowDown: 'next',
    ArrowLeft: canGoBack ? 'back' : null,
    ArrowRight: target?.hasAttribute('data-stop-menu-submenu') ? 'open' : null,
    ArrowUp: 'previous',
    Backspace: canGoBack ? 'back' : null,
  }

  return event.defaultPrevented || isEditable ? null : (keyActions[event.key] ?? null)
}

const moveMenuFocus = (panel: HTMLElement, offset: number) => {
  const items = Array.from(panel.querySelectorAll<HTMLElement>(stopConditionMenuItemSelector))
  const currentIndex = items.findIndex((item) => {
    return item === document.activeElement
  })
  const nextIndex = currentIndex === -1 ? 0 : (currentIndex + offset + items.length) % items.length

  items[nextIndex]?.focus()
}

const focusFirstMenuControl = (panel: HTMLElement | undefined) => {
  const target =
    panel?.querySelector<HTMLElement>(`input, ${stopConditionMenuItemSelector}:not([data-stop-menu-back])`)
    ?? panel?.querySelector<HTMLElement>('[data-stop-menu-back]')

  target?.focus()
}

export const JobStopConditionMenu = (props: JobStopConditionMenuProps) => {
  const [view, setView] = createSignal<StopConditionMenuView>('root')
  const [isSaving, setIsSaving] = createSignal(false)
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null)
  const [panel, setPanel] = createSignal<HTMLDivElement>()
  const defaultsQuery = useQuery(() => {
    return {
      queryKey: ['judgments-job-stop-condition-defaults', props.jobId],
      queryFn: () => {
        return fetchStopConditionDefaults(props.jobId).catch(() => {
          return null
        })
      },
      refetchOnWindowFocus: false,
      staleTime: 0,
    }
  })
  const navigate = (nextView: StopConditionMenuView) => {
    setErrorMessage(null)
    setView(nextView)
  }
  const goBack = () => {
    navigate(parentViews[view()])
  }
  const save = async (patch: JudgmentsJobStopConditionsPatch) => {
    const jobId = props.jobId
    const onSaved = props.onSaved

    setIsSaving(true)
    setErrorMessage(null)
    const failure = await updateJudgmentsJobStopConditions(jobId, patch)
      .then(() => {
        return onSaved()
      })
      .then(
        () => {
          return null
        },
        (error: unknown) => {
          return getActionErrorMessage(error, 'Failed to save the stop condition')
        },
      )
    setIsSaving(false)

    return failure === null ? setView('root') : setErrorMessage(failure)
  }
  const handleKeyDown = (event: KeyboardEvent) => {
    const action = getMenuKeyAction(event, view())
    const panelElement = panel()
    const actions: Record<Exclude<StopConditionMenuKeyAction, null>, () => void> = {
      back: goBack,
      next: () => {
        return panelElement ? moveMenuFocus(panelElement, 1) : undefined
      },
      open: () => {
        return event.target instanceof HTMLElement ? event.target.click() : undefined
      },
      previous: () => {
        return panelElement ? moveMenuFocus(panelElement, -1) : undefined
      },
    }

    if (action !== null) {
      event.preventDefault()
      actions[action]()
    }
  }

  createEffect(
    on(
      view,
      () => {
        const panelElement = panel()

        queueMicrotask(() => {
          focusFirstMenuControl(panelElement)
        })
      },
      {defer: true},
    ),
  )

  return (
    <div ref={setPanel} role="menu" aria-label="Pause options" class="space-y-0.5" onKeyDown={handleKeyDown}>
      <Switch>
        <Match when={view() === 'root'}>
          <StopConditionMenuItem
            disabled={props.isMainDisabled}
            label={props.mainActionLabel}
            onSelect={() => {
              props.onMainAction()
            }}
          />
          <Show when={props.resumeHint}>
            {(hint) => {
              return <p class="px-2 pb-1 text-xs text-amber-800">{hint()}</p>
            }}
          </Show>
          <StopConditionMenuSeparator />
          <StopConditionMenuItem
            hasSubmenu
            label="Pause after … articles"
            value={formatOptionalCount(props.conditions.stopAfterArticles)}
            onSelect={() => {
              navigate('articles')
            }}
          />
          <StopConditionMenuItem
            checked={props.conditions.stopWhenHumanAnsweredDone}
            disabled={isSaving()}
            label="Pause when human-answered articles are done"
            role="menuitemcheckbox"
            onSelect={() => {
              const stopWhenHumanAnsweredDone = !props.conditions.stopWhenHumanAnsweredDone

              return void save({stopWhenHumanAnsweredDone})
            }}
          />
          <StopConditionMenuItem
            hasSubmenu
            label="Pause after … tokens"
            value={formatOptionalCount(props.conditions.stopAfterTotalTokens)}
            onSelect={() => {
              navigate('tokens')
            }}
          />
          <StopConditionMenuItem
            hasSubmenu
            label="Pause at …"
            value={props.conditions.stopAt ? formatJudgmentJobStopTime(props.conditions.stopAt, new Date()) : 'off'}
            onSelect={() => {
              navigate('deadline')
            }}
          />
        </Match>
        <Match when={view() === 'articles'}>
          <StopConditionMenuHeader label="Pause after articles" onBack={goBack} />
          <Suspense fallback={<StopConditionMenuNote text="Loading suggestions…" />}>
            <StopConditionCountOptions
              caption={getArticleCapCaption(defaultsQuery.data)}
              currentValue={props.conditions.stopAfterArticles}
              isSaving={isSaving()}
              items={defaultsQuery.data ? getArticleCapDefaults(defaultsQuery.data) : []}
              onClear={() => {
                return void save({stopAfterArticles: null})
              }}
              onCustom={() => {
                navigate('articlesCustom')
              }}
              onSelect={(stopAfterArticles) => {
                return void save({stopAfterArticles})
              }}
            />
          </Suspense>
        </Match>
        <Match when={view() === 'articlesCustom'}>
          <StopConditionMenuHeader label="Custom article cap" onBack={goBack} />
          <StopConditionCustomView
            caption="Admit at most this many articles, then finish their prompts."
            inputLabel="Pause after this many articles"
            isSaving={isSaving()}
            label="Articles"
            maxValue={maxJudgmentJobStopAfterArticles}
            value={props.conditions.stopAfterArticles}
            onBack={goBack}
            onSave={(stopAfterArticles) => {
              return void save({stopAfterArticles})
            }}
          />
        </Match>
        <Match when={view() === 'tokens'}>
          <StopConditionMenuHeader label="Pause after tokens" onBack={goBack} />
          <Suspense fallback={<StopConditionMenuNote text="Loading suggestions…" />}>
            <StopConditionCountOptions
              caption={getTokenBudgetCaption(defaultsQuery.data)}
              currentValue={props.conditions.stopAfterTotalTokens}
              isSaving={isSaving()}
              items={defaultsQuery.data ? getTokenBudgetDefaults(defaultsQuery.data) : []}
              onClear={() => {
                return void save({stopAfterTotalTokens: null})
              }}
              onCustom={() => {
                navigate('tokensCustom')
              }}
              onSelect={(stopAfterTotalTokens) => {
                return void save({stopAfterTotalTokens})
              }}
            />
          </Suspense>
        </Match>
        <Match when={view() === 'tokensCustom'}>
          <StopConditionMenuHeader label="Custom token budget" onBack={goBack} />
          <StopConditionCustomView
            caption="Stop admitting work once the job has used this many tokens."
            inputLabel="Pause after this many tokens"
            isSaving={isSaving()}
            label="Tokens"
            maxValue={maxJudgmentJobStopAfterTotalTokens}
            value={props.conditions.stopAfterTotalTokens}
            onBack={goBack}
            onSave={(stopAfterTotalTokens) => {
              return void save({stopAfterTotalTokens})
            }}
          />
        </Match>
        <Match when={view() === 'deadline'}>
          <StopConditionMenuHeader label="Pause at" onBack={goBack} />
          <Suspense fallback={<StopConditionMenuNote text="Loading suggestions…" />}>
            <StopConditionDeadlineOptions
              currentValue={props.conditions.stopAt}
              isSaving={isSaving()}
              items={getDeadlineDefaults(getServerNow(defaultsQuery.data))}
              now={getServerNow(defaultsQuery.data)}
              onClear={() => {
                return void save({stopAt: null})
              }}
              onPick={() => {
                navigate('deadlinePick')
              }}
              onSelect={(label) => {
                const stopAt = getDeadlineDefaults(getServerNow(defaultsQuery.data)).find((item) => {
                  return item.label === label
                })?.value

                return stopAt ? void save({stopAt: stopAt.toISOString()}) : undefined
              }}
            />
          </Suspense>
        </Match>
        <Match when={view() === 'deadlinePick'}>
          <StopConditionMenuHeader label="Pick date and time" onBack={goBack} />
          <Suspense fallback={<StopConditionMenuNote text="Loading…" />}>
            <StopConditionDeadlinePicker
              initial={getDefaultPickDateTime(getServerNow(defaultsQuery.data), props.conditions.stopAt)}
              isSaving={isSaving()}
              now={() => {
                return getServerNow(defaultsQuery.data)
              }}
              onBack={goBack}
              onSave={(stopAt) => {
                return void save({stopAt: stopAt.toISOString()})
              }}
            />
          </Suspense>
        </Match>
      </Switch>
      <Show when={errorMessage()}>
        {(message) => {
          return <StopConditionMenuNote text={message()} tone="error" />
        }}
      </Show>
    </div>
  )
}
