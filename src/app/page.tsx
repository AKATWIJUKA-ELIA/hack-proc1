"use client";

import { useState } from "react";
import type { Id } from "@convex/_generated/dataModel";
import { useSession } from "@/lib/session";
import { Sidebar } from "@/components/sidebar";
import { RequestForm } from "@/components/request-form";
import { RequestView } from "@/components/request-view";
import { AuthScreen } from "@/components/auth-screen";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Menu, Loader2 } from "lucide-react";

export default function Home() {
  const { user, loading } = useSession();
  const [requestId, setRequestId] = useState<Id<"requests"> | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  function open(id: Id<"requests">) {
    setRequestId(id);
    setMenuOpen(false);
  }

  // While the stored token is being validated, avoid flashing the auth screen.
  if (loading) {
    return (
      <div className="flex h-dvh items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user) {
    return <AuthScreen />;
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <Sidebar
        selectedId={requestId}
        onSelect={open}
        onNew={() => {
          setRequestId(null);
          setMenuOpen(false);
        }}
        open={menuOpen}
        onOpenChange={setMenuOpen}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur lg:hidden">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setMenuOpen(true)}
            aria-label="Open request history"
          >
            <Menu className="h-5 w-5" />
          </Button>
          <span className="font-semibold tracking-tight">Quotebook</span>
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </header>

        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
            {requestId === null ? (
              <RequestForm onCreated={open} />
            ) : (
              <RequestView requestId={requestId} />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
