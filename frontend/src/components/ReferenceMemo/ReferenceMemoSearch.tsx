import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, FileText, Calendar, User, Loader2 } from 'lucide-react';
import type { ReferenceMemoSummary } from './types';

interface ReferenceMemoSearchProps {
  onSelect: (memo: ReferenceMemoSummary) => void;
  excludeIds?: number[];
  placeholder?: string;
  disabled?: boolean;
}

const ReferenceMemoSearch: React.FC<ReferenceMemoSearchProps> = ({
  onSelect,
  excludeIds = [],
  placeholder,
  disabled = false
}) => {
  const { t } = useTranslation('memoForm');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ReferenceMemoSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);

  const searchMemos = async (searchQuery: string) => {
    setIsLoading(true);
    try {
      const response = await fetch(`/api/memos/search-for-reference?q=${encodeURIComponent(searchQuery)}&exclude=${excludeIds.join(',')}&limit=10`, {
        credentials: 'include'
      });
      
      if (response.ok) {
        const data = await response.json();
        setResults(data);
      } else {
        setResults([]);
      }
    } catch (error) {
      console.error('Search failed:', error);
      setResults([]);
    } finally {
      setIsLoading(false);
    }
  };

  const loadRecentMemos = async () => {
    setIsLoading(true);
    try {
      const response = await fetch(`/api/memos/search-for-reference?exclude=${excludeIds.join(',')}&limit=10`, {
        credentials: 'include'
      });
      
      if (response.ok) {
        const data = await response.json();
        setResults(data);
      } else {
        setResults([]);
      }
    } catch (error) {
      console.error('Failed to load recent memos:', error);
      setResults([]);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (query.length >= 2) {
      const timer = setTimeout(() => {
        searchMemos(query);
      }, 300);
      return () => clearTimeout(timer);
    } else if (query.length === 0 && isOpen) {
      loadRecentMemos();
    } else {
      setResults([]);
    }
  }, [query, excludeIds, isOpen]);

  const handleSelect = (memo: ReferenceMemoSummary) => {
    onSelect(memo);
    setQuery('');
    setResults([]);
    setIsOpen(false);
  };

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

  return (
    <div className="relative">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIsOpen(true);
          }}
          onFocus={() => {
            setIsOpen(true);
            if (query.length === 0) {
              loadRecentMemos();
            }
          }}
          placeholder={placeholder || t('searchReferenceMemos', 'Search your memos to reference...')}
          className="w-full pl-10 pr-10 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 transition-colors"
          disabled={disabled}
        />
        {isLoading && (
          <div className="absolute right-3 top-1/2 transform -translate-y-1/2">
            <Loader2 className="w-4 h-4 animate-spin text-emerald-500" />
          </div>
        )}
      </div>

      {/* Search Results Dropdown */}
      {isOpen && (query.length >= 2 || (query.length === 0 && results.length > 0)) && (
        <>
          <div className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-80 overflow-hidden">
            <div className="max-h-80 overflow-y-auto">
              {isLoading ? (
                <div className="p-6 text-center">
                  <Loader2 className="w-6 h-6 animate-spin text-emerald-500 mx-auto mb-2" />
                  <p className="text-sm text-gray-500">{t('searching', 'Searching...')}</p>
                </div>
              ) : results.length === 0 ? (
                <div className="p-6 text-center">
                  <FileText className="w-8 h-8 text-gray-300 mx-auto mb-2" />
                  <p className="text-sm text-gray-500">
                    {query.length >= 2 
                      ? t('noMemosFound', 'No memos found')
                      : t('noRecentMemos', 'No recent memos')
                    }
                  </p>
                </div>
              ) : (
                <div className="py-1">
                  {query.length === 0 && (
                    <div className="px-4 py-2 text-xs text-gray-500 bg-gray-50 border-b border-gray-100">
                      {t('recentMemos', 'Recent Memos')}
                    </div>
                  )}
                  {results.map((memo, index) => (
                    <button
                      key={memo.id}
                      onClick={() => handleSelect(memo)}
                      className="w-full px-4 py-3 text-left hover:bg-gray-50 focus:bg-gray-50 focus:outline-none transition-colors border-b border-gray-100 last:border-b-0"
                    >
                      <div className="space-y-2">
                        {/* Title and Memo Number */}
                        <div className="flex items-start justify-between gap-2">
                          <h4 className="text-sm font-medium text-gray-900 line-clamp-2 flex-1">
                            {memo.subject}
                          </h4>
                          {memo.memoNumber && (
                            <span className="text-xs text-gray-600 bg-gray-100 px-2 py-1 rounded flex-shrink-0">
                              {memo.memoNumber}
                            </span>
                          )}
                        </div>

                        {/* Metadata */}
                        <div className="flex items-center gap-4 text-xs text-gray-500">
                          <div className="flex items-center gap-1">
                            <User className="w-3 h-3" />
                            <span>{formatCreatorName(memo.createdBy)}</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <Calendar className="w-3 h-3" />
                            <span>{formatDate(memo.createdAt)}</span>
                          </div>
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${getStatusColor(memo.status)}`}>
                            {memo.status}
                          </span>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsOpen(false)}
          />
        </>
      )}
    </div>
  );
};

export default ReferenceMemoSearch;