import { createContext, useContext } from 'react';
import type { StatusView } from './api.ts';

/** The agent's status, loaded by the shell and shared with pages, and a way to refresh it. */
export const StatusContext = createContext<{
  status: StatusView | null;
  pending: number;
  refresh: () => void;
}>({ status: null, pending: 0, refresh: () => undefined });

export function useStatus() {
  return useContext(StatusContext);
}
