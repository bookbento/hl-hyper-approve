import type { ReactNode } from "react";

type Props = {
  children: ReactNode;
  className?: string;
  /** base text colour + highlight colour */
  base?: string;
  shine?: string;
};

/** Text with a light sweeping across it (React Bits "ShinyText"). CSS only. */
export default function ShinyText({
  children,
  className = "",
  base = "rgb(255 255 255 / 0.65)",
  shine = "rgb(255 255 255 / 1)",
}: Props) {
  return (
    <span
      className={`inline-block bg-clip-text text-transparent animate-rb-shine ${className}`}
      style={{
        backgroundImage: `linear-gradient(110deg, ${base} 35%, ${shine} 50%, ${base} 65%)`,
        backgroundSize: "250% 100%",
      }}
    >
      {children}
    </span>
  );
}
