"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useSession } from "@/lib/session";
import { Search, Send, LayoutGrid } from "lucide-react";

// The canonical demo request. Prefilled so anyone arriving cold can run the
// pipeline without composing a procurement spec from scratch.
const DEMO_REQUEST =
  "50 × Dell Latitude 5550, i7/16GB/512GB, delivered to Kampala within 14 days, budget UGX 180,000,000";

const STEPS = [
  {
    icon: Search,
    title: "Find",
    body: "Suppliers and any published prices, from the open web.",
  },
  {
    icon: Send,
    title: "Ask",
    body: "You approve the list; we email each one for a real quote.",
  },
  {
    icon: LayoutGrid,
    title: "Compare",
    body: "Replies land and upgrade the board while you watch.",
  },
];

export function RequestForm({
  onCreated,
}: {
  onCreated: (id: Id<"requests">) => void;
}) {
  const create = useMutation(api.requests.create);
  const { token } = useSession();
  const [rawText, setRawText] = useState(DEMO_REQUEST);
  const [deliverTo, setDeliverTo] = useState("Kampala, Uganda");
  const [currency, setCurrency] = useState("UGX");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (!token) throw new Error("Your session expired. Please sign in again.");
      const id = await create({ sessionToken: token, rawText, deliverTo, currency });
      onCreated(id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">
          What do you need?
        </h1>
        <p className="max-w-2xl text-muted-foreground">
          Describe it the way you would to a colleague. We find suppliers, ask
          them for real quotes, read the replies, and lay the options out side
          by side.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={submit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="need">The requirement</Label>
              <Textarea
                id="need"
                rows={3}
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                placeholder="e.g. 50 laptops, i7/16GB, delivered to Kampala within 14 days"
              />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_auto]">
              <div className="space-y-2">
                <Label htmlFor="deliver-to">Deliver to</Label>
                <Input
                  id="deliver-to"
                  value={deliverTo}
                  onChange={(e) => setDeliverTo(e.target.value)}
                />
              </div>
              <div className="space-y-2 sm:w-28">
                <Label htmlFor="currency">Currency</Label>
                <Input
                  id="currency"
                  value={currency}
                  maxLength={3}
                  onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                />
              </div>
            </div>

            {error && (
              <p className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button type="submit" disabled={busy} size="lg">
                {busy ? "Starting…" : "Find suppliers"}
              </Button>
              <p className="text-sm text-muted-foreground">
                Nothing is emailed to anyone until you approve an exact
                recipient list.
              </p>
            </div>
          </form>
        </CardContent>
      </Card>

      <ol className="grid gap-4 sm:grid-cols-3">
        {STEPS.map((step, i) => (
          <li key={step.title}>
            <Card className="h-full">
              <CardContent className="flex gap-3 pt-6">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <step.icon className="h-5 w-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-muted-foreground">
                      {i + 1}
                    </span>
                    <span className="font-medium">{step.title}</span>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {step.body}
                  </p>
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ol>
    </div>
  );
}
