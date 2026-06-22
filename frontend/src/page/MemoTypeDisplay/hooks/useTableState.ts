// useTableState.ts
import { useState, useMemo, useCallback } from 'react';
import type { MemoType, TableState } from '../types';

interface UseTableStateReturn {
  tableState: TableState;
  filteredAndSortedData: MemoType[];
  totalFiltered: number;
  handleSort: (key: keyof MemoType) => void;
  handleSearch: (searchTerm: string) => void;
  handlePageChange: (page: number) => void;
  handlePageSizeChange: (pageSize: number) => void; // 0 = All
}

export const useTableState = (memoTypes: MemoType[]): UseTableStateReturn => {
  const [tableState, setTableState] = useState<TableState>({
    searchTerm: '',
    sortKey: 'name' as keyof MemoType,
    sortDirection: 'asc',
    currentPage: 1,
    pageSize: 30, // ✅ เริ่มที่ 30 (0 = All)
  });

  const collator = useMemo(
    () => new Intl.Collator('th-TH', { numeric: true, sensitivity: 'base' }),
    []
  );

  const compareStrings = useCallback((a?: string | null, b?: string | null) => {
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    return collator.compare(a, b);
  }, [collator]);

  const compareNumbers = useCallback((a?: number | null, b?: number | null) => {
    return (a ?? 0) - (b ?? 0);
  }, []);

  // 1) FILTER
  const filteredData = useMemo(() => {
    const term = tableState.searchTerm.trim().toLowerCase();
    if (!term) return memoTypes;

    return memoTypes.filter((m: any) =>
      m.name?.toLowerCase?.().includes(term) ||
      (m.abbreviation ?? '').toLowerCase().includes(term) ||
      (m.description ?? '').toLowerCase().includes(term) ||
      (m.businessUnit?.name ?? '').toLowerCase().includes(term) ||
      (m.department?.name ?? '').toLowerCase().includes(term) ||
      (m.team?.name ?? '').toLowerCase().includes(term)
    );
  }, [memoTypes, tableState.searchTerm]);

  // 2) SORT
  const sorted = useMemo(() => {
    const arr = [...filteredData];
    arr.sort((a: any, b: any) => {
      let result = 0;
      switch (tableState.sortKey) {
        case 'id': result = compareNumbers(a.id, b.id); break;
        case 'name': result = compareStrings(a.name, b.name); break;
        case 'abbreviation': result = compareStrings(a.abbreviation, b.abbreviation); break;
        case 'createdAt':
          result = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          break;
        case 'isActive': result = a.isActive === b.isActive ? 0 : a.isActive ? -1 : 1; break;
        case 'businessUnit': result = compareStrings(a.businessUnit?.name, b.businessUnit?.name); break;
        case 'department': result = compareStrings(a.department?.name, b.department?.name); break;
        case 'team': result = compareStrings(a.team?.name, b.team?.name); break;
        default:
          result = compareStrings(String(a?.[tableState.sortKey] ?? ''), String(b?.[tableState.sortKey] ?? ''));
      }
      return tableState.sortDirection === 'asc' ? result : -result;
    });
    return arr;
  }, [filteredData, tableState.sortKey, tableState.sortDirection, compareStrings, compareNumbers]);

  const totalFiltered = sorted.length;

  // 3) PAGINATION (ค้นหา => All)
  const paginated = useMemo(() => {
    const isSearching = tableState.searchTerm.trim().length > 0;
    const ps = isSearching
      ? totalFiltered           // ค้นหา = All
      : (tableState.pageSize && tableState.pageSize > 0 ? tableState.pageSize : totalFiltered); // 0 => All

    const maxPage = Math.max(1, Math.ceil(totalFiltered / Math.max(ps, 1)));
    const safePage = Math.min(tableState.currentPage, maxPage);
    const start = (safePage - 1) * ps;
    return sorted.slice(start, start + ps);
  }, [sorted, tableState.pageSize, tableState.currentPage, tableState.searchTerm, totalFiltered]);

  const handleSort = useCallback((key: keyof MemoType) => {
    setTableState(prev => ({
      ...prev,
      sortKey: key,
      sortDirection: prev.sortKey === key && prev.sortDirection === 'asc' ? 'desc' : 'asc',
      currentPage: 1,
    }));
  }, []);

  const handleSearch = useCallback((searchTerm: string) => {
    const hasTerm = searchTerm.trim().length > 0;
    setTableState(prev => ({
      ...prev,
      searchTerm,
      currentPage: 1,
      pageSize: hasTerm ? 0 : prev.pageSize, // ✅ พิมพ์ค้นหา = All
    }));
  }, []);

  const handlePageChange = useCallback((page: number) => {
    setTableState(prev => ({ ...prev, currentPage: Math.max(1, page) }));
  }, []);

  const handlePageSizeChange = useCallback((pageSize: number) => {
    setTableState(prev => ({ ...prev, pageSize, currentPage: 1 })); // 0 = All
  }, []);

  return {
    tableState,
    filteredAndSortedData: paginated,
    totalFiltered,
    handleSort,
    handleSearch,
    handlePageChange,
    handlePageSizeChange,
  };
};
