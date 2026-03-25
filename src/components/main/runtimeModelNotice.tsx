import {Show} from 'solid-js'

type RuntimeModelNoticeValue = {message: string; tone: 'info' | 'warning'}

export const RuntimeModelNotice = (props: {class?: string; notice: RuntimeModelNoticeValue | null | undefined}) => {
  return (
    <Show when={props.notice}>
      {(notice) => {
        return (
          <div
            class={`${notice().tone === 'warning' ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-sky-200 bg-sky-50 text-sky-900'} rounded-md border px-3 py-2 text-sm ${props.class ?? ''}`}
          >
            {notice().message}
          </div>
        )
      }}
    </Show>
  )
}
