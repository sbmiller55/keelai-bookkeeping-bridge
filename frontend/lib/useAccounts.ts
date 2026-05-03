"use client";

import { useEffect, useState } from "react";
import { getChartOfAccounts, getQboAccounts } from "@/lib/api";

/**
 * Merges accounts from the uploaded COA file and live QBO accounts.
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

    Promise.all([
      getChartOfAccounts(clientId).catch(() => [] as string[]),
      getQboAccounts(clientId).catch(() => [] as string[]),
    ])
      .then(([fileAccounts, qboAccounts]) => {
        const merged = Array.from(new Set([...fileAccounts, ...qboAccounts])).sort();
        setAccounts(merged);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load accounts");
      })
      .finally(() => setLoading(false));
  }, [clientId]);

  return { accounts, loading, error };
}
