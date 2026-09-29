"use client";

import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { formatTime } from "@/lib/format";
import { useSession } from "@/lib/session";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * A compact read of the `events` audit trail. It narrates the pipeline while
 * someone watches it run.
 */
export function Timeline({ requestId }: { requestId: Id<"requests"> }) {
  const { token } = useSession();
  const events = useQuery(
    api.requests.timeline,
    token ? { sessionToken: token, requestId } : "skip",
  );

  if (events === undefined || events.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity</CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="space-y-3">
          {events.map((event) => (
            <li key={event._id} className="flex gap-3 text-sm">
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {formatTime(event._creationTime)}
              </span>
              <span className="text-foreground">{event.message}</span>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
