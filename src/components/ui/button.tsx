import * as ButtonPrimitive from '@kobalte/core/button'
import type {PolymorphicProps} from '@kobalte/core/polymorphic'
import type {VariantProps} from 'class-variance-authority'
import {cva} from 'class-variance-authority'
import type {JSX, ValidComponent} from 'solid-js'
import {splitProps} from 'solid-js'

import {cn} from '../../utils/cn'

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed',
  {
    variants: {
      variant: {
        default: 'bg-blue-600 text-white hover:bg-blue-700',
        destructive: 'bg-red-600 text-white hover:bg-red-700',
        outline:
          'border border-gray-300 bg-white hover:bg-gray-50 text-gray-900',
        secondary: 'bg-gray-100 text-gray-900 hover:bg-gray-200',
        ghost: 'hover:bg-gray-100 text-gray-700',
        link: 'text-blue-600 underline-offset-4 hover:underline',
      },
      size: {
        default: 'px-4 py-2',
        sm: 'px-3 py-1 text-xs',
        lg: 'px-8 py-3',
        icon: 'size-10',
      },
    },
    defaultVariants: {variant: 'default', size: 'default'},
  },
)

type ButtonProps<T extends ValidComponent = 'button'> =
  ButtonPrimitive.ButtonRootProps<T>
    & VariantProps<typeof buttonVariants> & {
      class?: string | undefined
      children?: JSX.Element
    }

const Button = <T extends ValidComponent = 'button'>(
  props: PolymorphicProps<T, ButtonProps<T>>,
) => {
  const [local, others] = splitProps(props as ButtonProps, [
    'variant',
    'size',
    'class',
  ])
  return (
    <ButtonPrimitive.Root
      class={cn(
        buttonVariants({variant: local.variant, size: local.size}),
        local.class,
      )}
      {...others}
    />
  )
}

export {Button, buttonVariants}
export type {ButtonProps}
