"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { formatMoney } from "@/lib/format";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { useSession } from "@/lib/session";

/**
 * The decision and its reasoning — never a black box. Every input behind the
 * call is listed, so the trade-off is auditable rather than asserted.
 */
export function Recommendation({ requestId }: { requestId: Id<"requests"> }) {
  const { token } = useSession();
  const recommendation = useQuery(
    api.recommendations.forRequest,
    token ? { sessionToken: token, requestId } : "skip",
  );
  const rows = useQuery(
    api.board.forRequest,
    token ? { sessionToken: token, requestId } : "skip",
  );
  const recommend = useMutation(api.recommendations.recommend);
  const [busy, setBusy] = useState(false);

  if (recommendation === undefined) return null;

  // Recommending with nothing priced would burn a model call to compare an
  // empty set. Disable it until there is something to compare.
  const priced = (rows ?? []).filter((row) => row.totalMinor !== null).length;

  async function run() {
    setBusy(true);
    try {
      if (token) await recommend({ sessionToken: token, requestId });
    } finally {
      setBusy(false);
    }
  }

  if (recommendation === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Recommendation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {priced === 0 ? (
            <p className="rounded-md border border-dashed px-4 py-4 text-sm text-muted-foreground">
              Nothing to compare yet — no supplier has a price on the board.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {priced} priced quote{priced === 1 ? "" : "s"} ready to compare.
            </p>
          )}
          <Button onClick={run} disabled={busy || priced === 0}>
            {busy ? "Deciding…" : "Recommend a supplier"}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-primary/30">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle>Recommendation</CardTitle>
        <Badge variant="success">decided</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-lg">
          <strong>{recommendation.supplierName}</strong>
          {recommendation.totalMinor !== null &&
            recommendation.currency !== null && (
              <>
                {" — "}
                {formatMoney(
                  recommendation.totalMinor,
                  recommendation.currency,
                )}
              </>
            )}
        </p>

        <p className="text-sm">{recommendation.rationale}</p>

        <p className="rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-sm text-warning">
          <strong>Trade-off accepted:</strong> {recommendation.tradeoff}
        </p>

        <Accordion type="single" collapsible>
          <AccordionItem value="inputs" className="border-b-0">
            <AccordionTrigger className="py-2">
              What this was decided on
            </AccordionTrigger>
            <AccordionContent>
              <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {recommendation.inputs.map((input) => (
                  <div key={input.label}>
                    <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                      {input.label}
                    </dt>
                    <dd className="text-sm">{input.value}</dd>
                  </div>
                ))}
              </dl>
            </AccordionContent>
          </AccordionItem>
        </Accordion>

        <Button variant="outline" onClick={run} disabled={busy}>
          {busy ? "Deciding…" : "Re-run with the latest quotes"}
        </Button>
      </CardContent>
    </Card>
  );
}
