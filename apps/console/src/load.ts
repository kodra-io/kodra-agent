import { useCallback, useEffect, useState } from 'react';
import { SignedOut } from './api.ts';

/** Loads one API route; a 401 signs the page out. */
export function useLoad<T>(load: () => Promise<T>, onSignedOut: () => void) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    load()
      .then((data) => {
        if (alive) setState({ data, error: null, loading: false });
      })
      .catch((e: unknown) => {
        if (!alive) return;
        if (e instanceof SignedOut) {
          onSignedOut();
          return;
        }
        setState((s) => ({
          ...s,
          error: e instanceof Error ? e.message : String(e),
          loading: false,
        }));
      });
    return () => {
      alive = false;
    };
  }, [load, nonce, onSignedOut]);
  const reload = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    setNonce((n) => n + 1);
  }, []);
  return { ...state, reload };
}
