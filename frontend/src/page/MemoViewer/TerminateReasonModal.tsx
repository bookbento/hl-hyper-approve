import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";

interface TerminateReasonModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}

const TerminateReasonModal: React.FC<TerminateReasonModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
}) => {
  const { t } = useTranslation("memoViewer");

  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [hasEmoji, setHasEmoji] = useState(false);
  
  const MAX_LENGTH = 500;

  useEffect(() => {
    if (isOpen) {
      setReason("");
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

  const handleConfirm = async () => {
    if (!reason.trim()) {
      toast.error(t("terminate.required", "Please enter a termination reason"));
      return;
    }

    setSubmitting(true);
    try {
      await onConfirm(reason.trim());
      onClose();
    } catch (error) {
      console.error(error);
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-gray-900/70 backdrop-blur-sm z-[9999] flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden transform transition-all duration-300">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-rose-600 px-6 py-4">
          <div className="flex justify-between items-center">
            <h3 className="text-xl font-bold text-white tracking-tight">
              {t("terminate.modalTitle", "Terminate Memo")}
            </h3>
            <button
              onClick={onClose}
              className="text-white/90 hover:text-white transition-colors bg-white/10 p-1.5 rounded-full"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="p-6 space-y-5">
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">
              {t("terminate.label", "Termination Reason")}
              <span className="text-red-500 ml-1">*</span>
            </label>
            <textarea
              autoFocus
              rows={4}
              className={`w-full border rounded-xl p-3 focus:ring-2 transition-all shadow-sm resize-none ${
                hasEmoji || reason.length >= MAX_LENGTH
                  ? "border-red-500 focus:ring-red-400 focus:border-red-500"
                  : "border-gray-300 focus:ring-rose-400 focus:border-transparent"
              }`}
              placeholder={t(
                "terminate.placeholder",
                "Enter termination reason..."
              )}
              value={reason}
              onChange={handleReasonChange}
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
              </div>
              <p className={`text-sm ${
                reason.length >= MAX_LENGTH ? "text-red-600 font-semibold" : "text-gray-500"
              }`}>
                {reason.length}/{MAX_LENGTH}
              </p>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-white border-t border-gray-200 p-4">
          <div className="flex justify-between items-center">
            <button
              onClick={onClose}
              className="px-4 py-2.5 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors font-medium text-sm"
            >
              {t("terminate.cancel", "Cancel")}
            </button>

            <button
              onClick={handleConfirm}
              disabled={submitting || !reason.trim()}
              className="flex items-center gap-2 px-4 py-2.5 rounded-lg
                text-white transition-colors font-medium text-sm
                disabled:opacity-60 disabled:cursor-not-allowed
                bg-rose-600 hover:bg-rose-700"
            >
              {submitting ? (
                <>
                  <svg
                    className="animate-spin h-4 w-4"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                      fill="none"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                  {t("approvers.processing", "Processing...")}
                </>
              ) : (
                <>
                  <svg
                    className="w-4 h-4"
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
                  {t("terminate.confirm", "Confirm Termination")}
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TerminateReasonModal;
