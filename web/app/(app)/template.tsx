"use client";
import {useEffect} from "react";
import {motion} from "motion/react";

/** Set after the first client render: the hard load has painted, later mounts are in-app navigations. */
let hydrated = false;

/**
 * Page transition: a 150 ms fade on in-app navigations (nothing slides). The first paint is **not** faded (A5):
 * `initial={false}` renders the server HTML fully visible, so the largest contentful paint doesn't wait for the JS
 * bundle to hydrate and start the animation (LCP was 4.4 s on /markets under Lighthouse's throttling). Server and
 * first client render agree (`hydrated` is only flipped in an effect), so there is no hydration mismatch.
 */
export default function Template({children}: {children: React.ReactNode}) {
  const fade = hydrated;
  useEffect(() => {
    hydrated = true;
  }, []);
  return (
    <motion.div initial={fade ? {opacity: 0} : false} animate={{opacity: 1}} transition={{duration: 0.15, ease: [0.16, 1, 0.3, 1]}}>
      {children}
    </motion.div>
  );
}
