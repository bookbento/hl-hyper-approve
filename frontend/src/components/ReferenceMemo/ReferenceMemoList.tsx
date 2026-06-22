import React from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, Calendar, User, X, ExternalLink } from 'lucide-react';
import type { ReferenceMemoSummary } from './types';

interface ReferenceMemoListProps {
  references: ReferenceMemoSummary[];
  onRemove?: (memoId: number) => void;
  onView?: (memo: ReferenceMemoSummary) => void;
  readonly?: boolean;
  maxHeight?: string;
}

const ReferenceMemoList: React.FC<ReferenceMemoListProps> = ({
  references,
  onRemove,
  onView,
  readonly = false,
  maxHeight = 'max-h-64'
}) => {
  const { t } = useTranslation('memoForm');

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('th-TH', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  };

  const formatCreatorName = (creator: { name: string; lastname?: string }) => {
    return [creator.name, creator.lastname].filter(Boolean).join(' ');
  };

  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case 'published':
        return 'bg-green-100 text-green-800';
      case 'draft':
        return 'bg-gray-100 text-gray-800';
      case 'pending':
        return 'bg-yellow-100 text-yellow-800';
      case 'approved':
        return 'bg-blue-100 text-blue-800';
      case 'rejected':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  if (references.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500">
        <FileText className="w-12 h-12 mx-auto mb-3 text-gray-300" />
        <p className="text-sm">
          {readonly 
            ? t('noReferenceMemos', 'No reference memos')
            : t('noSelectedReferences', 'No references selected')
          }
        </p>
      </div>
    );
  }

  return (
    <div className={`space-y-3 overflow-y-auto ${maxHeight}`}>
      {references.map((memo, index) => (
        <div
          key={memo.id}
          className="group relative bg-white border border-gray-200 rounded-lg p-4 hover:shadow-md transition-shadow"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              {/* Header with title and memo number */}
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="flex items-start gap-2 flex-1 min-w-0">
                  <FileText className="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <h4 className="text-sm font-medium text-gray-900 line-clamp-2 leading-5">
                      {memo.subject}
                    </h4>
                  </div>
                </div>
                {memo.memoNumber && (
                  <span className="text-xs text-gray-600 bg-gray-100 px-2 py-1 rounded flex-shrink-0">
                    {memo.memoNumber}
                  </span>
                )}
              </div>

              {/* Metadata */}
              <div className="flex items-center gap-4 text-xs text-gray-500 mb-2">
                <div className="flex items-center gap-1">
                  <User className="w-3 h-3" />
                  <span>{formatCreatorName(memo.createdBy)}</span>
                </div>
                <div className="flex items-center gap-1">
                  <Calendar className="w-3 h-3" />
                  <span>{formatDate(memo.createdAt)}</span>
                </div>
              </div>

              {/* Status */}
              <div className="flex items-center justify-between">
                <span className={`inline-flex items-center px-2 py-1 rounded text-xs font-medium ${getStatusColor(memo.status)}`}>
                  {memo.status}
                </span>

                {/* Action buttons */}
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  {onView && (
                    <button
                      onClick={() => onView(memo)}
                      className="p-1 text-gray-400 hover:text-blue-600 focus:outline-none focus:text-blue-600 transition-colors"
                      title={t('viewMemo', 'View memo')}
                    >
                      <ExternalLink className="w-4 h-4" />
                    </button>
                  )}
                  {!readonly && onRemove && (
                    <button
                      onClick={() => onRemove(memo.id)}
                      className="p-1 text-gray-400 hover:text-red-600 focus:outline-none focus:text-red-600 transition-colors"
                      title={t('removeReference', 'Remove reference')}
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Reference indicator */}
          <div className="absolute top-2 left-2 w-1 h-6 bg-emerald-500 rounded-full opacity-60"></div>
        </div>
      ))}
    </div>
  );
};

export default ReferenceMemoList;