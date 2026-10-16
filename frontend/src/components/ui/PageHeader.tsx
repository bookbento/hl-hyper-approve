import type { ReactNode } from "react";
import { AnimatedContent, BlurText } from "../motion";

type Props = {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  /** buttons on the right */
  actions?: ReactNode;
  /** tabs / filters row under the title */
  children?: ReactNode;
};

/** Page title block shared by the admin and list pages. */
export default function PageHeader({ title, description, icon, actions, children }: Props) {
  return (
    <header className="mb-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex items-start gap-3">
          {icon && (
            <span className="mt-1 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-100 [&_svg]:h-5 [&_svg]:w-5">
              {icon}
            </span>
          )}
          <div>
            <BlurText as="h1" text={title} className="text-2xl font-semibold tracking-tight text-gray-900 sm:text-[28px]" />
            {description && (
              <AnimatedContent delay={0.1} distance={6}>
                <p className="mt-1 text-sm text-gray-500">{description}</p>
              </AnimatedContent>
            )}
          </div>
        </div>
        {actions && (
          <AnimatedContent delay={0.08} distance={8} className="flex flex-wrap items-center gap-2">
            {actions}
          </AnimatedContent>
        )}
      </div>
      {children && <div className="mt-5">{children}</div>}
    </header>
  );
}
