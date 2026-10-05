"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Typeahead for picking a QBO account.
 *
 * Only ever commits a name that exists in the live chart: a typed value is
 * resolved case-insensitively to the canonical spelling, and anything that
 * doesn't resolve reverts. That is the point of the component — free-typed
 * account names are what QBO rejects at import time.
 *
 * Shared so every place that edits an account behaves identically. The invoice
 * upload page previously used a bare text input, which offered no list and
 * accepted anything.
 */
export function AccountSelect({
  value,
  onChange,
  accounts,
  placeholder = "Select account…",
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  accounts: string[];
  placeholder?: string;
  className?: string;
}) {
  const [inputValue, setInputValue] = useState(value);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [isTyping, setIsTyping] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Case-insensitive lookup so we can resolve a typed string to the canonical
  // QBO account name (with original casing) and reject anything that isn't in
  // the live QBO chart of accounts.
  const lookup = new Map(accounts.map((a) => [a.toLowerCase(), a]));
  const resolveToCanonical = (raw: string): string | null => {
    return lookup.get(raw.trim().toLowerCase()) ?? null;
  };

  // Keep input in sync when value changes externally
  useEffect(() => { setInputValue(value); }, [value]);

  // Commit a typed value: only allowed if it matches a real QBO account name
  // (case-insensitive). Otherwise revert the input to the previous value —
  // free-typed strings can no longer leak into JEs.
  const tryCommitTyped = () => {
    if (inputValue === value) return;
    const canonical = resolveToCanonical(inputValue);
    if (canonical) {
      setInputValue(canonical);
      onChange(canonical);
    } else {
      setInputValue(value);
    }
  };

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        tryCommitTyped();
        setOpen(false);
        setIsTyping(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputValue, value, onChange]);

  // Show all accounts when just opened; filter only once user starts typing
  const filtered = (isTyping && inputValue)
    ? accounts.filter((a) => a.toLowerCase().includes(inputValue.toLowerCase()))
    : accounts;

  // Reset active index when suggestions change
  useEffect(() => { setActiveIdx(0); }, [filtered.length]);

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    setInputValue(e.target.value);
    setIsTyping(true);
    setOpen(true);
    setActiveIdx(0);
  }

  function commit(val: string) {
    // Defensive: only ever commit a value that exists in the live QBO list.
    const canonical = resolveToCanonical(val);
    if (!canonical) {
      setInputValue(value);
      setOpen(false);
      setIsTyping(false);
      return;
    }
    setInputValue(canonical);
    onChange(canonical);
    setOpen(false);
    setIsTyping(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open) { if (e.key === "ArrowDown" || e.key === "Enter") setOpen(true); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[activeIdx]) {
        commit(filtered[activeIdx]);
      } else {
        // No dropdown match and no exact list match → reject the typed value
        const canonical = resolveToCanonical(inputValue);
        if (canonical) commit(canonical);
        else setInputValue(value);
      }
    } else if (e.key === "Escape") {
      setInputValue(value);
      setOpen(false);
      setIsTyping(false);
    }
  }

  // Scroll active item into view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.children[activeIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  return (
    <div ref={ref} className="relative w-full">
      <input
        type="text"
        value={inputValue}
        placeholder={placeholder}
        onChange={handleInputChange}
        onFocus={(e) => { setOpen(true); setIsTyping(false); e.target.select(); }}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          // Small delay so click on dropdown item fires first
          setTimeout(() => {
            if (ref.current && !ref.current.contains(document.activeElement)) {
              tryCommitTyped();
              setOpen(false);
              setIsTyping(false);
            }
          }, 150);
        }}
        className={className ?? "w-full bg-transparent border border-transparent hover:border-gray-600 focus:border-indigo-500 focus:outline-none text-white rounded px-2 py-1 text-xs placeholder-gray-500"}
      />

      {open && filtered.length > 0 && (
        <div className="absolute z-50 mt-1 w-64 bg-gray-900 border border-gray-700 rounded-lg shadow-xl overflow-hidden">
          <div ref={listRef} className="max-h-56 overflow-y-auto">
            {filtered.map((a, i) => (
              <button
                key={a}
                type="button"
                onMouseDown={(e) => { e.preventDefault(); commit(a); }}
                className={`w-full text-left px-3 py-1.5 text-xs ${i === activeIdx ? "bg-indigo-600 text-white" : a === value ? "text-indigo-400 bg-gray-800/50" : "text-gray-200 hover:bg-gray-800"}`}
              >
                {a}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
