import {createSignal, For, Show, splitProps} from 'solid-js'

import {Popover, PopoverContent, PopoverTrigger} from '../../../../../components/ui/popover.tsx'
import {cn} from '../../../../../utils/cn.ts'
import type {JudgmentJobStopConditions} from '../../../../../utils/judgmentJobStopConditions.ts'
import {getJudgmentJobStopConditionChips} from '../jobsPageShared'
import {JobStopConditionMenu} from './jobRunControl/jobStopConditionMenu.tsx'

type JobRunControlStatus = 'paused' | 'running'

type JobRunControlProps = {
  conditions: JudgmentJobStopConditions
  isMainDisabled: boolean
  jobId: string
  mainLabel: string
  onMainAction: () => void
  onStopConditionsSaved: () => Promise<unknown>
  resumeBlockedHint: string | null
  status: JobRunControlStatus
}

const runControlToneClasses: Record<JobRunControlStatus, {chevron: string; main: string}> = {
  paused: {
    chevron: 'border-l border-green-700 bg-green-600 hover:bg-green-700',
    main: 'bg-green-600 hover:bg-green-700',
  },
  running: {
    chevron: 'border-l border-yellow-700 bg-yellow-600 hover:bg-yellow-700',
    main: 'bg-yellow-600 hover:bg-yellow-700',
  },
}

const menuActionLabels: Record<JobRunControlStatus, string> = {paused: 'Resume', running: 'Pause now'}

export const JobRunControl = (props: JobRunControlProps) => {
  const [local] = splitProps(props, [
    'conditions',
    'isMainDisabled',
    'jobId',
    'mainLabel',
    'onMainAction',
    'onStopConditionsSaved',
    'resumeBlockedHint',
    'status',
  ])
  const [isMenuOpen, setIsMenuOpen] = createSignal(false)
  const tone = () => {
    return runControlToneClasses[local.status]
  }
  const resumeHint = () => {
    return local.status === 'paused' ? local.resumeBlockedHint : null
  }

  return (
    <div class="flex flex-wrap items-center justify-end gap-2">
      <div class="inline-flex">
        <button
          type="button"
          class={cn(
            'rounded-l-md px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50',
            tone().main,
          )}
          disabled={local.isMainDisabled}
          title={resumeHint() ?? undefined}
          onClick={() => {
            local.onMainAction()
          }}
        >
          {local.mainLabel}
        </button>
        <Popover open={isMenuOpen()} onOpenChange={setIsMenuOpen} placement="bottom-end">
          <PopoverTrigger
            aria-label="Pause options"
            class={cn('inline-flex items-center rounded-r-md px-2 py-2 text-white', tone().chevron)}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="size-4"
              aria-hidden="true"
            >
              <path d="M6 9l6 6l6 -6" />
            </svg>
          </PopoverTrigger>
          <PopoverContent aria-label="Pause options" class="w-80 p-1.5">
            <JobStopConditionMenu
              conditions={local.conditions}
              isMainDisabled={local.isMainDisabled}
              jobId={local.jobId}
              mainActionLabel={menuActionLabels[local.status]}
              resumeHint={resumeHint()}
              onMainAction={() => {
                setIsMenuOpen(false)
                local.onMainAction()
              }}
              onSaved={local.onStopConditionsSaved}
            />
          </PopoverContent>
        </Popover>
      </div>
      <Show when={getJudgmentJobStopConditionChips(local.conditions).length > 0}>
        <div aria-label="Active stop conditions" class="flex flex-wrap items-center gap-1">
          <For each={getJudgmentJobStopConditionChips(local.conditions)}>
            {(chip) => {
              return (
                <span class="inline-flex rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs text-gray-700">
                  {chip}
                </span>
              )
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}
