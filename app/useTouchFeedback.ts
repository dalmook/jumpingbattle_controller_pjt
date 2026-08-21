"use client";

import { useEffect, useRef } from "react";

const TOUCH_TARGET_SELECTOR = "button:not(:disabled), a[href], [role='button']:not([aria-disabled='true'])";

export function useTouchFeedbackRoot<T extends HTMLElement>() {
  const rootRef = useRef<T | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const pressedTargets = new Map<number, HTMLElement>();

    const release = (event: PointerEvent) => {
      const target = pressedTargets.get(event.pointerId);
      target?.classList.remove("is-touching");
      pressedTargets.delete(event.pointerId);
    };

    const press = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      if (!(event.target instanceof Element)) return;

      const target = event.target.closest<HTMLElement>(TOUCH_TARGET_SELECTOR);
      if (!target || !root.contains(target)) return;

      const previous = pressedTargets.get(event.pointerId);
      previous?.classList.remove("is-touching");
      pressedTargets.set(event.pointerId, target);
      target.classList.add("is-touching");

      const rect = target.getBoundingClientRect();
      const diameter = Math.max(rect.width, rect.height) * 1.8;
      const ripple = document.createElement("span");
      ripple.className = "touch-ripple";
      ripple.setAttribute("aria-hidden", "true");
      ripple.style.width = `${diameter}px`;
      ripple.style.height = `${diameter}px`;
      ripple.style.left = `${event.clientX - rect.left}px`;
      ripple.style.top = `${event.clientY - rect.top}px`;
      target.appendChild(ripple);
      window.setTimeout(() => ripple.remove(), 460);
    };

    const clear = () => {
      pressedTargets.forEach((target) => target.classList.remove("is-touching"));
      pressedTargets.clear();
    };

    root.addEventListener("pointerdown", press);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", clear);

    return () => {
      root.removeEventListener("pointerdown", press);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", clear);
      clear();
      root.querySelectorAll(".touch-ripple").forEach((ripple) => ripple.remove());
    };
  }, []);

  return rootRef;
}
