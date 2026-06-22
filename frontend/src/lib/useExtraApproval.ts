// src/lib/hooks/useExtraApproval.ts
import { useCallback, useEffect, useState } from "react";
import { actOnExtraApprovalLine, createExtraApprovalLine, getActiveExtraApprovalLine, type ExtraApprovalLineDTO } from "./api/extraApproval.api";


export function useExtraApproval(memoId: number) {
  const [line, setLine] = useState<ExtraApprovalLineDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      setLoading(true);
      setErr(null);
      const data = await getActiveExtraApprovalLine(memoId);
      setLine(data);
    } catch (e: any) {
      setErr(e?.message || "Fetch failed");
    } finally {
      setLoading(false);
    }
  }, [memoId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const createLine = useCallback(
    async (userIds: number[]) => {
      const created = await createExtraApprovalLine(memoId, userIds);
      setLine(created);
      return created;
    },
    [memoId]
  );

  const act = useCallback(
    async (status: "approved" | "rejected") => {
      if (!line) return;
      await actOnExtraApprovalLine(memoId, line.id, status);
      await refetch();
    },
    [memoId, line, refetch]
  );

  const hasActiveExtraLine = !!line;

  return { line, loading, error: err, refetch, createLine, act, hasActiveExtraLine };
}
