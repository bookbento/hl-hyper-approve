import React from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

const DeletedMemo: React.FC = () => {
  const { t } = useTranslation("memoViewer");

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50 p-4">
      <div className="max-w-md w-full bg-white shadow-xl rounded-2xl p-8 text-center border border-gray-100">
        <div className="w-20 h-20 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-6">
          <svg
            className="w-10 h-10 text-red-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1-1H8a1 1 0 00-1 1v3M4 7h16"
            />
          </svg>
        </div>

        <h1 className="text-2xl font-bold text-gray-900 mb-2">
          {t("deleted.title", "Memo Deleted")}
        </h1>
        
        <p className="text-gray-500 mb-8 leading-relaxed">
          {t(
            "deleted.message",
            "This memo has been deleted and is no longer accessible. If you believe this is an error, please contact the administrator."
          )}
        </p>

        <div className="space-y-3">
          <Link
            to="/dashboard"
            className="block w-full px-5 py-3 text-sm font-medium text-white bg-blue-600 rounded-xl hover:bg-blue-700 transition-colors shadow-lg shadow-blue-600/20"
          >
            {t("deleted.backToDashboard", "Back to Dashboard")}
          </Link>
        </div>
      </div>
    </div>
  );
};

export default DeletedMemo;
