"use client";

import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { formatTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { StatusDot } from "@/components/status-pill";
import { ThemeToggle } from "@/components/theme-toggle";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Plus, LogOut } from "lucide-react";

type SidebarProps = {
  selectedId: Id<"requests"> | null;
  onSelect: (id: Id<"requests">) => void;
  onNew: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * Request history. Procurement is repeat work — the same buyer sources the same
 * categories monthly — so past requests are navigation, not an archive.
 */
export function Sidebar(props: SidebarProps) {
  return (
    <>
      {/* Desktop: fixed rail. */}
      <aside className="hidden w-72 shrink-0 flex-col border-r bg-card lg:flex">
        <SidebarInner {...props} />
      </aside>

      {/* Mobile: slide-over drawer. */}
      <Sheet open={props.open} onOpenChange={props.onOpenChange}>
        <SheetContent side="left" className="w-72 p-0">
          <SidebarInner {...props} />
        </SheetContent>
      </Sheet>
    </>
  );
}

function SidebarInner({ selectedId, onSelect, onNew }: SidebarProps) {
  const { token, user, signOut } = useSession();
  const requests = useQuery(
    api.requests.list,
    token ? { sessionToken: token, limit: 30 } : "skip",
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 p-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary font-bold text-primary-foreground">
          Q
        </div>
        <div className="min-w-0">
          <div className="truncate font-semibold leading-tight">Quotebook</div>
          <div className="truncate text-xs text-muted-foreground">
            procurement, answered
          </div>
        </div>
        <div className="ml-auto hidden lg:block">
          <ThemeToggle />
        </div>
      </div>

      <div className="px-4">
        <Button className="w-full" onClick={onNew}>
          <Plus className="h-4 w-4" />
          New request
        </Button>
      </div>

      <nav aria-label="Request history" className="mt-6 flex-1 overflow-y-auto px-2">
        <h2 className="px-2 pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          History
        </h2>

        {requests === undefined ? (
          <ul className="space-y-1" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <li key={i} className="px-2">
                <Skeleton className="h-12 w-full" />
              </li>
            ))}
          </ul>
        ) : requests.length === 0 ? (
          <p className="px-2 text-sm text-muted-foreground">
            No requests yet. Your first one appears here.
          </p>
        ) : (
          <ul className="space-y-1">
            {requests.map((request) => {
              const active = request._id === selectedId;
              return (
                <li key={request._id}>
                  <button
                    onClick={() => onSelect(request._id)}
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      "flex w-full flex-col gap-1 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-accent",
                      active && "bg-accent",
                    )}
                  >
                    <span className="truncate font-medium">{request.title}</span>
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      <StatusDot status={request.status} />
                      <span>{formatTime(request._creationTime)}</span>
                      {request.confirmedQuotes > 0 && (
                        <span className="ml-auto rounded-full bg-success/15 px-1.5 py-0.5 font-medium text-success">
                          {request.confirmedQuotes} quote
                          {request.confirmedQuotes === 1 ? "" : "s"}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </nav>

      <div className="border-t p-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-semibold uppercase text-secondary-foreground">
            {(user?.name || user?.email || "?").slice(0, 1)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">
              {user?.name ?? "Signed in"}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {user?.email}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Sign out"
            onClick={() => void signOut()}
          >
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
