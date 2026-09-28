"use client";

import { Children, Fragment, isValidElement, useEffect, useRef } from "react";

/** Stagger helper: <div data-reveal="up" style={delay(0.1)} /> */
export const delay = (s: number) => ({ "--d": `${s}s` }) as React.CSSProperties;

/**
 * Headline whose words rise out of a mask when it scrolls into view.
 * The `data-reveal="words"` attribute is picked up by <ScrollReveal />.
 * Children can mix strings and <br /> elements.
 */
export function RevealText({
  as: Tag = "h2",
  children,
  d = 0,
  ...rest
}: {
  as?: "h1" | "h2" | "h3" | "p";
  children: React.ReactNode;
  d?: number;
} & React.HTMLAttributes<HTMLElement>) {
  let i = 0;
  const parts = Children.toArray(children).map((child, k) => {
    if (typeof child !== "string") return isValidElement(child) ? child : null;
    return (
      <Fragment key={k}>
        {child.split(/\s+/).filter(Boolean).map((w, j, arr) => (
          <Fragment key={j}>
            <span className="rw">
              <span style={{ "--i": i++ } as React.CSSProperties}>{w}</span>
            </span>
            {j < arr.length - 1 || /\s$/.test(child) ? " " : null}
          </Fragment>
        ))}
      </Fragment>
    );
  });

  return (
    <Tag data-reveal="words" style={delay(d)} {...rest}>
      {parts}
    </Tag>
  );
}

const clamp = (n: number, a = 0, b = 1) => Math.min(b, Math.max(a, n));

/** Paragraph whose words brighten one by one, driven by scroll position. */
export function ScrollWords({ children, className }: { children: string; className?: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const words = children.split(/\s+/).filter(Boolean);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const spans = Array.from(el.querySelectorAll<HTMLElement>(".sw"));
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      spans.forEach((s) => (s.style.opacity = "1"));
      return;
    }

    let raf = 0;
    const update = () => {
      raf = 0;
      const vh = window.innerHeight;
      const top = el.getBoundingClientRect().top;
      const start = vh * 0.92; // paragraph top here -> nothing lit
      const end = vh * 0.5; // paragraph top here -> fully lit
      const p = clamp((start - top) / (start - end));
      const n = spans.length;
      spans.forEach((s, i) => {
        s.style.opacity = String(0.18 + 0.82 * clamp(p * (n + 4) - i));
      });
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <p ref={ref} className={className}>
      {words.map((w, i) => (
        <Fragment key={i}>
          <span className="sw">{w}</span>
          {i < words.length - 1 ? " " : null}
        </Fragment>
      ))}
    </p>
  );
}
