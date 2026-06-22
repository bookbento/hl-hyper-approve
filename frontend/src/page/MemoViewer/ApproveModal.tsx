import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { api, BASE_URL } from "../../lib/api";
import toast from "react-hot-toast";

// Use the same interface as used in other files
export interface UserSignature {
  id: number;
  path: string;
  label?: string;
}

interface ApproveModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (
    loaUserId: number,
    payload: {
      statusCode: string;
      signatureText?: string;
      signatureImageId?: number;
    }
  ) => Promise<void>;
  loaUserId: number | null;
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

const ApproveModal: React.FC<ApproveModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  loaUserId,
  userSignatures,
  defaultSignatureId,
  defaultSignatureText,
  meId,
  myDisplayName,
}) => {
  const { t } = useTranslation("memoViewer");

  const [sigMethod, setSigMethod] = useState<"type" | "system" | null>(null);
  const [chosenSigId, setChosenSigId] = useState<number | null>(null);
  const [customSigText, setCustomSigText] = useState("");
  const [approving, setApproving] = useState(false);
  const [savingDefaultSigText, setSavingDefaultSigText] = useState(false);
  const [localDefaultSigText, setLocalDefaultSigText] = useState<string | null>(
    null
  );

  const effectiveDefaultSigText = localDefaultSigText ?? defaultSignatureText;

  // Reset state when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      setSigMethod(null);
      setChosenSigId(null);
      setCustomSigText("");
    }
  }, [isOpen]);

  // Auto-fill text when method changes to type
  useEffect(() => {
    if (sigMethod === "type" && !customSigText.trim()) {
      setCustomSigText(effectiveDefaultSigText || myDisplayName || "");
    }
  }, [sigMethod, myDisplayName, effectiveDefaultSigText, customSigText]);

  const handleSaveDefaultSignatureText = async () => {
    if (!meId || !customSigText?.trim()) return;
    setSavingDefaultSigText(true);
    try {
      await api.put(
        `/api/users/${meId}`,
        { defaultSignatureText: customSigText.trim() },
        { withCredentials: true }
      );
      const trimmedValue = customSigText.trim();
      setLocalDefaultSigText(trimmedValue);
      setCustomSigText(trimmedValue);
      toast.success(
        t("approvers.saveForFutureSuccess", "Signature text saved for future use!")
      );
    } catch (err: any) {
      toast.error(
        err?.response?.data?.error ||
          t("approvers.saveForFutureFail", "Failed to save signature text")
      );
    } finally {
      setSavingDefaultSigText(false);
    }
  };

  const handleConfirm = async () => {
    if (!loaUserId) return;
    setApproving(true);
    try {
      const payload: {
        statusCode: string;
        signatureText?: string;
        signatureImageId?: number;
      } = { statusCode: "approved" };

      if (sigMethod === "type") payload.signatureText = customSigText.trim();
      else if (sigMethod === "system" && chosenSigId)
        payload.signatureImageId = chosenSigId;

      await onConfirm(loaUserId, payload);
      onClose();
    } catch (error) {
      console.error(error);
      // Toast is likely handled by the caller or we can show generic here
      // But usually caller handles success flow. If onConfirm throws, we catch here.
      toast.error(t("approvers.signfail"));
    } finally {
      setApproving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-gray-900/70 backdrop-blur-sm z-[9999] flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden transform transition-all duration-300">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-[#183e33] px-6 py-4">
          <div className="flex justify-between items-center">
            <h3 className="text-xl font-bold text-white tracking-tight">
              {t("approvers.sign", "ลงลายมือชื่อ")}
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
        <div className="p-6 max-h-[65vh] overflow-y-auto">
          {sigMethod && (
            <div className="mb-6 p-4 bg-gradient-to-br from-gray-50 to-gray-100 border border-gray-200 rounded-xl flex flex-col items-center justify-center shadow-inner min-h-[120px]">
              <p className="text-sm text-gray-500 mb-2">
                {t("approvers.example", "ตัวอย่าง")}
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
                    const sig = userSignatures.find((s) => s.id === chosenSigId);
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
                ? "border-emerald-500 bg-emerald-50"
                : "border-gray-200 hover:border-emerald-300"
            }`}
            onClick={() => {
              setSigMethod("type");
              setCustomSigText(effectiveDefaultSigText || myDisplayName || "");
            }}
          >
            <div className="flex items-center gap-4">
              <div className="flex-shrink-0 bg-emerald-100 p-3 rounded-lg">
                ✍️
              </div>
              <div>
                <h4 className="font-semibold text-gray-900">
                  {t("approvers.sigtext", "พิมพ์ชื่อ")}
                </h4>
                <p className="text-gray-600 text-sm mt-1">
                  {t("approvers.signame", "ใช้ชื่อพิมพ์เป็นลายเซ็น")}
                </p>
              </div>
              {sigMethod === "type" && (
                <div className="ml-auto bg-emerald-500 text-white rounded-full px-2 py-0.5 text-xs">
                  ✔
                </div>
              )}
            </div>
            {sigMethod === "type" && (
              <div className="mt-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {t("approvers.sigfullname", "ชื่อ-นามสกุล")}
                </label>
                <input
                  autoFocus
                  type="text"
                  className="w-full border border-gray-200 rounded-lg p-3 focus:ring-2 focus:ring-emerald-400 focus:border-transparent transition-all shadow-sm"
                  placeholder={t("approvers.sigfullnamePlaceholder")}
                  value={customSigText}
                  onChange={(e) => setCustomSigText(e.target.value)}
                />
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleSaveDefaultSignatureText();
                  }}
                  disabled={savingDefaultSigText || !customSigText?.trim()}
                  className="mt-3 w-full border border-gray-200 rounded-lg p-3 focus:ring-2 focus:ring-emerald-400 focus:border-transparent transition-all shadow-sm text-sm text-emerald-700 hover:bg-emerald-50 hover:border-emerald-300 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {savingDefaultSigText ? (
                     <>
                     <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                       <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                       <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                     </svg>
                     {t("approvers.saving", "Saving...")}
                   </>
                  ) : (
                    <>
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                      <path d="M7.707 10.293a1 1 0 10-1.414 1.414l3 3a1 1 0 001.414 0l3-3a1 1 0 00-1.414-1.414L11 11.586V6h5a2 2 0 012 2v7a2 2 0 01-2 2H4a2 2 0 01-2-2V8a2 2 0 012-2h5v5.586l-1.293-1.293zM9 4a1 1 0 012 0v2H9V4z" />
                    </svg>
                    {t("approvers.saveForFuture", "บันทึกไว้ใช้ครั้งต่อไป")}
                  </>
                  )}
                </button>
              </div>
            )}
          </div>

          {/* System Method */}
          <div
            className={`mt-4 p-4 rounded-xl border-2 transition-all cursor-pointer ${
              sigMethod === "system"
                ? "border-blue-500 bg-blue-50"
                : "border-gray-200 hover:border-blue-300"
            }`}
            onClick={() => {
              if (userSignatures.length > 0) {
                setSigMethod("system");
                setCustomSigText("");
                if (!chosenSigId)
                  setChosenSigId(defaultSignatureId || userSignatures[0].id);
              }
            }}
          >
            <div className="flex items-center gap-4">
              <div className="flex-shrink-0 bg-blue-100 p-3 rounded-lg">
                🖼️
              </div>
              <div>
                <h4 className="font-semibold text-gray-900">
                  {t("approvers.sigimg", "รูปภาพลายเซ็น")}
                </h4>
                <p className="text-gray-600 text-sm mt-1">
                  {t("approvers.sigsave", "เลือกจากลายเซ็นที่บันทึกไว้")}
                </p>
              </div>
              {sigMethod === "system" && (
                <div className="ml-auto bg-blue-500 text-white rounded-full px-2 py-0.5 text-xs">
                  ✔
                </div>
              )}
            </div>

            {sigMethod === "system" && (
              <div className="mt-4 space-y-4">
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
                                • {t("approvers.sigmain", "หลัก")}
                              </span>
                            )}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-4 bg-gray-50 rounded-lg border border-dashed border-gray-300">
                    <p className="text-gray-600 text-sm mb-3">
                      {t("approvers.signoinvalid", "ไม่พบลายเซ็น")}
                    </p>
                    {/* Add button logic could go here, but for now just text */}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-white border-t border-gray-200 p-4">
          <div className="flex justify-between items-center">
            <button
              onClick={() => {
                if (sigMethod) {
                  setSigMethod(null);
                  setChosenSigId(null);
                } else {
                  onClose();
                }
              }}
              className="px-4 py-2.5 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors font-medium text-sm"
            >
              {sigMethod
                ? t("approvers.btnCancel", "ยกเลิก")
                : t("approvers.btnClose", "ปิด")}
            </button>

            <button
              onClick={handleConfirm}
              disabled={approving}
              className="flex items-center gap-2 px-4 py-2.5 rounded-lg
         text-white transition-colors font-medium text-sm
         disabled:opacity-60
         bg-blue-500 hover:bg-blue-600"
            >
              {approving
                ? t("approvers.processing", "กำลังประมวลผล...")
                : t("approvers.signconfirm", "ยืนยันการลงนาม")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ApproveModal;
