import React, { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import axios from "axios";
import toast from "react-hot-toast";
import {
  FiArrowLeft,
  FiEdit,
  FiTrash2,
  FiFileText,
  FiUsers,
  FiHome,
  FiCalendar,
  FiCheckCircle,
  FiXCircle,
} from "react-icons/fi";

interface MemoType {
  id: number;
  name: string;
  description: string;
  abbreviation: string;
  isActive: boolean;
  createdAt: string;
  updatedAt?: string;

  // Organizational
  teamId?: number | null;
  team?: {
    id: number;
    name: string;
    businessUnit?: { id: number; name: string };
  } | null;
  businessUnitId?: number | null;
  businessUnit?: { id: number; name: string } | null;

  // Permission flags
  forEveryone?: boolean;
  forAllDepartmentUnderSelectedBu?: boolean;
  forEveryDepartmentAcrossBU?: boolean;
  department?: { id: number; name: string } | null;
  // Files
  defaultTypeFileId?: number | null;
  typeFiles?: {
    id: number;
    fileName: string;
    filePath: string;
    size: number;
    orderNo: number;
  }[];

  // Approval levels
  approvalLevels?: {
    level: number;
    users: {
      id: number;
      name: string;
      lastname?: string | null;
      nickname?: string | null;
      isSigReq?: boolean;
      slotType?: string;
      roleDescription?: string;
    }[];
  }[];
}

const MemoTypeDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation("memoTypeDetail");

  const [memoType, setMemoType] = useState<MemoType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (id) {
      fetchMemoType(id);
    }
  }, [id]);

  const fetchMemoType = async (typeId: string) => {
    try {
      setLoading(true);
      setError(null);
      const { data } = await axios.get<MemoType>(`/api/memotypes/${typeId}`, {
        withCredentials: true,
      });
      setMemoType(data);
    } catch (err: any) {
      console.error("Failed to fetch memo type:", err);
      setError(err?.response?.data?.error || "Failed to load document type");
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = () => {
    if (memoType) {
      navigate(`/memotype-manager?edit=${memoType.id}`);
    }
  };

  const handleDelete = async () => {
    if (!memoType) return;

    const confirmed = window.confirm(
      t("confirmDelete", { name: memoType.name })
    );

    if (!confirmed) return;

    try {
      await axios.delete(`/api/memotypes/${memoType.id}`, {
        withCredentials: true,
      });
      toast.success(t("deleteSuccess"));
      navigate("/memotype");
    } catch (error: any) {
      console.error("Delete error:", error);
      if (error?.response?.status === 409) {
        const memoCount = error?.response?.data?.details?.memoCount || 0;
        toast.error(t("cannotDeleteInUse", { count: memoCount }));
      } else {
        const errorMessage = error?.response?.data?.error || t("deleteError");
        toast.error(errorMessage);
      }
    }
  };

  const handleCreateMemo = () => {
    if (memoType) {
      navigate(`/memos/new?typeId=${memoType.id}`);
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  const getPermissionScope = () => {
    if (memoType?.forEveryone)
      return {
        label: t("permissions.everyone"),
        color: "bg-green-100 text-green-800",
      };
    if (memoType?.forEveryDepartmentAcrossBU)
      return {
        label: t("permissions.allDepartmentsAcrossBU"),
        color: "bg-blue-100 text-blue-800",
      };
    if (memoType?.forAllDepartmentUnderSelectedBu)
      return {
        label: t("permissions.departmentsUnderSelectedBU"),
        color: "bg-purple-100 text-purple-800",
      };
    return {
      label: t("permissions.teamOnly"),
      color: "bg-gray-100 text-gray-800",
    };
  };

  if (loading) {
    return (
      <div className="p-6 max-w-7xl mx-auto">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-200 rounded w-1/4 mb-6"></div>
          <div className="space-y-4">
            <div className="h-4 bg-gray-200 rounded w-3/4"></div>
            <div className="h-4 bg-gray-200 rounded w-1/2"></div>
            <div className="h-4 bg-gray-200 rounded w-2/3"></div>
          </div>
        </div>
      </div>
    );
  }

  if (error || !memoType) {
    return (
      <div className="p-6 max-w-7xl mx-auto">
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
          <FiXCircle className="w-12 h-12 text-red-400 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-red-800 mb-2">
            {t("error.title")}
          </h3>
          <p className="text-red-600 mb-4">{error}</p>
          <button
            onClick={() => navigate("/memotype")}
            className="bg-red-600 text-white px-4 py-2 rounded-lg hover:bg-red-700 transition-colors"
          >
            {t("error.backButton")}
          </button>
        </div>
      </div>
    );
  }

  const permissionScope = getPermissionScope();

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center space-x-4">
          <button
            onClick={() => navigate("/memotype")}
            className="flex items-center text-gray-600 hover:text-gray-900 transition-colors"
          >
            <FiArrowLeft className="w-5 h-5 mr-2" />
            {t("backToList")}
          </button>
        </div>

        <div className="flex items-center space-x-3">
          <button
            onClick={handleCreateMemo}
            className="bg-[#183e33] text-white px-4 py-2 rounded-lg hover:bg-[#141716] transition-colors flex items-center"
          >
            <FiFileText className="w-4 h-4 mr-2" />
            {t("createMemo")}
          </button>
          <button
            onClick={handleEdit}
            className="border border-gray-300 text-gray-700 px-4 py-2 rounded-lg hover:bg-gray-50 transition-colors flex items-center"
          >
            <FiEdit className="w-4 h-4 mr-2" />
            {t("edit")}
          </button>
          <button
            onClick={handleDelete}
            className="bg-red-600 text-white px-4 py-2 rounded-lg hover:bg-red-700 transition-colors flex items-center"
          >
            <FiTrash2 className="w-4 h-4 mr-2" />
            {t("delete")}
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="bg-white rounded-xl shadow-lg overflow-hidden">
        {/* Title Section */}
        <div className="bg-gradient-to-r from-[#183e33] to-[#2a5a4a] text-white p-8">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-3xl font-bold mb-2">{memoType.name}</h1>
              {memoType.abbreviation && (
                <p className="text-lg opacity-90">({memoType.abbreviation})</p>
              )}
            </div>
            <div className="flex items-center space-x-4">
              <span
                className={`px-3 py-1 rounded-full text-sm font-medium ${permissionScope.color}`}
              >
                {permissionScope.label}
              </span>
              <span
                className={`px-3 py-1 rounded-full text-sm font-medium ${
                  memoType.isActive
                    ? "bg-green-100 text-green-800"
                    : "bg-red-100 text-red-800"
                }`}
              >
                {memoType.isActive ? t("status.active") : t("status.inactive")}
              </span>
            </div>
          </div>
        </div>

        <div className="p-8 space-y-8">
          {/* Description */}
          {memoType.description && (
            <div>
              <h2 className="text-xl font-semibold text-gray-900 mb-3">
                {t("sections.description")}
              </h2>
              <div className="bg-gray-50 p-4 rounded-lg">
                <p className="text-gray-700 leading-relaxed">
                  {memoType.description}
                </p>
              </div>
            </div>
          )}

          {/* Organizational Information */}
          <div>
            <h2 className="text-xl font-semibold text-gray-900 mb-4 flex items-center">
              <FiHome className="w-5 h-5 mr-2" />
              {t("sections.organizationalInfo")}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="bg-gray-50 p-4 rounded-lg">
                <label className="block text-sm font-medium text-gray-600 mb-1">
                  {t("fields.businessUnit")}
                </label>
                <p className="text-gray-900 font-medium">
                  {memoType.businessUnit?.name ||
                    memoType.team?.businessUnit?.name ||
                    "-"}
                </p>
              </div>

              <div className="bg-gray-50 p-4 rounded-lg">
                <label className="block text-sm font-medium text-gray-600 mb-1">
                  {t("fields.team")}
                </label>
                <p className="text-gray-900 font-medium">
                  {memoType.team?.name || "-"}
                </p>
              </div>

              {memoType.department && (
                <div className="bg-gray-50 p-4 rounded-lg">
                  <label className="block text-sm font-medium text-gray-600 mb-1">
                    {t("fields.department")}
                  </label>
                  <p className="text-gray-900 font-medium">
                    {memoType.department.name}
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Approval Levels */}
          {memoType.approvalLevels && memoType.approvalLevels.length > 0 && (
            <div>
              <h2 className="text-xl font-semibold text-gray-900 mb-4 flex items-center">
                <FiUsers className="w-5 h-5 mr-2" />
                {t("sections.approvalLevels")}
              </h2>
              <div className="space-y-4">
                {memoType.approvalLevels.map((level, index) => (
                  <div
                    key={level.level}
                    className="border border-gray-200 rounded-lg p-4"
                  >
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="font-medium text-gray-900">
                        {t("approvalLevel.level", { level: level.level + 1 })}
                        {level.users[0]?.roleDescription && (
                          <span className="text-sm text-gray-600 ml-2">
                            ({level.users[0].roleDescription})
                          </span>
                        )}
                      </h3>
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
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                      {level.users.map((user) => (
                        <div
                          key={user.id}
                          className="flex items-center space-x-3 bg-gray-50 p-3 rounded-lg"
                        >
                          <div className="flex-shrink-0">
                            {user.isSigReq ? (
                              <FiCheckCircle className="w-5 h-5 text-green-500" />
                            ) : (
                              <FiXCircle className="w-5 h-5 text-gray-400" />
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
                                ? t("approvalLevel.flexibleSlot")
                                : user.slotType === "DEPARTMENT_HEAD"
                                ? t("approvalLevel.departmentHead")
                                : user.slotType === "MEMO_REQUESTER"
                                ? t("approvalLevel.memoRequester")
                                : t("approvalLevel.fixedUser")}
                              {user.isSigReq &&
                                ` • ${t("approvalLevel.signatureRequired")}`}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Files */}
          {memoType.typeFiles && memoType.typeFiles.length > 0 && (
            <div>
              <h2 className="text-xl font-semibold text-gray-900 mb-4 flex items-center">
                <FiFileText className="w-5 h-5 mr-2" />
                {t("sections.templateFiles")}
              </h2>
              <div className="space-y-3">
                {memoType.typeFiles.map((file) => (
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
                          {memoType.defaultTypeFileId === file.id && (
                            <span className="ml-2 px-2 py-1 bg-blue-100 text-blue-800 text-xs rounded-full">
                              {t("fields.defaultFile")}
                            </span>
                          )}
                        </p>
                      </div>
                    </div>
                    <a
                      href={`/api/secure-uploads/${encodeURI(
                        file.filePath.replace(/^\/+/, "")
                      )}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[#183e33] hover:text-[#141716] font-medium text-sm"
                    >
                      {t("files.download")}
                    </a>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Metadata */}
          <div>
            <h2 className="text-xl font-semibold text-gray-900 mb-4 flex items-center">
              <FiCalendar className="w-5 h-5 mr-2" />
              {t("sections.metadata")}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="bg-gray-50 p-4 rounded-lg">
                <label className="block text-sm font-medium text-gray-600 mb-1">
                  {t("fields.createdDate")}
                </label>
                <p className="text-gray-900 font-medium">
                  {new Date(memoType.createdAt).toLocaleDateString("th-TH", {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
              </div>

              {memoType.updatedAt && (
                <div className="bg-gray-50 p-4 rounded-lg">
                  <label className="block text-sm font-medium text-gray-600 mb-1">
                    {t("fields.lastUpdated")}
                  </label>
                  <p className="text-gray-900 font-medium">
                    {new Date(memoType.updatedAt).toLocaleDateString("th-TH", {
                      year: "numeric",
                      month: "long",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MemoTypeDetail;
