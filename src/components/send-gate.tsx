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
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

// Mirrors the cap enforced in the mutation. The server is the authority; this
// only lets the button explain itself before the click.
const MAX_RECIPIENTS = 5;

type Recipient = {
  _id: Id<"rfqs">;
  status: string;
  supplierName: string;
  supplierDomain: string;
  email: string | null;
  verification: string;
  chaseCount: number;
  sentAt?: number;
  failureReason: string | null;
};

const VERIFICATION_VARIANT: Record<string, "success" | "warning" | "destructive" | "muted"> = {
  mx_valid: "success",
  unverified: "muted",
  mx_invalid: "destructive",
  bounced: "destructive",
};

/**
 * The explicit human gate. The exact recipient list is on screen, capped at
 * five, and nothing leaves without a click.
 */
export function SendGate({ requestId }: { requestId: Id<"requests"> }) {
  const { token } = useSession();
  const rfqs = useQuery(
    api.rfqs.listForRequest,
    token ? { sessionToken: token, requestId } : "skip",
  );
  const approveAndSend = useMutation(api.rfqs.approveAndSend);
  const [selected, setSelected] = useState<Set<Id<"rfqs">>>(new Set());
  const [busy, setBusy] = useState(false);

  if (rfqs === undefined) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Send gate</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    );
  }

  const drafts = rfqs.filter((r) => r.status === "draft");
  // "approved" means approved but never dispatched — stalled, not sent. It
  // belongs with the failures, because the recovery is identical.
  const stalled = rfqs.filter(
    (r) => r.status === "failed" || r.status === "approved",
  );
  const dispatched = rfqs.filter(
    (r) => r.status !== "draft" && r.status !== "failed" && r.status !== "approved",
  );
  const reachable = drafts.filter((r) => r.email !== null);

  function toggle(rfqId: Id<"rfqs">) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(rfqId)) next.delete(rfqId);
      else if (next.size < MAX_RECIPIENTS) next.add(rfqId);
      return next;
    });
  }

  async function send() {
    setBusy(true);
    try {
      if (!token) throw new Error("Your session expired. Please sign in again.");
      await approveAndSend({ sessionToken: token, requestId, rfqIds: [...selected] });
      setSelected(new Set());
      toast.success("RFQs approved and sent.");
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div className="space-y-1.5">
          <CardTitle>Send gate</CardTitle>
          <CardDescription>
            Real email to real businesses. Nothing sends without your click.
          </CardDescription>
        </div>
        {reachable.length > 0 && (
          <span className="shrink-0 text-sm text-muted-foreground">
            {selected.size} of {MAX_RECIPIENTS} selected
          </span>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {drafts.length === 0 && dispatched.length === 0 && (
          <p className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            No suppliers linked to this request yet. Discovery adds them as it
            finds them.
          </p>
        )}

        {drafts.length > 0 && reachable.length === 0 && (
          <p className="rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-sm text-warning">
            None of these suppliers published an email address we could find. Add
            one below and the RFQ becomes sendable.
          </p>
        )}

        {drafts.length > 0 && (
          <ul className="space-y-2">
            {drafts.map((rfq) => (
              <RecipientRow
                key={rfq._id}
                rfq={rfq}
                checked={selected.has(rfq._id)}
                disabled={
                  rfq.email === null ||
                  (!selected.has(rfq._id) && selected.size >= MAX_RECIPIENTS)
                }
                onToggle={() => toggle(rfq._id)}
              />
            ))}
          </ul>
        )}

        {reachable.length > 0 && (
          <Button onClick={send} disabled={busy || selected.size === 0}>
            {busy
              ? "Sending…"
              : selected.size === 0
                ? "Select a supplier to contact"
                : `Approve and send ${selected.size} RFQ${
                    selected.size === 1 ? "" : "s"
                  }`}
          </Button>
        )}

        {stalled.length > 0 && (
          <FailedSends requestId={requestId} failed={stalled} />
        )}

        {dispatched.length > 0 && (
          <div className="space-y-2">
            <Separator />
            <h3 className="text-sm font-semibold">Sent</h3>
            <ul className="space-y-2">
              {dispatched.map((rfq) => (
                <li
                  key={rfq._id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
                >
                  <span className="font-medium">{rfq.supplierName}</span>
                  <Badge variant="info">{rfq.status}</Badge>
                  {rfq.sentAt && (
                    <span className="text-xs text-muted-foreground">
                      {formatTime(rfq.sentAt)}
                    </span>
                  )}
                  {rfq.chaseCount > 0 && (
                    <span className="text-xs text-muted-foreground">
                      followed up {rfq.chaseCount}×
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Sends that errored before leaving. The approval is still on record, so the
 * way back is one button — not re-selecting the same suppliers.
 */
function FailedSends({
  requestId,
  failed,
}: {
  requestId: Id<"requests">;
  failed: Recipient[];
}) {
  const retrySend = useMutation(api.rfqs.retrySend);
  const { token } = useSession();
  const [busy, setBusy] = useState(false);

  async function retry() {
    setBusy(true);
    try {
      if (!token) throw new Error("Your session expired. Please sign in again.");
      await retrySend({ sessionToken: token, requestId });
      toast.success("Retrying sends.");
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  // The same reason repeated on every row is noise; show it once.
  const reasons = [
    ...new Set(failed.map((r) => r.failureReason).filter(Boolean)),
  ] as string[];

  return (
    <div className="space-y-3">
      <Separator />
      <h3 className="text-sm font-semibold">Did not send</h3>
      <p className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {reasons.length === 1
          ? reasons[0]
          : `${failed.length} RFQ(s) were approved but never sent.`}
      </p>

      <ul className="space-y-2">
        {failed.map((rfq) => (
          <li
            key={rfq._id}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
          >
            <span className="font-medium">{rfq.supplierName}</span>
            {rfq.email && (
              <span className="font-mono text-xs text-muted-foreground">
                {rfq.email}
              </span>
            )}
            <Badge variant="destructive">
              {rfq.failureReason ? "failed" : "not sent"}
            </Badge>
            {reasons.length > 1 && rfq.failureReason && (
              <span className="text-xs text-muted-foreground">
                {rfq.failureReason}
              </span>
            )}
          </li>
        ))}
      </ul>

      <Button variant="outline" onClick={retry} disabled={busy}>
        {busy
          ? "Retrying…"
          : `Retry ${failed.length} send${failed.length === 1 ? "" : "s"}`}
      </Button>
    </div>
  );
}

function RecipientRow({
  rfq,
  checked,
  disabled,
  onToggle,
}: {
  rfq: Recipient;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const addContact = useMutation(api.rfqs.addContact);
  const clearContact = useMutation(api.rfqs.clearContact);
  const { token } = useSession();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      if (!token) throw new Error("Your session expired. Please sign in again.");
      await addContact({ sessionToken: token, rfqId: rfq._id, email });
      setEmail("");
      toast.success("Address added.");
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li
      className={cn(
        "rounded-lg border p-3",
        rfq.email === null && "border-dashed bg-muted/30",
      )}
    >
      <label className="flex flex-wrap items-center gap-3">
        <Checkbox
          checked={checked}
          onCheckedChange={onToggle}
          disabled={disabled}
        />
        <span className="flex min-w-0 flex-col">
          <span className="font-medium">{rfq.supplierName}</span>
          <span className="text-xs text-muted-foreground">
            {rfq.supplierDomain}
          </span>
        </span>
        {rfq.email ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs">{rfq.email}</span>
            <Badge variant={VERIFICATION_VARIANT[rfq.verification] ?? "muted"}>
              {rfq.verification.replace(/_/g, " ")}
            </Badge>
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0"
              onClick={(e) => {
                e.preventDefault();
                if (token) void clearContact({ sessionToken: token, rfqId: rfq._id });
              }}
            >
              change
            </Button>
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">
            no address found
          </span>
        )}
      </label>

      {rfq.email === null && (
        <form className="mt-3 flex gap-2" onSubmit={add}>
          <label className="sr-only" htmlFor={`email-${rfq._id}`}>
            Email address for {rfq.supplierName}
          </label>
          <Input
            id={`email-${rfq._id}`}
            type="email"
            placeholder={`sales@${rfq.supplierDomain || "supplier.com"}`}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <Button type="submit" disabled={busy || email.trim().length === 0}>
            {busy ? "Adding…" : "Add"}
          </Button>
        </form>
      )}
    </li>
  );
}
