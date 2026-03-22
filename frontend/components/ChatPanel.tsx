"use client";

import { useEffect, useRef, useState } from "react";
import { sendChatMessage, getChatHistory, ChatMessage } from "@/lib/api";
import { useChatContext } from "@/lib/chat-context";

interface Props {
  clientId: number;
  clientName: string;
}

export default function ChatPanel({ clientId, clientName }: Props) {
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const { pageContext, currentPage } = useChatContext();

  // Load persisted history when panel first opens
  useEffect(() => {
    if (open && !historyLoaded) {
      getChatHistory(clientId)
        .then((history) => {
          if (history.length > 0) setMessages(history);
          setHistoryLoaded(true);
        })
        .catch(() => setHistoryLoaded(true));
    }
  }, [open, historyLoaded, clientId]);

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, open]);

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    const userMsg: ChatMessage = { role: "user", content: text };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput("");
    setLoading(true);
    try {
      // Send only the latest user message — backend loads full history from DB
      const reply = await sendChatMessage(clientId, [userMsg], currentPage, pageContext);
      setMessages([...next, { role: "assistant", content: reply }]);
      // Notify any open page that data may have changed (e.g. JEs updated)
      window.dispatchEvent(new Event("bb-data-changed"));
    } catch (err: unknown) {
      setMessages([...next, { role: "assistant", content: `Error: ${err instanceof Error ? err.message : "Request failed"}` }]);
    } finally {
      setLoading(false);
    }
  }

  const pageLabel: Record<string, string> = {
    review_queue: "Review Queue",
    transactions: "Transactions",
    rules: "Rules",
    export: "Export",
    settings: "Settings",
  };

  const suggestions: Record<string, string[]> = {
    review_queue: [
      "Which JEs have low confidence and why?",
      "Are there any transactions coded incorrectly?",
      "Summarize what needs my attention",
    ],
    transactions: [
      "What are the largest expenses this month?",
      "Break down spending by category",
      "Which transactions are still pending?",
    ],
    "": [
      "What are the largest expenses this month?",
      "Which transactions are still pending review?",
      "Summarize payroll costs",
    ],
  };
  const currentSuggestions = suggestions[currentPage] ?? suggestions[""];

  return (
    <>
      {/* Floating button */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="fixed bottom-6 right-6 z-50 w-12 h-12 bg-indigo-600 hover:bg-indigo-500 text-white rounded-full shadow-lg flex items-center justify-center transition-colors"
        title="Ask AI assistant"
      >
        {open ? (
          <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
          </svg>
        )}
      </button>

      {/* Panel */}
      {open && (
        <div className={`fixed bottom-22 right-6 z-50 w-[420px] bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl flex flex-col overflow-hidden transition-all ${minimized ? "" : "h-[580px]"}`}>
          {/* Header */}
          <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-800 shrink-0 cursor-pointer" onClick={() => setMinimized((m) => !m)}>
            <div className="w-2 h-2 bg-indigo-500 rounded-full" />
            <div>
              <p className="text-sm font-semibold text-white">AI Assistant</p>
              {!minimized && (
                <p className="text-xs text-gray-500">
                  {clientName}
                  {currentPage && pageLabel[currentPage] ? ` · ${pageLabel[currentPage]}` : ""}
                </p>
              )}
            </div>
            {!minimized && currentPage && pageContext && (
              <span className="ml-1 text-xs bg-indigo-900/50 text-indigo-300 px-1.5 py-0.5 rounded-full">
                page data
              </span>
            )}
            <div className="ml-auto flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
              {!minimized && (
                <button
                  onClick={() => setMessages([])}
                  className="text-xs text-gray-500 hover:text-gray-300"
                  title="Clear conversation"
                >
                  Clear
                </button>
              )}
              <button
                onClick={() => setMinimized((m) => !m)}
                className="text-gray-500 hover:text-gray-300"
                title={minimized ? "Expand" : "Minimize"}
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  {minimized
                    ? <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
                    : <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />}
                </svg>
              </button>
            </div>
          </div>

          {/* Messages */}
          {!minimized && <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {messages.length === 0 && (
              <div className="text-center text-gray-500 text-xs pt-6 space-y-2">
                <p className="text-2xl">✦</p>
                <p>
                  {currentPage === "review_queue"
                    ? "I can see your Review Queue. Ask me about the pending transactions."
                    : `Ask anything about ${clientName}'s transactions, accounts, or accounting policy.`}
                </p>
                <div className="space-y-1 mt-4">
                  {currentSuggestions.map((q) => (
                    <button
                      key={q}
                      onClick={() => setInput(q)}
                      className="block w-full text-left text-xs bg-gray-800 hover:bg-gray-700 rounded-lg px-3 py-2 text-gray-300 transition-colors"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[90%] rounded-2xl px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap ${
                    m.role === "user"
                      ? "bg-indigo-600 text-white rounded-br-sm"
                      : "bg-gray-800 text-gray-200 rounded-bl-sm"
                  }`}
                >
                  {m.content}
                </div>
              </div>
            ))}
            {loading && (
              <div className="flex justify-start">
                <div className="bg-gray-800 rounded-2xl rounded-bl-sm px-3 py-2">
                  <span className="flex gap-1">
                    <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                    <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                    <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                  </span>
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>}

          {/* Input */}
          {!minimized && <div className="px-3 pb-3 shrink-0">
            <div className="flex items-end gap-2 bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 focus-within:border-indigo-500 transition-colors">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
                }}
                placeholder="Ask a question…"
                rows={1}
                className="flex-1 bg-transparent text-xs text-gray-200 placeholder-gray-500 resize-none outline-none max-h-24"
              />
              <button
                onClick={send}
                disabled={!input.trim() || loading}
                className="text-indigo-400 hover:text-indigo-300 disabled:text-gray-600 transition-colors shrink-0"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                </svg>
              </button>
            </div>
          </div>}
        </div>
      )}
    </>
  );
}
