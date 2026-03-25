import * as React from "react"
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

const variantStyles = {
  default: "bg-primary text-primary-foreground shadow-[0_4px_14px_0_hsl(var(--primary)/0.25)] hover:shadow-[0_6px_20px_0_hsl(var(--primary)/0.3)] hover:-translate-y-0.5",
  secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
  outline: "border-2 border-input bg-background hover:bg-accent hover:text-accent-foreground",
  ghost: "hover:bg-accent hover:text-accent-foreground",
  link: "text-primary underline-offset-4 hover:underline",
  destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
} as const;

const sizeStyles = {
  default: "h-11 px-5 py-2",
  sm: "h-9 rounded-lg px-3",
  lg: "h-12 rounded-xl px-8 text-base",
  icon: "h-11 w-11",
} as const;

const baseStyles = "inline-flex items-center justify-center whitespace-nowrap rounded-xl text-sm font-semibold transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98]";

function buttonVariants({ variant = "default", size = "default", className = "" }: { variant?: keyof typeof variantStyles; size?: keyof typeof sizeStyles; className?: string } = {}) {
  return cn(baseStyles, variantStyles[variant], sizeStyles[size], className);
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variantStyles;
  size?: keyof typeof sizeStyles;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={buttonVariants({ variant, size, className })}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
