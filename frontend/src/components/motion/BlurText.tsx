import { motion, useReducedMotion } from "framer-motion";
import type { ElementType } from "react";

type Props = {
  text: string;
  as?: ElementType;
  className?: string;
  /** seconds between words */
  stagger?: number;
  delay?: number;
};

/**
 * Words fade in from a blur, one after another (React Bits "BlurText").
 * Splits on spaces, so Thai text without spaces animates as one block.
 */
export default function BlurText({ text, as: Tag = "p", className, stagger = 0.06, delay = 0 }: Props) {
  const reduce = useReducedMotion();
  if (reduce) return <Tag className={className}>{text}</Tag>;

  const words = text.split(/(\s+)/);
  return (
    <Tag className={className} aria-label={text}>
      {words.map((w, i) =>
        /^\s+$/.test(w) ? (
          w
        ) : (
          <motion.span
            key={`${w}-${i}`}
            aria-hidden="true"
            className="inline-block will-change-[transform,filter,opacity]"
            initial={{ opacity: 0, y: 8, filter: "blur(8px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1], delay: delay + (i / 2) * stagger }}
          >
            {w}
          </motion.span>
        )
      )}
    </Tag>
  );
}
