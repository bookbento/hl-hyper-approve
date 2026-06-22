import React, { useEffect, useRef } from "react";
import type { MemoType, ModalState } from "../types";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import toast from "react-hot-toast";
import LoadingScreen from "../../../components/Mhan";
import PDFViewer from "../../../components/PDFViewer";
import {
  FiHome,
  FiUsers,
  FiFileText,
  FiCalendar,
  FiCheckCircle,
  FiXCircle,
  FiEye,
} from "react-icons/fi";

interface MemoTypeModalProps {
  modalState: ModalState;
  onClose: () => void;
  onModeChange: (mode: "view" | "edit" | "delete") => void;
  onRefresh: () => void;
}
// ===== เพิ่ม helper ด้านบน component (ใต้ imports) =====
const resolveScope = (mt: any) => {
  if (mt?.forEveryone) {
    return {
      label: "Everyone",
      badge: "bg-green-100 text-green-800",
      buText: "—",
      deptText: "—",
    };
  }
  if (mt?.forEveryDepartmentAcrossBU) {
    return {
      label: "All Departments Across BU",
      badge: "bg-blue-100 text-blue-800",
      // ตอนนี้ Across BU เราบันทึก BU ด้วย → โชว์ BU ที่บันทึก
      buText: mt?.businessUnit?.name ?? mt?.team?.businessUnit?.name ?? "-",
      // และแผนกต้องมาจาก memoType.department
      deptText: mt?.department?.name ?? "-",
    };
  }
  if (mt?.forAllDepartmentUnderSelectedBu) {
    return {
      label: "Departments Under Selected BU",
      badge: "bg-purple-100 text-purple-800",
      buText: mt?.businessUnit?.name ?? mt?.team?.businessUnit?.name ?? "-",
      deptText: "All departments under this BU",
    };
  }
  // Team only
  return {
    label: "Team Only",
    badge: "bg-gray-100 text-gray-800",
    buText: mt?.businessUnit?.name ?? mt?.team?.businessUnit?.name ?? "-",
    // ถ้า type มี department ให้ใช้ก่อน ค่อย fallback ไป team.department
    deptText: mt?.department?.name ?? mt?.team?.department?.name ?? "-",
  };
};

const MemoTypeModal: React.FC<MemoTypeModalProps> = ({
  modalState,
  onClose,
  onModeChange,
  onRefresh,
}) => {
  const { t } = useTranslation("memoTypeDisplay");
  const navigate = useNavigate();
  const modalRef = useRef<HTMLDivElement>(null);
  const { isOpen, selectedMemoType, mode } = modalState;

  // State for detailed memo type data
  const [detailedMemoType, setDetailedMemoType] = React.useState<any>(null);
  const [loadingDetails, setLoadingDetails] = React.useState(false);
  const [isCreatingMemo, setIsCreatingMemo] = React.useState(false);
  
  // PDF Viewer state
  const [pdfViewerState, setPdfViewerState] = React.useState({
    isOpen: false,
    fileUrl: '',
    fileName: ''
  });

  // Focus management and fetch detailed data
  useEffect(() => {
    if (isOpen && modalRef.current) {
      modalRef.current.focus();
    }

    // Fetch detailed memo type data when modal opens
    if (isOpen && selectedMemoType && selectedMemoType.id) {
      fetchDetailedMemoType(selectedMemoType.id);
    }
  }, [isOpen, selectedMemoType]);

  // Fetch detailed memo type data including approval levels
  const fetchDetailedMemoType = async (typeId: number) => {
    try {
      setLoadingDetails(true);
      const { data } = await axios.get(`/api/memotypes/${typeId}`, {
        withCredentials: true,
      });
      setDetailedMemoType(data);
      
      // Log document type and line of approval information to console for testing
      console.log("=== MEMO TYPE DETAIL INFORMATION ===");
      console.log("Document Type ID:", data.id);
      console.log("Document Type Name:", data.name);
      console.log("Line of Approval ID:", data.approvalLineId || "N/A");
      console.log("Line of Approval Name:", data.approvalLine?.name || data.name || "N/A");
      console.log("=====================================");
      
    } catch (err: any) {
      console.error("Failed to fetch detailed memo type:", err);
      toast.error("Failed to load detailed information");
    } finally {
      setLoadingDetails(false);
    }
  };

  // Handle backdrop click
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  // Handle create memo navigation
  const handleCreateMemo = async () => {
    if (!selectedMemoType) return;
    
    setIsCreatingMemo(true);
    
    const typeId = selectedMemoType.id;

    // Show loading screen for better user experience
    await new Promise(resolve => setTimeout(resolve, 800));

    // Open in new tab
    const url = `/memos/new?typeId=${typeId}`;
    window.open(url, '_blank');
    
    setIsCreatingMemo(false);
  };
  // Handle edit navigation
  const handleEdit = () => {
    if (selectedMemoType) {
      // Navigate to existing memo type manager for editing
      navigate(`/memotype?edit=${selectedMemoType.id}`);
    }
  };

  // Handle delete with confirmation
  const handleDelete = async () => {
    if (!selectedMemoType) return;

    const confirmed = window.confirm(
      t(
        "deleteConfirmation",
        'Are you sure you want to delete "{{name}}"? This action cannot be undone.',
        {
          name: selectedMemoType.name,
        }
      )
    );

    if (!confirmed) return;

    try {
      await axios.delete(`/api/memotypes/${selectedMemoType.id}`, {
        withCredentials: true,
      });

      toast.success(t("deleteSuccess", "Memo type deleted successfully"));
      onClose();
      onRefresh();
    } catch (error: any) {
      console.error("Delete error:", error);
      if (error?.response?.status === 409) {
        const memoCount = error?.response?.data?.details?.memoCount || 0;
        toast.error(
          t("cannotDeleteInUse", {
            defaultValue: `Cannot delete this memo type because it is currently being used by ${memoCount} memo(s). Please remove or reassign those memos first.`,
            count: memoCount
          })
        );
      } else {
        const errorMessage =
          error?.response?.data?.error ||
          error?.response?.data?.message ||
          "Failed to delete memo type";
        toast.error(errorMessage);
      }
    }
  };

  // Format file size
  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  // Check if file is PDF
  const isPdfFile = (fileName: string) => {
    return fileName.toLowerCase().endsWith('.pdf');
  };

  // Handle PDF preview
  const handlePreviewPdf = (file: any) => {
    const fileUrl = `/api/secure-uploads/${encodeURI(file.filePath.replace(/^\/+/, ""))}`;
    setPdfViewerState({
      isOpen: true,
      fileUrl,
      fileName: file.fileName
    });
  };

  // Close PDF viewer
  const closePdfViewer = () => {
    setPdfViewerState({
      isOpen: false,
      fileUrl: '',
      fileName: ''
    });
  };

  // Get permission scope
  const getPermissionScope = () => {
    if (selectedMemoType?.forEveryone)
      return { label: "Everyone", color: "bg-green-100 text-green-800" };
    if (selectedMemoType?.forEveryDepartmentAcrossBU)
      return {
        label: "All Departments Across BU",
        color: "bg-blue-100 text-blue-800",
      };
    if (selectedMemoType?.forAllDepartmentUnderSelectedBu)
      return {
        label: "Departments Under Selected BU",
        color: "bg-purple-100 text-purple-800",
      };
    return { label: "Team Only", color: "bg-gray-100 text-gray-800" };
  };

  if (!isOpen || !selectedMemoType) return null;

  const displayMemoType = detailedMemoType || selectedMemoType;
  const typeFiles = displayMemoType.typeFiles ?? [];
  const visibleTypeFiles = displayMemoType.defaultTypeFileId
    ? typeFiles.filter((f: any) => f.id === displayMemoType.defaultTypeFileId)
    : typeFiles; // เผื่อกรณี type ไหนยังไม่ได้ตั้ง default

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: "#000000ab" }}
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      aria-describedby="modal-description"
    >
      {isCreatingMemo ? (
        <div className="bg-white rounded-xl shadow-2xl p-6 flex flex-col items-center justify-center h-[200px] w-[320px]">
          <LoadingScreen size={100} />
          <p className="text-sm text-gray-600 mt-3 font-medium">
            {t("loading.creatingMemo", "Preparing memo creation...")}
          </p>
        </div>
      ) : (
        <div
          ref={modalRef}
          className="bg-white rounded-xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-y-auto focus:outline-none"
          tabIndex={-1}
        >
        {/* Modal Header */}
        <div className="bg-gradient-to-r from-[#183e33] to-[#2a5a4a] text-white p-6">
          <div className="flex items-start justify-between">
            <div>
              <h2 id="modal-title" className="text-2xl font-bold mb-2">
                {selectedMemoType.name}
              </h2>
              {selectedMemoType.abbreviation && (
                <p className="text-lg opacity-90">
                  ({selectedMemoType.abbreviation})
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Modal Content */}
        <div id="modal-description" className="p-6 space-y-6">
          {/* Description */}
          {selectedMemoType.description && (
            <div>
              <h3 className="text-lg font-semibold text-gray-900 mb-4">
                Description
              </h3>
              <div className="bg-gray-50 p-4 rounded-lg">
                <p className="text-gray-700 leading-relaxed">
                  {selectedMemoType.description}
                </p>
              </div>
            </div>
          )}

          {/* Organizational Information */}
          <div>
            <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
              <FiHome className="w-5 h-5 mr-2" />
              Organizational Information
            </h3>

            {(() => {
              const scopeInfo = resolveScope(displayMemoType);

              return (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="bg-gray-50 p-4 rounded-lg">
                    <label className="block text-sm font-medium text-gray-600 mb-1">
                      Business Unit
                    </label>
                    <p className="text-gray-900 font-medium">
                      {scopeInfo.buText}
                    </p>
                  </div>

                  <div className="bg-gray-50 p-4 rounded-lg">
                    <label className="block text-sm font-medium text-gray-600 mb-1">
                      Department
                    </label>
                    <p className="text-gray-900 font-medium">
                      {scopeInfo.deptText}
                    </p>
                  </div>
                </div>
              );
            })()}
          </div>

          {/* Approval Levels */}
          {loadingDetails ? (
            <div>
              <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                <FiUsers className="w-5 h-5 mr-2" />
                Approval Levels
              </h3>
              <div className="bg-gray-50 p-4 rounded-lg">
                <div className="animate-pulse flex space-x-4">
                  <div className="rounded-full bg-gray-300 h-10 w-10"></div>
                  <div className="flex-1 space-y-2 py-1">
                    <div className="h-4 bg-gray-300 rounded w-3/4"></div>
                    <div className="h-4 bg-gray-300 rounded w-1/2"></div>
                  </div>
                </div>
              </div>
            </div>
          ) : displayMemoType.approvalLevels &&
            displayMemoType.approvalLevels.length > 0 ? (
            <div>
              <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                <FiUsers className="w-5 h-5 mr-2" />
                Approval Levels
              </h3>
              <div className="space-y-3">
                {displayMemoType.approvalLevels.map(
                  (level: any, index: number) => (
                    <div
                      key={level.level}
                      className="border border-gray-200 rounded-lg p-4 bg-[#e6e0b7]"
                    >
                      <div className="flex items-center justify-between mb-3">
                        <h4 className="font-medium text-gray-900">
                          Level {level.level + 1}
                          {level.users[0]?.roleDescription && (
                            <span className="text-sm text-gray-600 ml-2">
                              ({level.users[0].roleDescription})
                            </span>
                          )}
                        </h4>
                        {/* Show approval requirement badge for levels with multiple approvers */}
                        {level.users.length > 1 && (
                          <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${
                            level.users[0]?.approvalRequirement === "ANY" 
                              ? "bg-orange-100 text-orange-800 border border-orange-200" 
                              : "bg-green-100 text-green-800 border border-green-200"
                          }`}>
                            {level.users[0]?.approvalRequirement === "ANY" ? "Any Approval Required" : "All Approvals Required"}
                          </span>
                        )}
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {level.users.map((user: any) => (
                          <div
                            key={user.id}
                            className="flex items-center space-x-3 bg-gray-50 p-3 rounded-lg"
                          >
                            <div className="flex-shrink-0">
                              {user.isSigReq ? (
                                <FiCheckCircle className="w-4 h-4 text-green-500" />
                              ) : (
                                <FiXCircle className="w-4 h-4 text-gray-400" />
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-gray-900 truncate">
                                {user.nickname
                                  ? `${[user.name, user.lastname]
                                      .filter(Boolean)
                                      .join(" ")} (${user.nickname})`
                                  : [user.name, user.lastname]
                                      .filter(Boolean)
                                      .join(" ")}
                              </p>
                              <p className="text-xs text-gray-500">
                                {user.slotType === "FLEXIBLE_SLOT"
                                  ? "Flexible Slot"
                                  : user.slotType === "DEPARTMENT_HEAD"
                                  ? "Department Head"
                                  : user.slotType === "MEMO_REQUESTER"
                                  ? "Memo Requester"
                                  : "Fixed User"}
                                {user.isSigReq && " • Signature Required"}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                )}
              </div>
            </div>
          ) : (
            <div>
              <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                <FiUsers className="w-5 h-5 mr-2" />
                Approval Levels
              </h3>
              <div className="bg-gray-50 p-4 rounded-lg text-center text-gray-500">
                No approval levels configured for this document type
              </div>
            </div>
          )}

          {visibleTypeFiles && visibleTypeFiles.length > 0 && (
            <div>
              <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                <FiFileText className="w-5 h-5 mr-2" />
                Template Files
              </h3>
              <div className="space-y-3">
                {visibleTypeFiles.map((file: any) => (
                  <div
                    key={file.id}
                    className="flex items-center justify-between bg-gray-50 p-4 rounded-lg"
                  >
                    <div className="flex items-center space-x-3">
                      <FiFileText className="w-5 h-5 text-gray-500" />
                      <div>
                        <p className="font-medium text-gray-900">
                          {file.fileName}
                        </p>
                        <p className="text-sm text-gray-500">
                          {formatFileSize(file.size)}
                          {displayMemoType.defaultTypeFileId === file.id && (
                            <span className="ml-2 px-2 py-1 bg-blue-100 text-blue-800 text-xs rounded-full">
                              Default
                            </span>
                          )}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center space-x-2">
                      {isPdfFile(file.fileName) && (
                        <button
                          onClick={() => handlePreviewPdf(file)}
                          className="inline-flex items-center px-3 py-1 text-sm font-medium text-[#183e33] bg-green-50 border border-green-200 rounded-md hover:bg-green-100 transition-colors"
                        >
                          <FiEye className="w-4 h-4 mr-1" />
                          Preview
                        </button>
                      )}
                      <a
                        href={`/api/secure-uploads/${encodeURI(
                          file.filePath.replace(/^\/+/, "")
                        )}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[#183e33] hover:text-[#141716] font-medium text-sm"
                      >
                        Download
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Modal Actions */}
        <div className="flex flex-col sm:flex-row gap-3 p-6 border-t border-gray-200 bg-gray-50">
          <button
            onClick={handleCreateMemo}
            disabled={isCreatingMemo}
            className="flex-1 bg-[#183e33] text-white px-4 py-2 rounded-lg hover:bg-[#141716] transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isCreatingMemo ? t("loading.creating", "Creating...") : t("actions.createMemo", "Create memo with this document type")}
          </button>
        </div>
      </div>
      )}

      {/* PDF Viewer */}
      <PDFViewer
        isOpen={pdfViewerState.isOpen}
        onClose={closePdfViewer}
        fileUrl={pdfViewerState.fileUrl}
        fileName={pdfViewerState.fileName}
      />
    </div>
  );
};

export default MemoTypeModal;
