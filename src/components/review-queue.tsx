"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { toast } from "sonner";
import { formatTime } from "@/lib/format";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDown } from "lucide-react";
import { useSession } from "@/lib/session";

type HeldReply = {
  _id: Id<"inboundParses">;
  reason: string;
  fromAddress: string | null;
  preview: string;
  supplierName: string;
  receivedAt: number;
};

/**
 * Replies that arrived but were not turned into quotes.
 *
 * Without this the messy path is invisible: a supplier replies, the board still
 * reads "awaiting", and nothing on screen explains why.
 */
export function ReviewQueue({ requestId }: { requestId: Id<"requests"> }) {
  const { token } = useSession();
  const held = useQuery(
    api.inbound.reviewQueueForRequest,
    token ? { sessionToken: token, requestId } : "skip",
  );

  if (held === undefined || held.length === 0) return null;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div className="space-y-1.5">
          <CardTitle>Needs your review</CardTitle>
          <CardDescription>
            {held.length} repl{held.length === 1 ? "y" : "ies"} arrived but did
            not become a quote.
          </CardDescription>
        </div>
        <Badge variant="warning">held</Badge>
      </CardHeader>
      <CardContent>
        <ul className="space-y-3">
          {held.map((item) => (
            <ReviewItem key={item._id} item={item} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function ReviewItem({ item }: { item: HeldReply }) {
  const release = useMutation(api.inbound.releaseForParsing);
  const { token } = useSession();
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      if (!token) throw new Error("Your session expired. Please sign in again.");
      await release({ sessionToken: token, parseId: item._id });
      toast.success("Reading the message for a price.");
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">{item.supplierName}</span>
        {item.fromAddress && (
          <span className="font-mono text-xs text-muted-foreground">
            {item.fromAddress}
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          {formatTime(item.receivedAt)}
        </span>
      </div>

      <p className="mt-2 rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-sm text-warning">
        {item.reason}
      </p>

      {item.preview && (
        <Collapsible className="mt-2">
          <CollapsibleTrigger className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground [&[data-state=open]>svg]:rotate-180">
            Read the message
            <ChevronDown className="h-4 w-4 transition-transform" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">
              {item.preview}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      )}

      <Button
        className="mt-3"
        variant="outline"
        onClick={run}
        disabled={busy}
      >
        {busy ? "Reading it…" : "I trust this — read it for a price"}
      </Button>
    </li>
  );
}
