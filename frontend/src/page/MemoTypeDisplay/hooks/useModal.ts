import { useState, useEffect, useCallback } from 'react';
import type { MemoType, ModalState } from '../types';

interface UseModalReturn {
  modalState: ModalState;
  openModal: (memoType: MemoType, mode?: 'view' | 'edit' | 'delete') => void;
  closeModal: () => void;
  setModalMode: (mode: 'view' | 'edit' | 'delete') => void;
}

export const useModal = (): UseModalReturn => {
  const [modalState, setModalState] = useState<ModalState>({
    isOpen: false,
    selectedMemoType: null,
    mode: 'view',
  });

  const openModal = useCallback((memoType: MemoType, mode: 'view' | 'edit' | 'delete' = 'view') => {
    setModalState({
      isOpen: true,
      selectedMemoType: memoType,
      mode,
    });
  }, []);

  const closeModal = useCallback(() => {
    setModalState({
      isOpen: false,
      selectedMemoType: null,
      mode: 'view',
    });
  }, []);

  const setModalMode = useCallback((mode: 'view' | 'edit' | 'delete') => {
    setModalState(prev => ({
      ...prev,
      mode,
    }));
  }, []);

  // Handle ESC key to close modal
  useEffect(() => {
    const handleEscKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && modalState.isOpen) {
        closeModal();
      }
    };

    if (modalState.isOpen) {
      document.addEventListener('keydown', handleEscKey);
      // Prevent body scroll when modal is open
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'unset';
    }

    return () => {
      document.removeEventListener('keydown', handleEscKey);
      document.body.style.overflow = 'unset';
    };
  }, [modalState.isOpen, closeModal]);

  // Focus management for accessibility
  useEffect(() => {
    if (modalState.isOpen) {
      // Focus the modal when it opens
      const modal = document.querySelector('[role="dialog"]') as HTMLElement;
      if (modal) {
        modal.focus();
      }
    }
  }, [modalState.isOpen]);

  return {
    modalState,
    openModal,
    closeModal,
    setModalMode,
  };
};
