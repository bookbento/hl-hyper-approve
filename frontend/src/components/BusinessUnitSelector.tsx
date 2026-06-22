import React, { useEffect } from "react";
import { useTranslation } from "react-i18next";

// Export the BusinessUnit interface for use in other components
export interface BusinessUnit {
  id: number;
  name: string;
  abbreviation?: string | null;
  isPrimary?: boolean;
}

export interface BusinessUnitSelectorProps {
  /** Array of business units to display in the dropdown */
  businessUnits: BusinessUnit[];
  /** Currently selected business unit ID or 'all' */
  selectedId: number | "all";
  /** Callback when selection changes */
  onChange: (id: number | "all") => void;
  /** Key for session storage persistence */
  storageKey: string;
  /** Whether to show "All" option (default: true) */
  showAllOption?: boolean;
  /** Whether the selector is disabled */
  disabled?: boolean;
  /** Custom class name for the container */
  className?: string;
  /** Label text (optional, uses translation if not provided) */
  label?: string;
  /** Translation namespace for labels */
  translationNamespace?: string;
}

/**
 * BusinessUnitSelector - A reusable dropdown component for selecting business units
 * 
 * Features:
 * - Session storage persistence
 * - "All" option support
 * - Primary BU indicator
 * - Consistent styling with existing dropdowns
 */
const BusinessUnitSelector: React.FC<BusinessUnitSelectorProps> = ({
  businessUnits,
  selectedId,
  onChange,
  storageKey,
  showAllOption = true,
  disabled = false,
  className = "",
  label,
  translationNamespace = "common",
}) => {
  const { t } = useTranslation(translationNamespace);

  // Load from session storage on mount
  useEffect(() => {
    const stored = sessionStorage.getItem(storageKey);
    if (stored) {
      const parsedValue = stored === "all" ? "all" : Number(stored);
      // Only apply stored value if it's valid
      if (parsedValue === "all" || businessUnits.some(bu => bu.id === parsedValue)) {
        if (parsedValue !== selectedId) {
          onChange(parsedValue);
        }
      }
    }
  }, [storageKey, businessUnits]); // eslint-disable-line react-hooks/exhaustive-deps

  // Save to session storage when selection changes
  useEffect(() => {
    sessionStorage.setItem(storageKey, String(selectedId));
  }, [selectedId, storageKey]);

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    const newValue = value === "all" ? "all" : Number(value);
    onChange(newValue);
  };

  // Don't render if only one business unit (no need for selector)
  if (businessUnits.length <= 1 && !showAllOption) {
    return null;
  }

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {label && (
        <label className="text-sm font-medium text-gray-700 whitespace-nowrap">
          {label}
        </label>
      )}
      <select
        value={selectedId}
        onChange={handleChange}
        disabled={disabled}
        className="px-3 py-2 border border-gray-300 rounded-lg text-sm 
                   focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500
                   bg-white text-gray-700 min-w-[180px]
                   disabled:bg-gray-100 disabled:cursor-not-allowed"
      >
        {showAllOption && (
          <option value="all">
            {t("businessUnitSelector.all", "All Business Units")}
          </option>
        )}
        {businessUnits.map((bu) => (
          <option key={bu.id} value={bu.id}>
            {bu.abbreviation ? `${bu.name} (${bu.abbreviation})` : bu.name}
            {bu.isPrimary ? ` ★` : ""}
          </option>
        ))}
      </select>
    </div>
  );
};

export default BusinessUnitSelector;
