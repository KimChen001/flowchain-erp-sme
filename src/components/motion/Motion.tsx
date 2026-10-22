import React from "react";
import { MotionConfig, motion, useReducedMotionConfig } from "motion/react";
import { A } from "../ui";

// Motion across the app is quiet and short: content fades in with a small
// rise, the active section tab slides, and dialogs scale in. With the
// system's "reduce motion" setting on, transforms and layout animations are
// switched off (MotionConfig reducedMotion="user"); the CSS keyframes in
// theme.css are switched off by a prefers-reduced-motion rule.

const EASE = [0.2, 0.8, 0.2, 1] as const;

export function AppMotion({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user" transition={{ duration: 0.18, ease: EASE }}>{children}</MotionConfig>;
}

// The page content under the module header, keyed by the route path by its
// parent: each page fades in and rises 6px. It never animates out, so a
// navigation is not delayed. At rest it carries no transform (and no
// will-change), so dialogs inside it stay fixed to the viewport. With reduced
// motion it only fades: MotionConfig would snap the rise away a frame after
// mount, but the page would still mount 6px low, so it starts in place.
export function PageTransition({ children }: { children: React.ReactNode }) {
  const reduceMotion = useReducedMotionConfig();
  return (
    <motion.div
      data-testid="page-transition"
      initial={{ opacity: 0, y: reduceMotion ? 0 : 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

// Content that replaces a loading skeleton fades in instead of popping.
export function FadeIn({ children }: { children: React.ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15, ease: EASE }}>
      {children}
    </motion.div>
  );
}

// A loading placeholder in the shape of a typical page: a title, four summary
// cards and a table, so the page does not jump when it arrives.
export function PageSkeleton({ label }: { label: string }) {
  const block = (className: string, key?: React.Key) => <div key={key} className={`fc-skeleton rounded-xl ${className}`} style={{ background: A.gray5 }} />;
  return (
    <div className="space-y-4" role="status" aria-label={label} data-testid="page-skeleton">
      {block("h-7 w-56")}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((item) => block("h-24", item))}</div>
      <div className="rounded-2xl bg-white p-4" style={{ border: "1px solid rgba(0,0,0,.06)" }}>
        {block("h-5 w-40")}
        <div className="mt-4 space-y-3">{[0, 1, 2, 3, 4, 5].map((item) => block("h-4 w-full", item))}</div>
      </div>
    </div>
  );
}
