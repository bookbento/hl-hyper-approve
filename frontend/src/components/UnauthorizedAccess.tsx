// src/components/UnauthorizedAccess.tsx
import React from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

interface UnauthorizedAccessProps {
  message?: string;
  showBackButton?: boolean;
}

const UnauthorizedAccess: React.FC<UnauthorizedAccessProps> = ({
  message,
  showBackButton = true,
}) => {
  const navigate = useNavigate();
  const { t } = useTranslation("common");

  const defaultMessage =
    message ||
    t(
      "unauthorized.message",
      "You do not have permission to access this page. Please contact your administrator."
    );

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-red-50 to-orange-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden">
        {/* Header with gradient */}
        <div className="bg-gradient-to-r from-red-500 to-orange-500 p-6">
          <div className="flex items-center justify-center">
            <div className="w-16 h-16 bg-white/20 backdrop-blur-sm rounded-full flex items-center justify-center">
              <svg
                className="w-10 h-10 text-white"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                />
              </svg>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="p-8 text-center space-y-4">
          <h2 className="text-2xl font-bold text-gray-800">
            {t("unauthorized.title", "403 - Access Denied")}
          </h2>
          <p className="text-gray-600 leading-relaxed">{defaultMessage}</p>

          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mt-4">
            <div className="flex items-start gap-3">
              <svg
                className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <div className="text-left">
                <p className="text-sm text-red-800">
                  {t(
                    "unauthorized.hint",
                    "If you believe you should have access to this page, please contact your administrator."
                  )}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        {showBackButton && (
          <div className="bg-gray-50 px-8 py-4 flex justify-center gap-3">
            <button
              onClick={() => navigate("/dashboard")}
              className="px-6 py-2.5 bg-gradient-to-r from-red-500 to-orange-500 text-white rounded-lg font-medium hover:from-red-600 hover:to-orange-600 transition-all duration-200 shadow-md hover:shadow-lg"
            >
              {t("unauthorized.backToDashboard", "Back to Dashboard")}
            </button>
            <button
              onClick={() => navigate(-1)}
              className="px-6 py-2.5 bg-white text-gray-700 border border-gray-300 rounded-lg font-medium hover:bg-gray-50 transition-all duration-200"
            >
              {t("unauthorized.goBack", "Go Back")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default UnauthorizedAccess;
