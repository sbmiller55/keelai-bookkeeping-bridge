"use client";

import { useEffect, useState } from "react";
import { getQboCustomers } from "@/lib/api";

/**
 * Returns the live list of customer names pulled from QBO.
 * Used by the Customer picker on income/deposit transactions.
 */
export function useCustomers(clientId: number) {
  const [customers, setCustomers] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!clientId) return;
    setLoading(true);
    setError(null);

    getQboCustomers(clientId)
      .then((names) => {
        setCustomers(Array.from(new Set(names)).sort());
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load customers");
      })
      .finally(() => setLoading(false));
  }, [clientId]);

  return { customers, loading, error };
}
