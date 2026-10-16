import { Search } from "lucide-react";
import type { InputHTMLAttributes } from "react";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  wrapperClassName?: string;
};

/** Search box used in page toolbars. */
export default function SearchInput({ wrapperClassName = "", className = "", ...rest }: Props) {
  return (
    <div className={`relative w-full sm:max-w-sm ${wrapperClassName}`}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
      <input
        type="text"
        className={`h-10 w-full rounded-xl border border-gray-200 bg-white pl-9 pr-3 text-sm text-gray-900 outline-none transition-[border-color,box-shadow] placeholder:text-gray-400 hover:border-gray-300 focus:border-brand-500 focus:ring-4 focus:ring-brand-500/15 ${className}`}
        {...rest}
      />
    </div>
  );
}
