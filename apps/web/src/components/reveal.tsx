"use client";

import { useEffect, useRef, type ReactNode } from "react";

type RevealProps = { children: ReactNode; className?: string; id?: string };

export function Reveal({ children, className = "", id }: RevealProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => entry?.isIntersecting && node.setAttribute("data-visible", "true"),
      { threshold: 0.12 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className={`reveal ${className}`} id={id}>
      {children}
    </div>
  );
}
