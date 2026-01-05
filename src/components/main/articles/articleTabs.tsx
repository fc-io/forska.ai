import {Link} from '@tanstack/solid-router'
import {Show} from 'solid-js'

type ArticleTabsProps = {
  activeTab: 'summary' | 'fulltext'
  hasFullText: boolean
  fullTextPDF?: string | null
  basePath: string
  linkParams?: Record<string, string>
}

export const ArticleTabs = (props: ArticleTabsProps) => {
  const tabClasses = (isActive: boolean) => {
    const base = 'px-4 py-2 text-sm font-medium border-b-2 transition-colors'
    if (isActive) {
      return `${base} border-blue-600 text-blue-600`
    }
    return `${base} border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300`
  }

  return (
    <div class="flex items-center justify-between border-b border-gray-200 bg-white rounded-t-lg">
      <div class="flex">
        <Link to={props.basePath} params={props.linkParams} class={tabClasses(props.activeTab === 'summary')}>
          Title & Summary
        </Link>
        <Show when={props.hasFullText}>
          <Link
            to={`${props.basePath}/fulltext`}
            params={props.linkParams}
            class={tabClasses(props.activeTab === 'fulltext')}
          >
            Full Text
          </Link>
        </Show>
      </div>

      <Show when={props.fullTextPDF}>
        <div class="pr-4">
          <a
            href={`/${props.fullTextPDF}`}
            download=""
            class="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              stroke-width="1.5"
              stroke="currentColor"
              class="w-4 h-4"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"
              />
            </svg>
            Download PDF
          </a>
        </div>
      </Show>
    </div>
  )
}
