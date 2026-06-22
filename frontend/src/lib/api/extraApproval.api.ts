// src/lib/api/extraApproval.api.ts
export type ExtraApproverDTO = {
  id: number;
  user: {
    id: number;
    name: string;
    lastname?: string | null;
    nickname?: string | null;
    profileImagePath?: string | null;
  };
  status?: { id: number; name: string; actedAt?: string | null } | null; // null = waiting
};

export type ExtraApprovalLineDTO = {
  id: number;
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "REJECTED";
  approvers: ExtraApproverDTO[];
};

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    credentials: "include",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err: any = new Error(data?.error || res.statusText);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return res.json();
}

export function getActiveExtraApprovalLine(memoId: number) {
  return fetchJson<ExtraApprovalLineDTO | null>(
    `/api/memos/${memoId}/extra-approval-lines/active`
  );
}

export function createExtraApprovalLine(memoId: number, userIds: number[]) {
  return fetchJson<ExtraApprovalLineDTO>(`/api/memos/${memoId}/extra-approval-lines`, {
    method: "POST",
    body: JSON.stringify({ userIds }),
  });
}

export function actOnExtraApprovalLine(
  memoId: number,
  lineId: number,
  statusCode: "approved" | "rejected"
) {
  return fetchJson<{ ok: true; closed: "approved" | "rejected" | null }>(
    `/api/memos/${memoId}/extra-approval-lines/${lineId}/action`,
    { method: "POST", body: JSON.stringify({ statusCode }) }
  );
}
