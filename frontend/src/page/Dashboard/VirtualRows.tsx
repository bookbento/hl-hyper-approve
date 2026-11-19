import type { ReactNode, RefObject } from "react";
import type { VirtualItem } from "@tanstack/react-virtual";
import { useVirtualRows, type Enter } from "./useVirtualRows";

type Props = {
  count: number;
  getKey: (index: number) => number | string;
  estimateSize: number;
  resetKey: unknown;
  /** element that holds the rows; it is rendered by the parent (tbody / card list) */
  listRef: RefObject<HTMLElement | null>;
  renderRow: (item: VirtualItem, enter: Enter, measureRef: (el: Element | null) => void) => ReactNode;
  renderSpacer: (height: number, where: "top" | "bottom") => ReactNode;
};

/**
 * Owns the virtualizer so that scrolling re-renders only the visible rows.
 * With the virtualizer state in Dashboard, every scroll step re-rendered the
 * whole dashboard (100-190 ms per step on "All").
 */
export default function VirtualRows({ count, getKey, estimateSize, resetKey, listRef, renderRow, renderSpacer }: Props) {
  const { items, padTop, padBottom, measureRef, enterFor } = useVirtualRows({
    count,
    getKey,
    estimateSize,
    resetKey,
    listRef,
  });
  return (
    <>
      {padTop > 0 && renderSpacer(padTop, "top")}
      {items.map((item) => renderRow(item, enterFor(item.key, item.index), measureRef))}
      {padBottom > 0 && renderSpacer(padBottom, "bottom")}
    </>
  );
}
