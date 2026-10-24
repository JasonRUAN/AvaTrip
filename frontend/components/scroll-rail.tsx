"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";

/**
 * 自绘滚动条。系统滚动条要真正滚动才浮出，
 * 这里鼠标一进列表就亮出滑块，平时只留一条浅槽。
 */
export function ScrollRail({
  active,
  scrollerRef,
}: {
  active: boolean;
  scrollerRef: RefObject<HTMLElement | null>;
}) {
  const [thumb, setThumb] = useState({ top: 0, height: 28 });
  const [hot, setHot] = useState(false);

  const measure = useCallback(() => {
    const el = scrollerRef.current;
    if (!el || !active) return;
    const { scrollHeight, clientHeight, scrollTop } = el;
    if (scrollHeight <= clientHeight + 1) return;
    const rail = Math.max(clientHeight - 12, 1);
    const height = Math.min(rail, Math.max(28, (clientHeight / scrollHeight) * rail));
    const maxTop = Math.max(rail - height, 0);
    const range = scrollHeight - clientHeight;
    const top = range <= 0 ? 0 : (scrollTop / range) * maxTop;
    setThumb((prev) =>
      Math.abs(prev.top - top) < 0.5 && Math.abs(prev.height - height) < 0.5
        ? prev
        : { top, height }
    );
  }, [active, scrollerRef]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !active) return;
    measure();
    const show = () => setHot(true);
    const hide = () => setHot(false);
    el.addEventListener("pointerenter", show);
    el.addEventListener("pointerleave", hide);
    el.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      el.removeEventListener("pointerenter", show);
      el.removeEventListener("pointerleave", hide);
      el.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [active, measure, scrollerRef]);

  if (!active) return null;

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-y-1.5 right-1 w-2 rounded-full bg-brand-200"
    >
      <div
        className={`absolute inset-x-0 rounded-full bg-brand-600 ${
          hot ? "opacity-100" : "opacity-0"
        }`}
        style={{ top: thumb.top, height: thumb.height }}
      />
    </div>
  );
}
