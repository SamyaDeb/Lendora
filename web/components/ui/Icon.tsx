import type {SVGProps} from "react";

/** 1.5px line icons in the landing page's style (round caps, currentColor). Decorative by default. */
const PATHS = {
  check: "M4 10.5l3.5 3.5L16 5.5",
  x: "M5 5l10 10M15 5L5 15",
  info: "M10 9v5M10 6.2v.1M10 17.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15z",
  alert: "M10 7v4M10 13.8v.1M8.7 3.3L2.4 14.5A1.5 1.5 0 0 0 3.7 16.7h12.6a1.5 1.5 0 0 0 1.3-2.2L11.3 3.3a1.5 1.5 0 0 0-2.6 0z",
  shield: "M10 2.5l6 2.2v4.6c0 3.8-2.6 6.6-6 8.2-3.4-1.6-6-4.4-6-8.2V4.7z",
  moon: "M16 12.3A6.5 6.5 0 0 1 7.7 4a6.5 6.5 0 1 0 8.3 8.3z",
  sun: "M10 13.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM10 1.8v1.7M10 16.5v1.7M18.2 10h-1.7M3.5 10H1.8M15.8 4.2l-1.2 1.2M5.4 14.6l-1.2 1.2M15.8 15.8l-1.2-1.2M5.4 5.4L4.2 4.2",
  clock: "M10 5.5V10l3 2M10 17.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15z",
  copy: "M7 7V4.5A1.5 1.5 0 0 1 8.5 3h7A1.5 1.5 0 0 1 17 4.5v7a1.5 1.5 0 0 1-1.5 1.5H13M4.5 7h7A1.5 1.5 0 0 1 13 8.5v7a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 15.5v-7A1.5 1.5 0 0 1 4.5 7z",
  external: "M11 3h6v6M17 3l-8 8M14 11.5v4A1.5 1.5 0 0 1 12.5 17h-8A1.5 1.5 0 0 1 3 15.5v-8A1.5 1.5 0 0 1 4.5 6h4",
  arrowUp: "M10 16V4M5 9l5-5 5 5",
  arrowDown: "M10 4v12M5 11l5 5 5-5",
  sort: "M7 8l3-3 3 3M7 12l3 3 3-3",
  chevronDown: "M5 7.5l5 5 5-5",
  chevronRight: "M7.5 5l5 5-5 5",
  search: "M9 15.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM13.8 13.8L17.5 17.5",
  wallet: "M3 6.5A2.5 2.5 0 0 1 5.5 4H15v3M3 6.5v8A2.5 2.5 0 0 0 5.5 17H17V7H5.5A2.5 2.5 0 0 1 3 4.5M13.5 12h.1",
  lock: "M5.5 9V6.5a4.5 4.5 0 0 1 9 0V9M4.5 9h11v8h-11z",
  pause: "M7.5 4.5v11M12.5 4.5v11",
  trendUp: "M2.5 14l5-5 3.5 3.5 6.5-7M12.5 5.5h5v5",
  layers: "M10 2.5l7.5 4-7.5 4-7.5-4zM2.5 10l7.5 4 7.5-4M2.5 13.5l7.5 4 7.5-4",
  close: "M5 5l10 10M15 5L5 15",
  menu: "M3 6h14M3 14h14",
  dot: "M10 10.01",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({name, size = 16, label, ...rest}: {name: IconName; size?: number; label?: string} & Omit<SVGProps<SVGSVGElement>, "name">) {
  return (
    <svg
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "dot" ? 6 : 1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
