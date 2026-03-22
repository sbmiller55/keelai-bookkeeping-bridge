"use client";

import { createContext, useContext, useState } from "react";

type ChatContextValue = {
  pageContext: string | null;
  setPageContext: (ctx: string | null) => void;
  currentPage: string;
  setCurrentPage: (page: string) => void;
};

const ChatCtx = createContext<ChatContextValue>({
  pageContext: null,
  setPageContext: () => {},
  currentPage: "",
  setCurrentPage: () => {},
});

export function ChatContextProvider({ children }: { children: React.ReactNode }) {
  const [pageContext, setPageContext] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState("");
  return (
    <ChatCtx.Provider value={{ pageContext, setPageContext, currentPage, setCurrentPage }}>
      {children}
    </ChatCtx.Provider>
  );
}

export function useChatContext() {
  return useContext(ChatCtx);
}
