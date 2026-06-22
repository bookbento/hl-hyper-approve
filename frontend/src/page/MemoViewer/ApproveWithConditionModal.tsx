import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { api, BASE_URL } from "../../lib/api";
import toast from "react-hot-toast";

export interface UserSignature {
  id: number;
  path: string;
  label?: string;
}

interface ApproveWithConditionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (
    loaUserId: number,
    payload: {
      statusCode: string;
      signatureText?: string;
      signatureImageId?: number;
      approveWithCondition: string;
    }
  ) => Promise<void>;
  loaUserId: number | null;
  requiresSignature: boolean;
  userSignatures: UserSignature[];
  defaultSignatureId: number | null;
  defaultSignatureText?: string;
  meId: number | null;
  myDisplayName?: string;
}

const API_URL = `${BASE_URL.replace(/\/api\/?$/, "")}/api`;

const sigSrc = (id: number, p: string) => {
  if (!p) return "";
  if (/^https?:\/\//i.test(p)) return p;
  return `${API_URL}/users/signatures/${id}/file`;
};

const ApproveWithConditionModal: React.FC<ApproveWithConditionModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  loaUserId,
  requiresSignature,
  userSignatures,
  defaultSignatureId,
  defaultSignatureText,
  meId,
  myDisplayName,
}) => {
  const { t } = useTranslation("memoViewer");

  const [conditionText, setConditionText] = useState("");
  const [sigMethod, setSigMethod] = useState<"type" | "system" | null>(null);
  const [chosenSigId, setChosenSigId] = useState<number | null>(null);
  const [customSigText, setCustomSigText] = useState("");
  const [approving, setApproving] = useState(false);
  const [hasEmoji, setHasEmoji] = useState(false);
  
  const MAX_LENGTH = 500;

  const effectiveDefaultSigText = defaultSignatureText;

  // Reset state when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      setConditionText("");
      setSigMethod(null);
      setChosenSigId(null);
      setCustomSigText("");
      setHasEmoji(false);
    }
  }, [isOpen]);

  // Auto-fill text when method changes to type
  useEffect(() => {
    if (sigMethod === "type" && !customSigText.trim()) {
      setCustomSigText(effectiveDefaultSigText || myDisplayName || "");
    }
  }, [sigMethod, myDisplayName, effectiveDefaultSigText, customSigText]);

  const containsEmoji = (text: string) => {
    const emojiRegex = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1F018}-\u{1F270}\u{238C}-\u{2454}\u{20D0}-\u{20FF}\u{FE00}-\u{FE0F}]/u;
    return emojiRegex.test(text);
  };

  const handleConditionChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
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
    setConditionText(newValue);
  };

  const handleConfirm = async () => {
    if (!loaUserId) return;
    if (!conditionText.trim()) {
      toast.error(t("approveCondition.required", "Please enter a condition"));
      return;
    }

    setApproving(true);
    try {
      const payload: {
        statusCode: string;
        signatureText?: string;
        signatureImageId?: number;
        approveWithCondition: string;
      } = {
        statusCode: "approved",
        approveWithCondition: conditionText.trim(),
      };

      if (requiresSignature) {
        if (sigMethod === "type") payload.signatureText = customSigText.trim();
        else if (sigMethod === "system" && chosenSigId)
          payload.signatureImageId = chosenSigId;
      }

      await onConfirm(loaUserId, payload);
      onClose();
    } catch (error) {
      console.error(error);
    } finally {
      setApproving(false);
    }
  };

  if (!isOpen) return null;

  const canConfirm =
    conditionText.trim().length > 0 &&
    (!requiresSignature || sigMethod !== null);

  return (
    <div className="fixed inset-0 bg-gray-900/70 backdrop-blur-sm z-[9999] flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden transform transition-all duration-300">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-amber-600 px-6 py-4">
          <div className="flex justify-between items-center">
            <h3 className="text-xl font-bold text-white tracking-tight">
              {t("approveCondition.modalTitle", "Approve With Condition")}
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
        <div className="p-6 max-h-[65vh] overflow-y-auto space-y-5">
          {/* Condition Text */}
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">
              {t("approveCondition.label", "Condition")}
              <span className="text-red-500 ml-1">*</span>
            </label>
            <textarea
              autoFocus
              rows={4}
              className={`w-full border rounded-xl p-3 focus:ring-2 transition-all shadow-sm resize-none ${
                hasEmoji || conditionText.length >= MAX_LENGTH
                  ? "border-red-500 focus:ring-red-400 focus:border-red-500"
                  : "border-gray-300 focus:ring-amber-400 focus:border-transparent"
              }`}
              placeholder={t(
                "approveCondition.placeholder",
                "Enter approval condition..."
              )}
              value={conditionText}
              onChange={handleConditionChange}
            />
            <div className="flex justify-between items-center mt-2">
              <div className="text-sm">
                {hasEmoji && (
                  <p className="text-red-600 font-medium">
                    {t("validation.noEmoji", "Emojis are not allowed")}
                  </p>
                )}
                {!hasEmoji && conditionText.length >= MAX_LENGTH && (
                  <p className="text-red-600 font-medium">
                    {t("validation.maxLength", "Maximum character limit reached")}
                  </p>
                )}
              </div>
              <p className={`text-sm ${
                conditionText.length >= MAX_LENGTH ? "text-red-600 font-semibold" : "text-gray-500"
              }`}>
                {conditionText.length}/{MAX_LENGTH}
              </p>
            </div>
          </div>

          {/* Signature Section (only if requires signature) */}
          {requiresSignature && (
            <>
              <div className="border-t pt-4">
                <p className="text-sm font-semibold text-gray-700 mb-3">
                  {t("approvers.sign", "Sign")}
                </p>
              </div>

              {/* Preview */}
              {sigMethod && (
                <div className="p-4 bg-gradient-to-br from-gray-50 to-gray-100 border border-gray-200 rounded-xl flex flex-col items-center justify-center shadow-inner min-h-[100px]">
                  <p className="text-sm text-gray-500 mb-2">
                    {t("approvers.example", "Preview")}
                  </p>
                  {customSigText ? (
                    <p
                      className="text-4xl font-signature"
                      style={{
                        fontFamily: "'Allura', cursive",
                        filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.1))",
                      }}
                    >
                      {customSigText}
                    </p>
                  ) : chosenSigId ? (
                    <div className="w-48 h-20 flex items-center justify-center">
                      {(() => {
                        const sig = userSignatures.find(
                          (s) => s.id === chosenSigId
                        );
                        if (!sig?.path) return null;
                        return (
                          <img
                            src={sigSrc(sig.id, sig.path)}
                            alt="signature"
                            className="max-w-full max-h-full object-contain"
                          />
                        );
                      })()}
                    </div>
                  ) : null}
                </div>
              )}

              {/* Type Method */}
              <div
                className={`p-4 rounded-xl border-2 transition-all cursor-pointer ${
                  sigMethod === "type"
                    ? "border-amber-500 bg-amber-50"
                    : "border-gray-200 hover:border-amber-300"
                }`}
                onClick={() => {
                  setSigMethod("type");
                  setCustomSigText(
                    effectiveDefaultSigText || myDisplayName || ""
                  );
                }}
              >
                <div className="flex items-center gap-4">
                  <div className="flex-shrink-0 bg-amber-100 p-3 rounded-lg">
                    ✍️
                  </div>
                  <div>
                    <h4 className="font-semibold text-gray-900">
                      {t("approvers.sigtext", "Type name")}
                    </h4>
                    <p className="text-gray-600 text-sm mt-1">
                      {t("approvers.signame", "Use typed name as signature")}
                    </p>
                  </div>
                  {sigMethod === "type" && (
                    <div className="ml-auto bg-amber-500 text-white rounded-full px-2 py-0.5 text-xs">
                      ✔
                    </div>
                  )}
                </div>
                {sigMethod === "type" && (
                  <div className="mt-4">
                    <input
                      type="text"
                      className="w-full border border-gray-200 rounded-lg p-3 focus:ring-2 focus:ring-amber-400 focus:border-transparent transition-all shadow-sm"
                      placeholder={t("approvers.sigfullnamePlaceholder")}
                      value={customSigText}
                      onChange={(e) => setCustomSigText(e.target.value)}
                    />
                  </div>
                )}
              </div>

              {/* System Method */}
              <div
                className={`p-4 rounded-xl border-2 transition-all cursor-pointer ${
                  sigMethod === "system"
                    ? "border-blue-500 bg-blue-50"
                    : "border-gray-200 hover:border-blue-300"
                }`}
                onClick={() => {
                  if (userSignatures.length > 0) {
                    setSigMethod("system");
                    setCustomSigText("");
                    if (!chosenSigId)
                      setChosenSigId(
                        defaultSignatureId || userSignatures[0].id
                      );
                  }
                }}
              >
                <div className="flex items-center gap-4">
                  <div className="flex-shrink-0 bg-blue-100 p-3 rounded-lg">
                    🖼️
                  </div>
                  <div>
                    <h4 className="font-semibold text-gray-900">
                      {t("approvers.sigimg", "Signature image")}
                    </h4>
                    <p className="text-gray-600 text-sm mt-1">
                      {t("approvers.sigsave", "Choose from saved signatures")}
                    </p>
                  </div>
                  {sigMethod === "system" && (
                    <div className="ml-auto bg-blue-500 text-white rounded-full px-2 py-0.5 text-xs">
                      ✔
                    </div>
                  )}
                </div>

                {sigMethod === "system" && (
                  <div className="mt-4">
                    {userSignatures.length > 0 ? (
                      <div className="grid grid-cols-2 gap-3">
                        {userSignatures.map((sig) => (
                          <div
                            key={sig.id}
                            className={`p-3 rounded-lg border transition-all cursor-pointer ${
                              chosenSigId === sig.id
                                ? "border-blue-500 bg-blue-50 ring-2 ring-blue-500/20"
                                : "border-gray-200 hover:border-blue-300"
                            }`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setChosenSigId(sig.id);
                            }}
                          >
                            <div className="flex flex-col items-center">
                              <div className="bg-white border rounded-lg p-1.5 w-full h-16 flex items-center justify-center mb-2">
                                <img
                                  src={sigSrc(sig.id, sig.path)}
                                  alt="signature"
                                  className="max-w-full max-h-full object-contain"
                                />
                              </div>
                              <span className="text-xs font-medium text-gray-900 truncate w-full text-center">
                                {sig.label || `Signature ${sig.id}`}
                                {defaultSignatureId === sig.id && (
                                  <span className="text-amber-600 text-xs ml-1">
                                    • {t("approvers.sigmain", "Default")}
                                  </span>
                                )}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-center py-4 bg-gray-50 rounded-lg border border-dashed border-gray-300">
                        <p className="text-gray-600 text-sm">
                          {t("approvers.signoinvalid", "No signatures found")}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-white border-t border-gray-200 p-4">
          <div className="flex justify-between items-center">
            <button
              onClick={onClose}
              className="px-4 py-2.5 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors font-medium text-sm"
            >
              {t("approveCondition.cancel", "Cancel")}
            </button>

            <button
              onClick={handleConfirm}
              disabled={approving || !canConfirm}
              className="flex items-center gap-2 px-4 py-2.5 rounded-lg
                text-white transition-colors font-medium text-sm
                disabled:opacity-60 disabled:cursor-not-allowed
                bg-amber-600 hover:bg-amber-700"
            >
              {approving ? (
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
                      d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                  {t("approveCondition.confirm", "Confirm Approval")}
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ApproveWithConditionModal;
