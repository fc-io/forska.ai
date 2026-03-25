import {type JSX} from 'solid-js'

export const Login = (): JSX.Element => {
  return (
    <div class="min-h-screen bg-gray-50 flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <div class="sm:mx-auto sm:w-full sm:max-w-lg">
        <div class="bg-white py-10 px-8 shadow-sm rounded-lg border border-gray-200 text-center space-y-4">
          <h1 class="text-3xl font-bold text-gray-900">Local-first mode</h1>
          <p class="text-sm text-gray-600">
            Authentication is removed. The app now opens directly with the local user profile.
          </p>
          <a
            href="/"
            class="inline-flex items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Go to app
          </a>
        </div>
      </div>
    </div>
  )
}
