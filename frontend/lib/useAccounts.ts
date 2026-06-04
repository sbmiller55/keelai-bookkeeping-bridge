"use client";

import { useEffect, useState } from "react";
import { getQboAccounts } from "@/lib/api";

/**
 * Returns the live chart of accounts pulled from QBO.
 * Always use this hook anywhere account name lists or dropdowns are needed.
 */
export function useAccounts(clientId: number) {
  const [accounts, setAccounts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!clientId) return;
    setLoading(true);
    setError(null);

    getQboAccounts(clientId)
      .then((qboAccounts) => {
        setAccounts(Array.from(new Set(qboAccounts)).sort());
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load accounts");
      })
      .finally(() => setLoading(false));
  }, [clientId]);

  return { accounts, loading, error };
}
