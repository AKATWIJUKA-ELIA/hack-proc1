"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";

const STORAGE_KEY = "quotebook.sessionToken";

type User = {
  _id: string;
  email: string;
  name: string | null;
};

type SessionValue = {
  /** The bearer token to pass to every request-scoped Convex call. */
  token: string | null;
  /** The signed-in user, undefined while loading, null when signed out. */
  user: User | null | undefined;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, name?: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  // `null` = definitely signed out; `undefined` = not yet read from storage.
  const [token, setToken] = useState<string | null | undefined>(undefined);

  // Hydrate the token from localStorage once on the client.
  useEffect(() => {
    try {
      setToken(localStorage.getItem(STORAGE_KEY));
    } catch {
      setToken(null);
    }
  }, []);

  const signInMutation = useMutation(api.auth.signIn);
  const signUpMutation = useMutation(api.auth.signUp);
  const signOutMutation = useMutation(api.auth.signOut);

  // `me` reactively reflects whether the token is still valid on the server.
  const me = useQuery(
    api.auth.me,
    token ? { sessionToken: token } : { sessionToken: undefined },
  );

  const persist = useCallback((next: string | null) => {
    setToken(next);
    try {
      if (next) localStorage.setItem(STORAGE_KEY, next);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Private mode or storage disabled — the in-memory token still works for
      // this tab; it just will not survive a reload.
    }
  }, []);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const res = await signInMutation({ email, password });
      persist(res.token);
    },
    [signInMutation, persist],
  );

  const signUp = useCallback(
    async (email: string, password: string, name?: string) => {
      const res = await signUpMutation({ email, password, name });
      persist(res.token);
    },
    [signUpMutation, persist],
  );

  const signOut = useCallback(async () => {
    const current = token;
    persist(null);
    if (current) {
      try {
        await signOutMutation({ sessionToken: current });
      } catch {
        // The local token is already cleared; a failed server delete only
        // leaves a row to expire on its own.
      }
    }
  }, [token, persist, signOutMutation]);

  // A stored token the server rejected (expired/deleted) → clear it so the UI
  // falls back to the auth screen instead of looping on a dead token.
  useEffect(() => {
    if (token && me === null) persist(null);
  }, [token, me, persist]);

  const value = useMemo<SessionValue>(() => {
    const stillReadingStorage = token === undefined;
    const waitingOnServer = token !== null && me === undefined;
    return {
      token: token ?? null,
      user: token ? me : null,
      loading: stillReadingStorage || waitingOnServer,
      signIn,
      signUp,
      signOut,
    };
  }, [token, me, signIn, signUp, signOut]);

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within <SessionProvider>");
  return ctx;
}

/**
 * The token for request-scoped Convex calls. Request-scoped queries accept an
 * optional token and reject when it is missing, so components read it here and
 * pass it through.
 */
export function useSessionToken(): string | null {
  return useSession().token;
}
