import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import type { MemoType } from '../types';
import toast from 'react-hot-toast';

interface UseMemoTypesReturn {
  memoTypes: MemoType[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  retry: () => void;
}

export const useMemoTypes = (): UseMemoTypesReturn => {
  const [memoTypes, setMemoTypes] = useState<MemoType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const fetchMemoTypes = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      
      // Pass context=creation to indicate this is for memo creation page
      // DCC users should only see memo types from their primary BU + Additional Business Unit Access
      // NOT from DCC Management Business Units
      const { data } = await axios.get<MemoType[]>('/api/memotypes', {
        withCredentials: true,
        params: { context: 'creation' },
      });
      
      setMemoTypes(data);
    } catch (err: any) {
      console.error('❌ Failed to load memo types:', err);
      
      const errorMessage = err?.response?.data?.error || 
                          err?.response?.data?.message || 
                          'Failed to load memo types';
      
      setError(errorMessage);
      
      // Show toast notification for user feedback
      toast.error(errorMessage);
      
      // Auto-retry for network errors (up to 3 times)
      if (err?.code === 'NETWORK_ERROR' && retryCount < 3) {
        setTimeout(() => {
          setRetryCount(prev => prev + 1);
          fetchMemoTypes();
        }, 2000 * (retryCount + 1)); // Exponential backoff
      }
    } finally {
      setLoading(false);
    }
  }, [retryCount]);

  const refetch = useCallback(async () => {
    setRetryCount(0);
    await fetchMemoTypes();
  }, [fetchMemoTypes]);

  const retry = useCallback(() => {
    setRetryCount(0);
    fetchMemoTypes();
  }, [fetchMemoTypes]);

  useEffect(() => {
    fetchMemoTypes();
  }, [fetchMemoTypes]);

  return {
    memoTypes,
    loading,
    error,
    refetch,
    retry,
  };
};
