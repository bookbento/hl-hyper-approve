// Button classes for the brand UI. A class helper (not a component) so existing
// <button>/<a>/<label> elements can adopt it without changing their markup.
type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-xl font-medium whitespace-nowrap " +
  "transition-[background-color,border-color,box-shadow,color,transform] duration-200 " +
  "active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 " +
  "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-500/20";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand-700 text-white shadow-[0_8px_20px_-10px_rgb(24_62_51_/_0.7)] hover:bg-brand-600",
  secondary: "border border-gray-200 bg-white text-gray-700 shadow-sm hover:border-brand-200 hover:bg-brand-50/60",
  ghost: "text-gray-600 hover:bg-gray-100 hover:text-gray-900",
  danger: "border border-red-200 bg-red-50 text-red-700 hover:bg-red-100",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-10 px-4 text-sm",
};

export function btn(variant: Variant = "secondary", size: Size = "md", extra = ""): string {
  return [BASE, VARIANTS[variant], SIZES[size], extra].filter(Boolean).join(" ");
}
