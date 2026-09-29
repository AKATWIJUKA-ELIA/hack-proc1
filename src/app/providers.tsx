"use client";

import { ReactNode } from "react";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { ThemeProvider } from "next-themes";
import { SessionProvider } from "@/lib/session";

// NEXT_PUBLIC_CONVEX_URL is inlined into the browser bundle at build time and
// points at the Convex deployment that serves procurement data. A build without
// it can still render, but every live query stays pending — so we surface that
// explicitly rather than spinning forever.
const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;

const convex = convexUrl ? new ConvexReactClient(convexUrl) : null;

export function Providers({ children }: { children: ReactNode }) {
  if (!convex) {
    return (
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <div className="mx-auto max-w-lg px-6 py-20">
          <div className="rounded-lg border bg-card p-6 text-card-foreground shadow-sm">
            <h2 className="text-lg font-semibold">Backend not configured</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              This build has no{" "}
              <code className="rounded bg-muted px-1 py-0.5">
                NEXT_PUBLIC_CONVEX_URL
              </code>
              , so it cannot reach its Convex deployment. Set it in{" "}
              <code className="rounded bg-muted px-1 py-0.5">.env.local</code> and
              restart.
            </p>
          </div>
        </div>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <ConvexProvider client={convex}>
        <SessionProvider>{children}</SessionProvider>
      </ConvexProvider>
    </ThemeProvider>
  );
}
