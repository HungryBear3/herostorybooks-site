import React from 'react';

interface PageSelectorProps {
  totalPages: number;
  selected: number;
  onSelect: (page: number) => void;
}

export const PageSelector: React.FC<PageSelectorProps> = ({ totalPages, selected, onSelect }) => {
  return (
    <div className="w-full max-w-xs">
      <label htmlFor="page-select" className="block mb-1 text-sm font-semibold">
        Select Page
      </label>
      <select
        id="page-select"
        value={selected}
        onChange={(e) => onSelect(Number(e.target.value))}
        className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
      >
        {Array.from({ length: totalPages }).map((_, idx) => (
          <option key={idx} value={idx}>
            Page {idx + 1}
          </option>
        ))}
      </select>
    </div>
  );
};
