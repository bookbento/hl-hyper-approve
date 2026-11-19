import { useEffect, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { scrollParentOf } from "./useVirtualRows";

const SHOW_AFTER_PX = 1200;

/** Floating "back to top" for long lists ("All"); follows the list's scroll container. */
export default function BackToTop({ anchorRef }: { anchorRef: RefObject<HTMLElement | null> }) {
  const { t } = useTranslation("dashboard");
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);

  // the scroll container appears only once the list overflows, so re-resolve on scroll/resize
  useEffect(() => {
    const resolve = () => {
      const el = anchorRef.current;
      if (el) setScroller(scrollParentOf(el));
    };
    resolve();
    window.addEventListener("resize", resolve);
    const id = window.setInterval(resolve, 1000);
    return () => {
      window.removeEventListener("resize", resolve);
      window.clearInterval(id);
    };
  }, [anchorRef]);

  useEffect(() => {
    if (!scroller) return;
    const target: HTMLElement | Window =
      scroller === document.scrollingElement || scroller === document.documentElement ? window : scroller;
    const onScroll = () => {
      const top = target === window ? window.scrollY : (target as HTMLElement).scrollTop;
      setVisible(top > SHOW_AFTER_PX);
    };
    onScroll();
    target.addEventListener("scroll", onScroll, { passive: true });
    return () => target.removeEventListener("scroll", onScroll);
  }, [scroller]);

  if (!visible || !scroller) return null;
  const toTop = () => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Jump most of the way, smooth only the last screen: smooth-scrolling tens of
    // thousands of px through a virtual list mounts every row on the way.
    if (scroller.scrollTop > 800) scroller.scrollTop = 800;
    scroller.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  };
  return (
    <button
      type="button"
      onClick={toTop}
      className="animate-rb-row-in-lite fixed bottom-6 right-6 z-40 inline-flex items-center gap-2 rounded-full bg-[#183e33] px-4 py-2.5 text-sm font-medium text-white shadow-lg transition-transform hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00ffaa]"
    >
      <span aria-hidden="true">↑</span>
      {t("pager.backToTop")}
    </button>
  );
}
