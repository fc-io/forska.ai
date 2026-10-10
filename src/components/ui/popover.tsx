import type {PolymorphicProps} from '@kobalte/core/polymorphic'
import * as PopoverPrimitive from '@kobalte/core/popover'
import type {Component, ValidComponent} from 'solid-js'
import {splitProps} from 'solid-js'

import {cn} from '../../utils/cn'

const PopoverTrigger = PopoverPrimitive.Trigger

const Popover: Component<PopoverPrimitive.PopoverRootProps> = (props) => {
  return <PopoverPrimitive.Root gutter={4} {...props} />
}

type PopoverContentProps<T extends ValidComponent = 'div'> = PopoverPrimitive.PopoverContentProps<T> & {
  class?: string | undefined
}

const PopoverContent = <T extends ValidComponent = 'div'>(props: PolymorphicProps<T, PopoverContentProps<T>>) => {
  const [local, others] = splitProps(props as PopoverContentProps, ['class'])
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        class={cn(
          'z-50 w-72 rounded-md border border-input bg-white p-3 text-gray-900 shadow-xl outline-none',
          local.class,
        )}
        {...others}
      />
    </PopoverPrimitive.Portal>
  )
}

export {Popover, PopoverContent, PopoverTrigger}
