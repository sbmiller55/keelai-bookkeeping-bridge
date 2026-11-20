"use client";

import { createContext, useContext, useEffect } from "react";

// Lets a page put the sidebar's collapse button in its own header instead of
// the floating tab at the viewport edge. A page that does calls
// useInlineSidebarToggle(), and the layout hides the floating tab while it is
// mounted — otherwise there would be two buttons doing the same thing.
interface SidebarState {
  collapsed: boolean;
  toggle: () => void;
  setInlineToggle: (on: boolean) => void;
}

export const SidebarContext = createContext<SidebarState>({
  collapsed: false,
  toggle: () => {},
  setInlineToggle: () => {},
});

export function useInlineSidebarToggle() {
  const ctx = useContext(SidebarContext);
  const { setInlineToggle } = ctx;
  useEffect(() => {
    setInlineToggle(true);
    return () => setInlineToggle(false);
  }, [setInlineToggle]);
  return ctx;
}
