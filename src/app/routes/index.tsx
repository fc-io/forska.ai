import '../index.css'

import {createFileRoute} from '@tanstack/solid-router'
import {type JSX, Show} from 'solid-js'

import {Subheader} from '../../components/main/subheader'
import {UnassessedArticles} from '../../components/main/unassessedArticles'
import {AccessRequired} from '../../components/ui/access-required'
import {authStore} from '../../stores/authStore'

const Index = (): JSX.Element => {
  return (
    <Show
      when={!authStore.isLoading() && authStore.isAuthenticated()}
      fallback={<AccessRequired />}
    >
      <div class="min-h-screen bg-background text-foreground flex justify-center p-4">
        <div class="w-full space-y-8">
          <Subheader />
          <div class="bg-card text-card-foreground rounded-sm border shadow-lg p-8">
            <UnassessedArticles />
          </div>
        </div>
      </div>
    </Show>
  )
}

export const Route = createFileRoute('/')({component: Index})
