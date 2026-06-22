// src/components/ExtraApprovalPanel.tsx
import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { useExtraApproval } from "../../lib/useExtraApproval";

type Props = {
  memoId: number;
  currentUserId: number;
  canCreateExtraLine?: boolean;
};

const badgeColor: Record<string, string> = {
  Approved: "#16a34a",
  Rejected: "#dc2626",
  Waiting: "#f59e0b",
};

const badgeBgColor: Record<string, string> = {
  Approved: "#dcfce7",
  Rejected: "#fee2e2",
  Waiting: "#fef3c7",
};

export const ExtraApprovalPanel: React.FC<Props> = ({
  memoId,
  currentUserId,
  canCreateExtraLine,
}) => {
  const { t } = useTranslation();
  const { line, loading, error, createLine, act, hasActiveExtraLine } =
    useExtraApproval(memoId);
  const [selected, setSelected] = useState<number[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const onCreate = async () => {
    if (!selected.length) return;
    try {
      setSubmitting(true);
      await createLine(selected);
      setSelected([]);
    } catch (e: any) {
      alert(e?.message || t("extra.saveFail"));
    } finally {
      setSubmitting(false);
    }
  };

  const myRow = line?.approvers.find((a) => a.user.id === currentUserId);
  const myWaiting = !!myRow && !myRow.status;

  // Helper to format timestamp
  const formatTimestamp = (iso?: string | null) => {
    if (!iso) return null;
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return null;
    }
  };

  return (
    <div style={{ 
      border: "2px solid #a78bfa", 
      borderRadius: 12, 
      padding: 16, 
      marginTop: 12,
      background: "#faf5ff"
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <h3 style={{ margin: 0 }}>{t("extra.title")}</h3>
          <span style={{ 
            fontSize: 11, 
            padding: "3px 10px", 
            background: "#a78bfa", 
            color: "white",
            borderRadius: 12,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.5px"
          }}>
            {t("extra.extraLineBadge", "Extra Line")}
          </span>
        </div>
        {hasActiveExtraLine && (
          <span style={{ 
            fontSize: 12, 
            padding: "4px 10px", 
            background: "#eef2ff", 
            borderRadius: 10,
            fontWeight: 500,
            border: "1px solid #c7d2fe"
          }}>
            {line!.status}
          </span>
        )}
      </div>

      {loading && <div style={{ marginTop: 8 }}>{t("ccList.loading")}</div>}
      {error && <div style={{ color: "#dc2626", marginTop: 8 }}>{error}</div>}

      {!loading && !line && (
        <div style={{ marginTop: 12 }}>
          {canCreateExtraLine ? (
            <>
              <div style={{ marginBottom: 8 }}>
                <label style={{ fontWeight: 600 }}>{t("extra.selectedEmpty")}</label>
                <input
                  type="text"
                  placeholder="เช่น 12,45"
                  value={selected.join(",")}
                  onChange={(e) =>
                    setSelected(
                      e.currentTarget.value
                        .split(",")
                        .map((s) => Number(s.trim()))
                        .filter(Boolean)
                    )
                  }
                  style={{ width: "100%", marginTop: 6 }}
                />
              </div>
              <button disabled={!selected.length || submitting} onClick={onCreate}>
                {submitting ? t("extra.saving") : t("extra.createBtn")}
              </button>
              <p style={{ fontSize: 12, color: "#6b7280", marginTop: 6 }}>
                ผู้สร้างได้เฉพาะเจ้าของเอกสารหรือผู้อนุมัติที่อยู่ระดับปัจจุบัน (แบ็กเอนด์ตรวจสิทธิ์แล้ว)
              </p>
            </>
          ) : (
            <div style={{ color: "#6b7280" }}>{t("extra.none")}</div>
          )}
        </div>
      )}

      {!!line && (
        <div style={{ marginTop: 12 }}>
          {line.approvers.map((a) => {
            const statusName = a.status?.name ?? "Waiting";
            const color = badgeColor[statusName] || "#64748b";
            const bgColor = badgeBgColor[statusName] || "#f3f4f6";
            const fullName =
              [a.user.name, a.user.lastname].filter(Boolean).join(" ") +
              (a.user.nickname ? ` (${a.user.nickname})` : "");
            const isCurrentUser = a.user.id === currentUserId;
            const isWaiting = !a.status;
            const timestamp = a.status?.actedAt ? formatTimestamp(a.status.actedAt) : null;
            
            return (
              <div
                key={a.id}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  padding: "12px",
                  marginBottom: "8px",
                  borderRadius: "8px",
                  border: isCurrentUser && isWaiting ? "2px solid #f59e0b" : "1px solid #e5e7eb",
                  background: isCurrentUser && isWaiting ? "#fffbeb" : "white",
                  boxShadow: isCurrentUser && isWaiting ? "0 2px 8px rgba(245, 158, 11, 0.15)" : "none",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div
                      style={{ 
                        width: 36, 
                        height: 36, 
                        borderRadius: "50%", 
                        background: "#e5e7eb", 
                        overflow: "hidden",
                        border: isCurrentUser ? "2px solid #a78bfa" : "none"
                      }}
                    >
                      {a.user.profileImagePath ? (
                        <img
                          src={`/uploads/profiles/${a.user.profileImagePath}`}
                          alt={fullName}
                          style={{ width: "100%", height: "100%", objectFit: "cover" }}
                        />
                      ) : (
                        <div style={{ 
                          width: "100%", 
                          height: "100%", 
                          display: "flex", 
                          alignItems: "center", 
                          justifyContent: "center",
                          fontSize: 14,
                          fontWeight: 600,
                          color: "#6b7280"
                        }}>
                          {fullName.charAt(0).toUpperCase()}
                        </div>
                      )}
                    </div>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 14, fontWeight: 500 }}>
                          {fullName || `User #${a.user.id}`}
                        </span>
                        {isCurrentUser && (
                          <span style={{ 
                            fontSize: 10, 
                            padding: "2px 6px", 
                            background: "#a78bfa", 
                            color: "white",
                            borderRadius: 8,
                            fontWeight: 600,
                            textTransform: "uppercase"
                          }}>
                            {t("extra.youIndicator", "You")}
                          </span>
                        )}
                      </div>
                      {timestamp && (
                        <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>
                          {timestamp}
                        </div>
                      )}
                    </div>
                  </div>
                  <span
                    style={{
                      fontSize: 12,
                      padding: "5px 10px",
                      background: bgColor,
                      borderRadius: 12,
                      color,
                      fontWeight: 600,
                      border: `1px solid ${color}`,
                    }}
                  >
                    {statusName}
                  </span>
                </div>
                
                {isCurrentUser && isWaiting && (
                  <div style={{ 
                    fontSize: 12, 
                    color: "#92400e", 
                    background: "#fef3c7",
                    padding: "8px 10px",
                    borderRadius: "6px",
                    fontWeight: 500,
                    border: "1px solid #fcd34d"
                  }}>
                    {t("extra.waitingForYou", "⏳ Waiting for your approval")}
                  </div>
                )}
              </div>
            );
          })}

          {myWaiting && (
            <div style={{ marginTop: 16, display: "flex", gap: 8, paddingTop: 12, borderTop: "1px solid #e5e7eb" }}>
              <button 
                onClick={() => act("approved")}
                style={{
                  flex: 1,
                  padding: "10px 16px",
                  background: "#16a34a",
                  color: "white",
                  border: "none",
                  borderRadius: "8px",
                  fontWeight: 600,
                  cursor: "pointer",
                  fontSize: 14
                }}
              >
                {t("extra.approve")}
              </button>
              <button
                onClick={() => {
                  if (confirm(t("confirm.delete"))) act("rejected");
                }}
                style={{ 
                  flex: 1,
                  padding: "10px 16px",
                  background: "#fee2e2", 
                  border: "1px solid #ef4444",
                  color: "#dc2626",
                  borderRadius: "8px",
                  fontWeight: 600,
                  cursor: "pointer",
                  fontSize: 14
                }}
              >
                {t("extra.reject")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
