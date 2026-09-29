"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Board } from "@/components/board";
import { SendGate } from "@/components/send-gate";
import { Recommendation } from "@/components/recommendation";
import { Timeline } from "@/components/timeline";
import { ReviewQueue } from "@/components/review-queue";
import { StatusPill } from "@/components/status-pill";
import { useSession } from "@/lib/session";
import {
  Card,
  CardContent,
  CardHeader,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2 } from "lucide-react";

/**
 * A failed request is recoverable, not a dead end. The reason is shown in full
 * — a rate limit and a search that found nothing need different responses.
 */
function RetryRequest({
  requestId,
  reason,
}: {
  requestId: Id<"requests">;
  reason: string;
}) {
  const retry = useMutation(api.requests.retry);
  const { token } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setError(null);
    setBusy(true);
    try {
      if (!token) throw new Error("Your session expired. Please sign in again.");
      await retry({ sessionToken: token, requestId });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {reason}
      </p>
      {error && (
        <p className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <Button onClick={run} disabled={busy}>
        {busy ? "Retrying…" : "Try again"}
      </Button>
    </div>
  );
}

export function RequestView({ requestId }: { requestId: Id<"requests"> }) {
  const { token } = useSession();
  const request = useQuery(
    api.requests.get,
    token ? { sessionToken: token, requestId } : "skip",
  );
  const lineItems = useQuery(
    api.requests.lineItems,
    token ? { sessionToken: token, requestId } : "skip",
  );
  // Same query the board uses; Convex dedupes it, so this costs nothing extra.
  const rows = useQuery(
    api.board.forRequest,
    token ? { sessionToken: token, requestId } : "skip",
  );

  if (request === undefined) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (request === null) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-muted-foreground">That request no longer exists.</p>
        </CardContent>
      </Card>
    );
  }

  const working =
    request.status === "extracting" || request.status === "discovering";
  const confirmedCount = (rows ?? []).filter(
    (row) => row.track === "confirmed",
  ).length;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <h1 className="text-2xl font-semibold tracking-tight">
                {request.title}
              </h1>
              <p className="text-sm text-muted-foreground">{request.rawText}</p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <StatusPill status={request.status} />
              {confirmedCount > 0 && (
                <Badge variant="success">
                  {confirmedCount} quote{confirmedCount === 1 ? "" : "s"} in
                </Badge>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {working && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {request.status === "extracting"
                ? "Reading your requirement…"
                : "Searching the web for suppliers…"}
            </p>
          )}

          {request.status === "failed" && (
            <RetryRequest
              requestId={requestId}
              reason={request.failureReason ?? "This request failed."}
            />
          )}

          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                Deliver to
              </dt>
              <dd className="text-sm">{request.deliverTo}</dd>
            </div>
            {request.deliveryWindowDays !== undefined && (
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  Within
                </dt>
                <dd className="text-sm">{request.deliveryWindowDays} days</dd>
              </div>
            )}
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                Currency
              </dt>
              <dd className="text-sm">{request.currency}</dd>
            </div>
          </dl>

          {lineItems && lineItems.length > 0 && (
            <ul className="space-y-2 border-t pt-4">
              {lineItems.map((item) => (
                <li key={item._id} className="flex gap-2 text-sm">
                  <span className="font-medium tabular-nums">
                    {item.quantity} ×
                  </span>
                  <span>
                    {item.description}
                    {item.specs && Object.keys(item.specs).length > 0 && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {Object.entries(item.specs)
                          .map(([key, value]) => `${key} ${value}`)
                          .join(" · ")}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Board requestId={requestId} />
      <ReviewQueue requestId={requestId} />
      <SendGate requestId={requestId} />
      <Recommendation requestId={requestId} />
      <Timeline requestId={requestId} />
    </div>
  );
}
