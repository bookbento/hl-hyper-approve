import { motion, useReducedMotion } from "framer-motion";
import type { ReactNode } from "react";

type Props = {
  children: ReactNode;
  className?: string;
  /** seconds */
  delay?: number;
  /** px to travel up from */
  distance?: number;
  blur?: boolean;
};

/** Fades + slides its children in on mount (React Bits "AnimatedContent"). */
export default function AnimatedContent({ children, className, delay = 0, distance = 14, blur = false }: Props) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: distance, ...(blur ? { filter: "blur(6px)" } : {}) }}
      animate={{ opacity: 1, y: 0, ...(blur ? { filter: "blur(0px)" } : {}) }}
      transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1], delay }}
    >
      {children}
    </motion.div>
  );
}
