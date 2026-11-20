"use client";

import { useEffect, useRef, useState } from "react";

// A select drawn in the app's own style. The native <select> opens the
// operating system's menu — grey and light on a dark page — so this replaces
// it with a dark panel, while keeping what a select gives you for free:
// arrow keys, Enter, Escape, and closing when you click elsewhere.

export interface DropdownOption<V extends string> {
  value: V;
  label: string;
  // Muted text on the right of the row: a count, or the dates an option covers.
  hint?: string;
  // Draw a separator line above this option.
  dividerBefore?: boolean;
}

export function Dropdown<V extends string>({
  value, options, onChange, face, ariaLabel, className = "", menuClassName = "w-56", footer,
}: {
  value: V;
  options: DropdownOption<V>[];
  onChange: (v: V) => void;
  // What the closed button shows; defaults to the selected option's label.
  face?: React.ReactNode;
  ariaLabel: string;
  className?: string;
  menuClassName?: string;
  footer?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const selectedIdx = Math.max(0, options.findIndex((o) => o.value === value));

  useEffect(() => {
    if (!open) return;
    setActive(selectedIdx);
    function onDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, selectedIdx]);

  function choose(i: number) {
    onChange(options[i].value);
    setOpen(false);
    buttonRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); buttonRef.current?.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(options.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(active); }
    else if (e.key === "Tab") setOpen(false);
  }

  return (
    <div ref={rootRef} className="relative" onKeyDown={onKeyDown}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        // Size, border and shape come from the caller: the same menu sits
        // joined to a button in one place and as a pill in another.
        className={`flex items-center gap-1.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60 ${
          open ? "bg-white/[0.06]" : ""} ${className}`}
      >
        {face ?? <span className="font-semibold text-white">{options[selectedIdx]?.label}</span>}
        <svg className={`w-3.5 h-3.5 text-gray-500 shrink-0 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
          fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={ariaLabel}
          className={`absolute left-0 top-full mt-1.5 z-50 py-1 rounded-xl border border-gray-700/80 bg-[#15161c] shadow-2xl shadow-black/60 animate-menu-in origin-top-left ${menuClassName}`}
        >
          {options.map((o, i) => (
            <div key={o.value}>
              {o.dividerBefore && <div className="my-1 border-t border-gray-800" />}
              <button
                type="button"
                role="option"
                aria-selected={i === selectedIdx}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(i)}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 mx-1 rounded-md text-left text-[12.5px] ${
                  i === active ? "bg-white/[0.06]" : ""}`}
                style={{ width: "calc(100% - 0.5rem)" }}
              >
                <svg className={`w-3.5 h-3.5 shrink-0 text-indigo-400 ${i === selectedIdx ? "" : "invisible"}`}
                  fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                <span className={`whitespace-nowrap ${i === selectedIdx ? "text-white font-medium" : "text-gray-300"}`}>{o.label}</span>
                {o.hint && <span className="ml-auto pl-4 text-xs text-gray-500 tabular-nums whitespace-nowrap">{o.hint}</span>}
              </button>
            </div>
          ))}
          {footer && <div className="mt-1 border-t border-gray-800 px-3 pt-2 pb-1.5 text-[11px] text-gray-500">{footer}</div>}
        </div>
      )}
    </div>
  );
}
