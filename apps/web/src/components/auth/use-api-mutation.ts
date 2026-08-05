"use client";

import { useState } from "react";
import { postJson } from "@/lib/api";

export function useApiMutation<T>(path: string) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<T | null>(null);

  async function mutate(payload: unknown) {
    setPending(true);
    setError("");
    try {
      const result = await postJson<T>(path, payload);
      setData(result);
      return result;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
      return null;
    } finally {
      setPending(false);
    }
  }

  return { mutate, pending, error, data };
}
