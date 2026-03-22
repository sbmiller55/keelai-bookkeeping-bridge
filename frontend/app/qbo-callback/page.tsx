"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { connectQbo } from "@/lib/api";

export default function QboCallbackPage() {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<"connecting" | "success" | "error">("connecting");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    const code     = searchParams.get("code");
    const realmId  = searchParams.get("realmId");
    const state    = searchParams.get("state");   // client_id passed via OAuth state
    const error    = searchParams.get("error");

    if (error) {
      setStatus("error");
      setErrorMsg(`Authorization denied: ${error}`);
      return;
    }

    if (!code || !realmId || !state) {
      setStatus("error");
      setErrorMsg("Missing required parameters from QuickBooks redirect.");
      return;
    }

    const clientId = Number(state);
    if (!clientId) {
      setStatus("error");
      setErrorMsg("Invalid client state parameter.");
      return;
    }

    connectQbo(clientId, code, realmId)
      .then(() => {
        setStatus("success");
        // Don't navigate — just tell the user to close this tab.
        // Navigating here can corrupt the auth state in the original tab.
      })
      .catch((err: Error) => {
        setStatus("error");
        setErrorMsg(err.message);
      });
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 max-w-sm w-full text-center space-y-4">
        {status === "connecting" && (
          <>
            <div className="w-10 h-10 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-white font-medium">Connecting to QuickBooks…</p>
          </>
        )}
        {status === "success" && (
          <>
            <div className="w-10 h-10 rounded-full bg-green-500 flex items-center justify-center mx-auto">
              <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414L8.414 15l-4.121-4.121a1 1 0 011.414-1.414L8.414 12.172l7.879-7.879a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
            </div>
            <p className="text-white font-medium">QuickBooks connected!</p>
            <p className="text-gray-500 text-sm">You can close this tab and return to the app.</p>
            <button
              onClick={() => window.close()}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Close tab
            </button>
          </>
        )}
        {status === "error" && (
          <>
            <div className="w-10 h-10 rounded-full bg-red-500/20 border border-red-500 flex items-center justify-center mx-auto">
              <svg className="w-5 h-5 text-red-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <p className="text-white font-medium">Connection failed</p>
            <p className="text-red-400 text-sm">{errorMsg}</p>
            <button
              onClick={() => router.back()}
              className="text-indigo-400 hover:text-indigo-300 text-sm transition-colors"
            >
              ← Go back
            </button>
          </>
        )}
      </div>
    </div>
  );
}
