// ExtraApprovalCard.tsx - Reusable component for displaying extra approval cards
import React from "react";
import { useTranslation } from "react-i18next";
import { FiClock } from "react-icons/fi";
import { toSecureUploadUrl } from "../../lib/files";

type ExtraApproverDTO = {
  id: number;
  actedAt?: string | null;
  user: {
    id: number;
    name: string;
    lastname?: string | null;
    nickname?: string | null;
    profileImagePath?: string | null;
  };
  status?: { id: number; name: string } | null;
};

type ExtraApprovalLineDTO = {
  id: number;
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "REJECTED";
  createdAt?: string;
  approvers: ExtraApproverDTO[];
  comment?: any | null; // ✅ รองรับทั้ง Object และ Array จาก Backend
};

interface ExtraApprovalCardProps {
  extraLine: ExtraApprovalLineDTO;
  prettyTime: (iso: string) => string;
  formatFullName: (user: any) => string;
  Avatar: React.ComponentType<{
    name: string;
    src: string | null;
    userId: number;
    sizeClass?: string;
  }>;
  // Optional props for action buttons
  meId?: number | null;
  isExpired?: boolean;
  onApprove?: (lineId: number) => Promise<void>;
  onReject?: (lineId: number) => Promise<void>;
  onRemove?: (lineId: number) => Promise<void>;
  hideButtons?: boolean;
}

export const ExtraApprovalCard: React.FC<ExtraApprovalCardProps> = ({
  extraLine,
  prettyTime,
  formatFullName,
  Avatar,
  meId,
  isExpired = false,
  onApprove,
  onReject,
  onRemove,
  hideButtons = false,
}) => {
  const { t } = useTranslation("memoViewer");

  // Check if current user is an approver waiting to act
  const myApprover = extraLine.approvers.find((a) => {
    if (meId == null || a.user.id !== meId) return false;
    
    // null status means waiting (not acted yet)
    if (a.status === null || a.status === undefined) return true;
    
    // Check various possible status formats
    const statusName = a.status?.name || a.status || (a as any).statusName;
    const isWaitingStatus = 
      statusName === "Waiting" || 
      statusName === "waiting" || 
      statusName === "WAITING" ||
      statusName === "Pending" ||
      statusName === "pending";
    
    return isWaitingStatus;
  });
  
  const isWaiting = extraLine.status === "PENDING" || extraLine.status === "IN_PROGRESS";
  const showButtons = !hideButtons && isWaiting && myApprover && !isExpired && onApprove && onReject;
  
  // ✅ Check if the current user created this extra line
  // We handle whether `createdById` exists in `ExtraApprovalLineDTO` (added via casting if backend sends it)
  // or we default to hiding the remove button if we aren't sure.
  const isCreator = (extraLine as any).createdById === meId;
  const showRemoveButton = extraLine.status === "PENDING" && isCreator && !isExpired && !!onRemove;

  // ✅ Extract the actual comment object whether it's an array or a single object
  const rawComment = Array.isArray(extraLine.comment) 
    ? (extraLine.comment.length > 0 ? extraLine.comment[0] : null) 
    : extraLine.comment;

  // Extract text: if it's a string directly, use it. If it's an object with a .comment property, use that.
  const commentText = typeof rawComment === "string" 
    ? rawComment 
    : (rawComment && typeof rawComment === "object" ? rawComment.comment : null);

  return (
    <div className="my-6">
      <div className="border border-gray-200 rounded-xl shadow-sm bg-white overflow-hidden w-full max-w-md mx-auto ring-1 ring-black/5">
        <div className="bg-gray-50/80 px-4 py-3 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div>
                <h3 className="font-bold text-gray-900 text-sm leading-tight">
                  {t("extra.requestTitle", "Approval Request")}
                </h3>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className="text-[10px] uppercase tracking-wider font-semibold text-gray-500">
                    {t("extra.type", "EXTRA")}
                  </span>
                  {extraLine.createdAt && (
                    <span className="text-[10px] text-gray-400">
                      • {prettyTime(extraLine.createdAt)}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <span
              className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold border uppercase tracking-wide ${
                extraLine.status === "COMPLETED"
                  ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                  : extraLine.status === "REJECTED"
                    ? "bg-orange-100 text-orange-700 border-orange-200"
                    : "bg-amber-50 text-amber-700 border-amber-200"
              }`}
            >
              {extraLine.status}
            </span>
          </div>
          {/* Display comment prominently in header */}
          {commentText && (
            <div className="mt-3 p-3 bg-white/60 border border-gray-200 rounded-lg">
              <p className="text-xs font-semibold text-gray-600 mb-1.5">
                {t("extra.commentLabel", "Comment / Reason")}:
              </p>
              <p className="text-[15px] text-gray-900 font-medium whitespace-pre-wrap break-words leading-relaxed">
                {commentText}
              </p>
            </div>
          )}
        </div>
        <div className="p-4 bg-white">
          <div className="space-y-3">
            {extraLine.approvers.map((a) => {
              const statusName = a.status?.name ?? "Waiting";
              const fullName = formatFullName(a.user);

              return (
                <div
                  key={a.id}
                  className="flex items-center justify-between group"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Avatar
                      name={fullName || `User #${a.user.id}`}
                      src={
                        a.user.profileImagePath
                          ? toSecureUploadUrl(a.user.profileImagePath)
                          : null
                      }
                      userId={a.user.id}
                      sizeClass="w-8 h-8"
                    />
                    <div className="flex flex-col min-w-0">
                      <span className="text-sm font-medium text-gray-900 truncate">
                        {fullName || `User #${a.user.id}`}
                      </span>
                      <span className="text-xs text-gray-500">
                        {statusName}
                        {a.actedAt && ` • ${prettyTime(a.actedAt)}`}
                      </span>
                    </div>
                  </div>
                  {statusName === "Approved" ? (
                    <div className="text-emerald-500 bg-emerald-50 p-1.5 rounded-full">
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                    </div>
                  ) : statusName === "Rejected" ? (
                    <div className="text-orange-500 bg-orange-50 p-1.5 rounded-full">
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M6 18L18 6M6 6l12 12"
                        />
                      </svg>
                    </div>
                  ) : (
                    <div className="text-amber-500 bg-amber-50 p-1.5 rounded-full">
                      <FiClock className="w-4 h-4" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {/* Action buttons footer */}
        {(showButtons || showRemoveButton) && (
          <div className="px-4 py-3 bg-gray-50 border-t border-gray-200 flex flex-wrap gap-3 items-center justify-between">
            {showButtons && (
              <div className="flex items-center gap-2">
                <button
                  onClick={async () => {
                    if (onApprove) {
                      await onApprove(extraLine.id);
                    }
                  }}
                  className="px-4 py-1.5 bg-emerald-600 text-white text-sm font-bold rounded-lg hover:bg-emerald-700 shadow-sm transition-all"
                >
                  {t("extra.approve", "Approve")}
                </button>
                <button
                  onClick={async () => {
                    if (onReject) {
                      await onReject(extraLine.id);
                    }
                  }}
                  className="px-4 py-1.5 bg-amber-600 text-white text-sm font-bold rounded-lg hover:bg-amber-700 transition-all"
                >
                  {t("extra.reject", "Reject")}
                </button>
              </div>
            )}
            
            {/* push remove to the right */}
            {!showButtons && <div className="flex-1" />}
            
            {showRemoveButton && (
              <button
                onClick={async () => {
                  if (onRemove) {
                    await onRemove(extraLine.id);
                  }
                }}
                className="px-3 py-1.5 text-sm font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors ml-auto mt-1 mb-1"
              >
                {t("extra.removeLineBtn", "Remove")}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
