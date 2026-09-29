"use client";

import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { formatMoney } from "@/lib/format";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDown } from "lucide-react";
import { useSession } from "@/lib/session";

type Track = "confirmed" | "web price" | "awaiting" | "no price";

const TRACK_HELP: Record<Track, string> = {
  confirmed: "Came from a supplier's own reply.",
  "web price": "Scraped from the supplier's site. Unverified.",
  awaiting: "We emailed them and have not heard back.",
  "no price": "Found, but no published price and not yet contacted.",
};

const TRACK_VARIANT: Record<Track, "success" | "info" | "warning" | "muted"> = {
  confirmed: "success",
  "web price": "info",
  awaiting: "warning",
  "no price": "muted",
};

/**
 * The comparison board. A reactive query, so a crawled row appearing or a
 * confirmed reply upgrading it happens here with no refresh — that live change
 * is the demo.
 */
export function Board({ requestId }: { requestId: Id<"requests"> }) {
  const { token } = useSession();
  const rows = useQuery(
    api.board.forRequest,
    token ? { sessionToken: token, requestId } : "skip",
  );

  if (rows === undefined) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Comparison board</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-40 w-full" />
        </CardContent>
      </Card>
    );
  }

  const confirmed = rows.filter((row) => row.track === "confirmed").length;
  const presentTracks = new Set(rows.map((r) => r.track as Track));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Comparison board</CardTitle>
        <CardDescription>
          {rows.length === 0
            ? "Fills in as suppliers are found."
            : `${rows.length} supplier${rows.length === 1 ? "" : "s"}` +
              (confirmed > 0 ? ` · ${confirmed} confirmed` : "")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {rows.length === 0 ? (
          <p className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            No suppliers yet. Discovery adds rows the moment it finds them.
          </p>
        ) : (
          <TooltipProvider delayDuration={200}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Supplier</TableHead>
                  <TableHead>Track</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">≈ USD</TableHead>
                  <TableHead className="text-right">Lead</TableHead>
                  <TableHead className="text-right">Warranty</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const track = row.track as Track;
                  return (
                    <TableRow key={row.supplierId}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-medium">
                            {row.supplierName}
                          </span>
                          {row.supplierDomain && (
                            <span className="text-xs text-muted-foreground">
                              {row.supplierDomain}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span>
                              <Badge variant={TRACK_VARIANT[track]}>
                                {track}
                              </Badge>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>{TRACK_HELP[track]}</TooltipContent>
                        </Tooltip>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.totalMinor !== null && row.currency !== null
                          ? formatMoney(row.totalMinor, row.currency)
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.normalizedUsdMinor !== null ? (
                          row.fxRate !== null && row.fxRateAt !== null ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="cursor-help underline decoration-dotted underline-offset-2">
                                  {formatMoney(row.normalizedUsdMinor, "USD")}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>
                                {`Rate ${row.fxRate} ${row.currency}/USD from ${
                                  row.fxSource ?? "unknown"
                                } at ${new Date(row.fxRateAt).toISOString()}`}
                              </TooltipContent>
                            </Tooltip>
                          ) : (
                            formatMoney(row.normalizedUsdMinor, "USD")
                          )
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.leadTimeDays !== null
                          ? `${row.leadTimeDays}d`
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.warrantyMonths !== null
                          ? `${row.warrantyMonths}mo`
                          : "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TooltipProvider>
        )}

        {/* Only explain tracks that are actually on the board. */}
        {rows.length > 0 && (
          <Collapsible>
            <CollapsibleTrigger className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground [&[data-state=open]>svg]:rotate-180">
              What the labels mean
              <ChevronDown className="h-4 w-4 transition-transform" />
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-3">
              <ul className="space-y-2">
                {(Object.keys(TRACK_HELP) as Track[])
                  .filter((track) => presentTracks.has(track))
                  .map((track) => (
                    <li key={track} className="flex items-center gap-3">
                      <Badge variant={TRACK_VARIANT[track]}>{track}</Badge>
                      <span className="text-sm text-muted-foreground">
                        {TRACK_HELP[track]}
                      </span>
                    </li>
                  ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>
    </Card>
  );
}
