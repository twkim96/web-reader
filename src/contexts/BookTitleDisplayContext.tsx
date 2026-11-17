'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { getBookDisplayTitle } from '../lib/bookDisplayTitle';

const BookTitleDisplayContext = createContext<(name: string) => string>(getBookDisplayTitle);

export const BookTitleDisplayProvider = ({
  summarize,
  children,
}: {
  summarize: boolean;
  children: ReactNode;
}) => {
  const formatTitle = useMemo(() => (
    (name: string) => getBookDisplayTitle(name, summarize)
  ), [summarize]);
  return (
    <BookTitleDisplayContext.Provider value={formatTitle}>
      {children}
    </BookTitleDisplayContext.Provider>
  );
};

export const useBookTitleDisplay = () => useContext(BookTitleDisplayContext);
