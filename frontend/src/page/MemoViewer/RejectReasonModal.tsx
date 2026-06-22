import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";

interface RejectReasonModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}

export function RejectReasonModal({
  isOpen,
  onClose,
  onConfirm,
}: RejectReasonModalProps) {
  const { t } = useTranslation("memoViewer");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [hasEmoji, setHasEmoji] = useState(false);
  
  const MAX_LENGTH = 500;

  useEffect(() => {
    if (!isOpen) {
      setReason("");
      setSubmitting(false);
      setHasEmoji(false);
    }
  }, [isOpen]);

  const containsEmoji = (text: string) => {
    const emojiRegex = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1F018}-\u{1F270}\u{238C}-\u{2454}\u{20D0}-\u{20FF}\u{FE00}-\u{FE0F}]/u;
    return emojiRegex.test(text);
  };

  const handleReasonChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    
    // Check for emoji
    if (containsEmoji(newValue)) {
      setHasEmoji(true);
      return; // Don't update if contains emoji
    }
    
    // Check length
    if (newValue.length > MAX_LENGTH) {
      return; // Don't update if exceeds max length
    }
    
    setHasEmoji(false);
    setReason(newValue);
  };

  const handleSubmit = async () => {
    if (!reason.trim()) {
      return;
    }
    setSubmitting(true);
    try {
      await onConfirm(reason.trim());
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
        {/* Header */}
        <div className="bg-gradient-to-r from-orange-500 to-red-500 p-6 relative">
          <button
            onClick={onClose}
            disabled={submitting}
            className="absolute top-4 right-4 text-white/80 hover:text-white transition-colors"
          >
            <svg
              className="w-6 h-6"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
          <h2 className="text-2xl font-bold text-white">
            {t("reject.title", "Needs Revised")}
          </h2>
        </div>

        {/* Body */}
        <div className="p-6">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            {t("reject.reasonLabel", "Revision Reason")}
            <span className="text-red-500 ml-1">*</span>
          </label>
          <textarea
            value={reason}
            onChange={handleReasonChange}
            placeholder={t(
              "reject.reasonPlaceholder",
              "Enter revision reason..."
            )}
            className={`w-full h-32 px-4 py-3 border-2 rounded-xl transition-all resize-none ${
              hasEmoji || reason.length >= MAX_LENGTH
                ? "border-red-500 focus:border-red-500 focus:ring-2 focus:ring-red-200"
                : "border-gray-200 focus:border-orange-500 focus:ring-2 focus:ring-orange-200"
            }`}
            disabled={submitting}
          />
          <div className="flex justify-between items-center mt-2">
            <div className="text-sm">
              {hasEmoji && (
                <p className="text-red-600 font-medium">
                  {t("validation.noEmoji", "Emojis are not allowed")}
                </p>
              )}
              {!hasEmoji && reason.length >= MAX_LENGTH && (
                <p className="text-red-600 font-medium">
                  {t("validation.maxLength", "Maximum character limit reached")}
                </p>
              )}
              {!hasEmoji && reason.length < MAX_LENGTH && (
                <p className="text-gray-500">
                  {t(
                    "reject.hint",
                    "Please provide a clear reason for requesting revision."
                  )}
                </p>
              )}
            </div>
            <p className={`text-sm ${
              reason.length >= MAX_LENGTH ? "text-red-600 font-semibold" : "text-gray-500"
            }`}>
              {reason.length}/{MAX_LENGTH}
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="bg-gray-50 px-6 py-4 flex justify-end gap-3">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-6 py-2.5 text-gray-700 bg-white border-2 border-gray-300 rounded-xl hover:bg-gray-50 transition-all font-medium disabled:opacity-50"
          >
            {t("common.cancel", "Cancel")}
          </button>
          <button
            onClick={handleSubmit}
            disabled={!reason.trim() || submitting}
            className="px-6 py-2.5 bg-gradient-to-r from-orange-500 to-red-500 text-white rounded-xl hover:from-orange-600 hover:to-red-600 transition-all font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {submitting ? (
              <>
                <svg
                  className="animate-spin h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                {t("common.submitting", "Submitting...")}
              </>
            ) : (
              <>
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                  />
                </svg>
                {t("reject.confirm", "Confirm Revision")}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
