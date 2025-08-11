import {Link} from '@tanstack/solid-router'
import {Show} from 'solid-js'
import type {User} from '../types/user'

interface NavigationProps {
  user: User | undefined
  onSignOut: () => void
}

export const Navigation = (props: NavigationProps) => {
  return (
    <>
      <div class="p-2 flex gap-2">
        <Link to="/" class="[&.active]:font-bold">
          Home
        </Link>{' '}
        <Link to="/articles" class="[&.active]:font-bold">
          Articles
        </Link>
        <Link to="/projects" class="[&.active]:font-bold">
          Projects
        </Link>
        <Link to="/about" class="[&.active]:font-bold">
          About
        </Link>
        <div class="flex items-center space-x-4 ml-auto">
          <Link
            to="/settings"
            class="text-sm text-primary hover:text-primary/80 font-medium"
          >
            Settings
          </Link>
          <Show when={props.user?.role === 'admin'}>
            <Link
              to="/admin/users"
              class="text-sm text-primary hover:text-primary/80 font-medium"
            >
              Users
            </Link>
          </Show>
          <Show when={props.user}>
            <span class="text-sm text-muted-foreground">
              {props.user?.email}
            </span>
          </Show>
          <button
            onClick={() => {
              void props.onSignOut()
            }}
            class="text-primary hover:text-primary/80 text-sm font-medium cursor-pointer"
          >
            Sign Out
          </button>
        </div>
      </div>
      <hr />
    </>
  )
}