import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useMemoTypes } from './hooks/useMemoTypes';
import { useModal } from './hooks/useModal';
import { useTableState } from './hooks/useTableState';
import MemoTypeTable from './components/MemoTypeTable';
import MemoTypeModal from './components/MemoTypeModal';
import toast from 'react-hot-toast';

const MemoTypeDisplay: React.FC = () => {
  const { t } = useTranslation('memoTypeDisplay');
  const navigate = useNavigate();
  
  // Custom hooks
  const { memoTypes, loading, error, refetch, retry } = useMemoTypes();
  const { modalState, openModal, closeModal, setModalMode } = useModal();
const {
  tableState,
  filteredAndSortedData,
  totalFiltered,            // ← เพิ่ม
  handleSort,
  handleSearch,
  handlePageChange,
  handlePageSizeChange,
} = useTableState(memoTypes);

  // Handle row click to open modal
  const handleRowClick = (memoType: any) => {
    openModal(memoType, 'view');
  };

  // Handle refresh after operations
  const handleRefresh = async () => {
    try {
      await refetch();
      toast.success(t('refreshSuccess', 'Data refreshed successfully'));
    } catch (error) {
      toast.error(t('refreshError', 'Failed to refresh data'));
    }
  };

  // Error boundary fallback
  if (error && !loading) {
    return (
      <div className="p-6 max-w-7xl mx-auto">
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
          <div className="flex flex-col items-center">
            <svg className="w-12 h-12 text-red-400 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
            <h3 className="text-lg font-medium text-red-800 mb-2">
              {t('errorTitle', 'Unable to load document types')}
            </h3>
            <p className="text-red-600 mb-4">{error}</p>
            <button
              onClick={retry}
              className="bg-red-600 text-white px-4 py-2 rounded-lg hover:bg-red-700 transition-colors"
            >
              {t('retryButton', 'Try Again')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 w-full">
      {/* Page Header */}
      <div className="mb-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold text-[#183e33] mb-2">
              {t('pageTitle', 'Document Types')}
            </h1>
            <p className="text-gray-600">
              {t('pageDescription', 'Browse and manage document type templates for memo creation')}
            </p>
          </div>
          
          {/* Refresh Button */}
          <div className="mt-4 sm:mt-0">
            <button
              onClick={handleRefresh}
              disabled={loading}
              className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#183e33] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg
                className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
              {t('refreshButton', 'Refresh')}
            </button>
          </div>
        </div>
      </div>

      {/* Stats Cards */}
      {!loading && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <div className="w-8 h-8 bg-blue-500 rounded-md flex items-center justify-center">
                  <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </div>
              </div>
              <div className="ml-5 w-0 flex-1">
                <dl>
                  <dt className="text-sm font-medium text-gray-500 truncate">
                    {t('stats.totalTypes', 'Total Types')}
                  </dt>
                  <dd className="text-lg font-medium text-gray-900">{memoTypes.length}</dd>
                </dl>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <div className="w-8 h-8 bg-green-500 rounded-md flex items-center justify-center">
                  <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
              </div>
              <div className="ml-5 w-0 flex-1">
                <dl>
                  <dt className="text-sm font-medium text-gray-500 truncate">
                    {t('stats.activeTypes', 'Active Types')}
                  </dt>
                  <dd className="text-lg font-medium text-gray-900">
                    {memoTypes.filter(type => type.isActive).length}
                  </dd>
                </dl>
              </div>
            </div>
          </div>

          
        </div>
      )}

      {/* Main Table */}
      <MemoTypeTable
        memoTypes={memoTypes}
        loading={loading}
        tableState={tableState}
        onRowClick={handleRowClick}
        onSort={handleSort}
        onSearch={handleSearch}
        onPageChange={handlePageChange}
        onPageSizeChange={handlePageSizeChange}
        totalFiltered={totalFiltered}
      />

      {/* Modal */}
      <MemoTypeModal
        modalState={modalState}
        onClose={closeModal}
        onModeChange={setModalMode}
        onRefresh={handleRefresh}
      />
    </div>
  );
};

export default MemoTypeDisplay;