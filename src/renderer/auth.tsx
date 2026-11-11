import type { ReactNode } from "react";

export type AuthState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "signed-in"; user: AuthUser };
export interface AuthUser { id: string; name: string; email?: string; avatarUrl?: string }
interface AuthContextValue {
  state: AuthState;
  openSignIn: () => void;
  requestAccessToken: () => Promise<string | undefined>;
  signOut: () => Promise<void>;
}

// Retain the interface for local views without creating an account or cloud session.
const localAuth: AuthContextValue = {
  state: { status: "signed-out" },
  openSignIn: () => {},
  requestAccessToken: async () => undefined,
  signOut: async () => {},
};
export const localDebug = false;
export function AuthProvider({ children }: { children: ReactNode }) { return <>{children}</>; }
export function useAuth(): AuthContextValue { return localAuth; }
