import * as React from "react"
import { cn } from "@/lib/utils"
import { Button, buttonVariants } from "@/components/ui/button"
import type { VariantProps } from "class-variance-authority"

function InputGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-group"
      className={cn("group/input-group relative flex items-center rounded-lg border border-input bg-background transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50", className)}
      {...props}
    />
  )
}

function InputGroupInput({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      data-slot="input-group-input"
      className={cn("flex h-9 flex-1 bg-transparent px-3 py-1 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50", className)}
      {...props}
    />
  )
}

function InputGroupAddon({
  className,
  align: _align,
  ...props
}: React.ComponentProps<"div"> & { align?: string }) {
  return (
    <div
      data-slot="input-group-addon"
      className={cn("flex shrink-0 items-center px-1", className)}
      {...props}
    />
  )
}

function InputGroupButton({
  className,
  variant,
  size,
  render: _render,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & { render?: React.ReactElement }) {
  return (
    <Button
      data-slot="input-group-button"
      variant={variant ?? "ghost"}
      size={size ?? "icon-xs"}
      className={cn(className)}
      {...props}
    />
  )
}

function InputGroupText({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="input-group-text"
      className={cn("flex items-center px-3 text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export { InputGroup, InputGroupInput, InputGroupAddon, InputGroupButton, InputGroupText }
