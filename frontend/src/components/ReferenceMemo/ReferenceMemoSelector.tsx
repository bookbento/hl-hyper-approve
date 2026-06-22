import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import { Search, X, Plus, FileText, Calendar, User } from 'lucide-react';
import type { ReferenceMemoSummary } from './types';

interface ReferenceMemoSelectorProps {
  selectedReferences: ReferenceMemoSummary[];
  onReferencesChange: (references: ReferenceMemoSummary[]) => void;
  disabled?: boolean;
}

const ReferenceMemoSelector: React.FC<ReferenceMemoSelectorProps> = ({
  selectedReferences,
  onReferencesChange,
  disabled = false
}) => {
  const { t, i18n } = useTranslation('memoForm');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ReferenceMemoSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  // Debounced search
  const searchMemos = useCallback(
    async (query: string) => {
      setIsLoading(true);
      try {
        const excludeIds = selectedReferences.map(ref => ref.id);
        const response = await axios.get('/api/memos/search-for-reference', {
          params: {
            q: query,
            exclude: excludeIds.join(','),
            limit: 10
          },
          withCredentials: true
        });
        setSearchResults(response.data);
      } catch (error) {
        console.error('Search failed:', error);
        setSearchResults([]);
      } finally {
        setIsLoading(false);
      }
    },
    [selectedReferences]
  );

  // Load recent memos when field is focused
  const loadRecentMemos = useCallback(async () => {
    setIsLoading(true);
    try {
      const excludeIds = selectedReferences.map(ref => ref.id);
      const response = await axios.get('/api/memos/search-for-reference', {
        params: {
          exclude: excludeIds.join(','),
          limit: 10
        },
        withCredentials: true
      });
      setSearchResults(response.data);
    } catch (error) {
      console.error('Failed to load recent memos:', error);
      setSearchResults([]);
    } finally {
      setIsLoading(false);
    }
  }, [selectedReferences]);

  // Debounce search
  useEffect(() => {
    if (searchQuery.length >= 2) {
      const timer = setTimeout(() => {
        searchMemos(searchQuery);
      }, 300);
      return () => clearTimeout(timer);
    } else if (searchQuery.length === 0 && isSearchOpen) {
      // Load recent memos when search is cleared but dropdown is open
      loadRecentMemos();
    } else {
      setSearchResults([]);
    }
  }, [searchQuery, searchMemos, loadRecentMemos, isSearchOpen]);

  const handleAddReference = (memo: ReferenceMemoSummary) => {
    if (!selectedReferences.some(ref => ref.id === memo.id)) {
      onReferencesChange([...selectedReferences, memo]);
    }
    setSearchQuery('');
    setSearchResults([]);
    setIsSearchOpen(false);
  };

  const handleRemoveReference = (memoId: number) => {
    onReferencesChange(selectedReferences.filter(ref => ref.id !== memoId));
  };

  const formatDate = (dateString: string) => {
    const locale = i18n.language === 'th' ? 'th-TH' : 'en-US';
    return new Date(dateString).toLocaleDateString(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  };

  const formatCreatorName = (creator: { name: string; lastname?: string }) => {
    return [creator.name, creator.lastname].filter(Boolean).join(' ');
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="w-full">
        <div className="flex items-center justify-between mb-2">
          <label className="inline-block text-base font-semibold text-gray-700 px-3 py-1 bg-emerald-50 border-l-4 border-emerald-500 rounded-r">
            {t('referenceMemosLabel', 'Reference Memos')}
          </label>
          <span className="text-xs text-gray-500">
            {selectedReferences.length} {t('selected', 'selected')}
          </span>
        </div>
      </div>

      {/* Search Input */}
      <div className="relative">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setIsSearchOpen(true);
            }}
            onFocus={() => {
              setIsSearchOpen(true);
              if (searchQuery.length === 0) {
                loadRecentMemos();
              }
            }}
            placeholder={t('searchReferenceMemos', 'Search your memos to reference...')}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
            disabled={disabled}
          />
          {isLoading && (
            <div className="absolute right-3 top-1/2 transform -translate-y-1/2">
              <div className="animate-spin rounded-full h-4 w-4 border-2 border-emerald-500 border-t-transparent"></div>
            </div>
          )}
        </div>

        {/* Search Results Dropdown */}
        {isSearchOpen && (searchQuery.length >= 2 || (searchQuery.length === 0 && searchResults.length > 0)) && (
          <div className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-64 overflow-y-auto">
            {isLoading ? (
              <div className="p-4 text-center text-gray-500">
                <div className="animate-spin rounded-full h-6 w-6 border-2 border-emerald-500 border-t-transparent mx-auto mb-2"></div>
                {t('searching', 'Searching...')}
              </div>
            ) : searchResults.length === 0 ? (
              <div className="p-4 text-center text-gray-500">
                <FileText className="w-8 h-8 mx-auto mb-2 text-gray-300" />
                {searchQuery.length >= 2 ? t('noMemosFound', 'No memos found') : t('noRecentMemos', 'No recent memos')}
              </div>
            ) : (
              <div className="py-2">
                {searchQuery.length === 0 && (
                  <div className="px-4 py-2 text-xs text-gray-500 bg-gray-50 border-b border-gray-100">
                    {t('recentMemos', 'Recent Memos')}
                  </div>
                )}
                {searchResults.map((memo) => (
                  <button
                    key={memo.id}
                    onClick={() => handleAddReference(memo)}
                    className="w-full px-4 py-3 text-left hover:bg-gray-50 focus:bg-gray-50 focus:outline-none border-b border-gray-100 last:border-b-0"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-sm font-medium text-gray-900 truncate">
                            {memo.subject}
                          </span>
                          {memo.memoNumber && (
                            <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded">
                              {memo.memoNumber}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-4 text-xs text-gray-500">
                          <div className="flex items-center gap-1">
                            <User className="w-3 h-3" />
                            {formatCreatorName(memo.createdBy)}
                          </div>
                          <div className="flex items-center gap-1">
                            <Calendar className="w-3 h-3" />
                            {formatDate(memo.createdAt)}
                          </div>
                          <span className={`px-2 py-0.5 rounded text-xs ${
                            memo.status === 'Published' ? 'bg-green-100 text-green-800' :
                            memo.status === 'Draft' ? 'bg-gray-100 text-gray-800' :
                            'bg-blue-100 text-blue-800'
                          }`}>
                            {memo.status}
                          </span>
                        </div>
                      </div>
                      <Plus className="w-4 h-4 text-emerald-600 flex-shrink-0 ml-2" />
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Selected References */}
      {selectedReferences.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-gray-700">
            {t('selectedReferences', 'Selected References')}
          </h4>
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {selectedReferences.map((memo) => (
              <div
                key={memo.id}
                className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <FileText className="w-4 h-4 text-gray-400 flex-shrink-0" />
                    <span className="text-sm font-medium text-gray-900 truncate">
                      {memo.subject}
                    </span>
                    {memo.memoNumber && (
                      <span className="text-xs text-gray-500 bg-white px-2 py-0.5 rounded">
                        {memo.memoNumber}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-4 text-xs text-gray-500">
                    <div className="flex items-center gap-1">
                      <User className="w-3 h-3" />
                      {formatCreatorName(memo.createdBy)}
                    </div>
                    <div className="flex items-center gap-1">
                      <Calendar className="w-3 h-3" />
                      {formatDate(memo.createdAt)}
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => handleRemoveReference(memo.id)}
                  className="p-1 text-gray-400 hover:text-red-600 focus:outline-none focus:text-red-600"
                  disabled={disabled}
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Click outside to close search */}
      {isSearchOpen && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => setIsSearchOpen(false)}
        />
      )}
    </div>
  );
};

export default ReferenceMemoSelector;