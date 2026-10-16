import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useMemoTypes } from './hooks/useMemoTypes';
import { useModal } from './hooks/useModal';
import { useTableState } from './hooks/useTableState';
import MemoTypeTable from './components/MemoTypeTable';
import MemoTypeModal from './components/MemoTypeModal';
import toast from 'react-hot-toast';
import PageHeader from "../../components/ui/PageHeader";
import { btn } from "../../components/ui/button";
import { FileText, RefreshCw } from "lucide-react";

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
    <div className="w-full p-4 sm:p-6">
      <PageHeader
        icon={<FileText />}
        title={t('pageTitle', 'Document Types')}
        description={t('pageDescription', 'Browse and manage document type templates for memo creation')}
        actions={
          <button onClick={handleRefresh} disabled={loading} className={btn('secondary')}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            {t('refreshButton', 'Refresh')}
          </button>
        }
      />

      {!loading && (
        <div className="mb-4 flex flex-wrap gap-2 text-xs">
          {[
            [t('stats.totalTypes', 'Total Types'), memoTypes.length],
            [t('stats.activeTypes', 'Active Types'), memoTypes.filter(type => type.isActive).length],
          ].map(([label, n]) => (
            <span key={String(label)} className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1 text-gray-600 ring-1 ring-inset ring-gray-200">
              {label}
              <b className="font-semibold tabular-nums text-gray-900">{n}</b>
            </span>
          ))}
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