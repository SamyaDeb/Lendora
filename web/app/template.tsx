"use client";
import {motion} from "motion/react";

/** Page transition: a 150 ms fade on every navigation (nothing slides). */
export default function Template({children}: {children: React.ReactNode}) {
  return (
    <motion.div initial={{opacity: 0}} animate={{opacity: 1}} transition={{duration: 0.15, ease: [0.16, 1, 0.3, 1]}}>
      {children}
    </motion.div>
  );
}
