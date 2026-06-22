import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, Calendar, User, ExternalLink, Download, MessageSquare, Paperclip } from 'lucide-react';
import { api, isAuthError } from '../../lib/api';
import type { ReferenceMemoDetail } from './types';

interface ReferenceMemoViewerProps {
  memoId: number;
}

const ReferenceMemoViewer: React.FC<ReferenceMemoViewerProps> = ({ memoId }) => {
  const { t, i18n } = useTranslation('memoViewer');
  const [references, setReferences] = useState<ReferenceMemoDetail[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadReferences();
  }, [memoId]);

  const loadReferences = async () => {
    setIsLoading(true);
    try {
      const response = await api.get(`/api/memos/${memoId}/references`, {
        withCredentials: true
      });
      setReferences(response.data);
    } catch (error) {
      console.error('Failed to load references:', error);
      setReferences([]);
    } finally {
      setIsLoading(false);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString(i18n.language, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const formatCreatorName = (creator: { name: string; lastname?: string }) => {
    return [creator.name, creator.lastname].filter(Boolean).join(' ');
  };

  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case 'published':
      case 'approved':
        return 'bg-green-100 text-green-800';
      case 'draft':
        return 'bg-gray-100 text-gray-800';
      case 'pending':
        return 'bg-yellow-100 text-yellow-800';
      case 'rejected':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-blue-100 text-blue-800';
    }
  };

  const handleViewReference = (referenceId: number) => {
    // Directly open the referenced memo in a new tab
    // Note: Route is /memo/:id (singular), not /memos/:id (plural)
    window.open(`/memo/${referenceId}?mode=reference`, '_blank');
  };

  const handleDownloadPdf = (referenceId: number) => {
    window.open(`/api/memos/${referenceId}/download`, '_blank');
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-emerald-500 border-t-transparent"></div>
        <span className="ml-3 text-gray-600">{t('loading', 'Loading...')}</span>
      </div>
    );
  }

  if (references.length === 0) {
    return (
      <div className="text-center py-12">
        <FileText className="w-16 h-16 mx-auto mb-4 text-gray-300" />
        <h3 className="text-lg font-medium text-gray-900 mb-2">
          {t('noReferences', 'No Reference Memos')}
        </h3>
        <p className="text-gray-500">
          {t('noReferencesDescription', 'This memo does not reference any other memos.')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium text-gray-900">
          {t('referenceMemos', 'Reference Memos')} ({references.length})
        </h3>
      </div>

      <div className="grid gap-4">
        {references.map((reference) => (
          <div
            key={reference.id}
            className="bg-white border border-gray-200 rounded-lg p-4 hover:shadow-md transition-shadow"
          >
            <div className="flex items-start justify-between">
              <div className="flex-1 min-w-0">
                {/* Header */}
                <div className="flex items-start gap-3 mb-3">
                  <FileText className="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <h4 className="text-base font-medium text-gray-900 line-clamp-2 leading-6">
                        {reference.subject}
                      </h4>
                      {reference.memoNumber && (
                        <span className="text-sm text-gray-600 bg-gray-100 px-3 py-1 rounded-full flex-shrink-0">
                          {reference.memoNumber}
                        </span>
                      )}
                    </div>
                    
                    {/* Status and metadata */}
                    <div className="flex items-center gap-4 text-sm text-gray-500 mb-3">
                      <div className="flex items-center gap-1">
                        <User className="w-4 h-4" />
                        <span>{formatCreatorName(reference.createdBy)}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <Calendar className="w-4 h-4" />
                        <span>{formatDate(reference.createdAt)}</span>
                      </div>
                      <span className={`px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(reference.status)}`}>
                        {reference.status}
                      </span>
                    </div>

                    {/* Summary info */}
                    <div className="flex items-center gap-6 text-sm text-gray-500">
                      {reference.mainFiles && reference.mainFiles.length > 0 && (
                        <div className="flex items-center gap-1">
                          <FileText className="w-4 h-4" />
                          <span>{reference.mainFiles.length} main file(s)</span>
                        </div>
                      )}
                      {reference.attachedFiles && reference.attachedFiles.length > 0 && (
                        <div className="flex items-center gap-1">
                          <Paperclip className="w-4 h-4" />
                          <span>{reference.attachedFiles.length} attachment(s)</span>
                        </div>
                      )}
                      {reference.comments && reference.comments.length > 0 && (
                        <div className="flex items-center gap-1">
                          <MessageSquare className="w-4 h-4" />
                          <span>{reference.comments.length} comment(s)</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2 pt-3 border-t border-gray-100">
              <button
                onClick={() => handleViewReference(reference.id)}
                className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-emerald-700 bg-emerald-50 rounded-lg hover:bg-emerald-100 transition-colors"
              >
                <ExternalLink className="w-4 h-4" />
                {t('viewDetails', 'View Details')}
              </button>
              <button
                onClick={() => handleDownloadPdf(reference.id)}
                className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors"
              >
                <Download className="w-4 h-4" />
                {t('downloadPdf', 'Download PDF')}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default ReferenceMemoViewer;