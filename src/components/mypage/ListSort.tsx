'use client';

import { ChevronDown } from 'lucide-react';

export function ListSort<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (value: T) => void;
}) {
  return (
    <label className="relative inline-flex min-h-11 shrink-0 items-center gap-1 rounded-sm px-1 text-xs font-medium opacity-75 hover:opacity-100 focus-within:outline-2 focus-within:outline-accent-500 sm:text-sm">
      <span aria-hidden="true">{options.find(([id]) => id === value)?.[1]}</span>
      <ChevronDown size={14} aria-hidden="true" />
      <select aria-label={label} value={value}
        onChange={({ currentTarget }) => onChange(currentTarget.value as T)}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0">
        {options.map(([id, text]) => <option key={id} value={id}>{text}</option>)}
      </select>
    </label>
  );
}
