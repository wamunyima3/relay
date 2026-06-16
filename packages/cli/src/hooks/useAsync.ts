import { useEffect, useState } from "react";

export interface AsyncState<T> {
  loading: boolean;
  error: Error | null;
  value: T | null;
}

/**
 * Run an async function once on mount (or when `deps` change) and track its
 * loading/error/value state. Guards against setting state after unmount.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ loading: true, error: null, value: null });

  useEffect(() => {
    let alive = true;
    setState({ loading: true, error: null, value: null });
    fn()
      .then((value) => alive && setState({ loading: false, error: null, value }))
      .catch((error: Error) => alive && setState({ loading: false, error, value: null }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}
