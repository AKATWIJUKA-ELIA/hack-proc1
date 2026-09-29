import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// One place that turns a status into words a buyer understands. "collecting" is
// a database state; "waiting on replies" is what is actually happening.
const LABELS: Record<string, string> = {
  draft: "draft",
  extracting: "reading request",
  discovering: "finding suppliers",
  awaiting_approval: "needs your approval",
  collecting: "waiting on replies",
  decided: "decided",
  failed: "failed",
};

type BadgeVariant = "default" | "secondary" | "destructive" | "success" | "warning" | "info" | "muted";

const VARIANTS: Record<string, BadgeVariant> = {
  draft: "muted",
  extracting: "info",
  discovering: "info",
  awaiting_approval: "warning",
  collecting: "warning",
  decided: "success",
  failed: "destructive",
};

// Small colored dot so the status reads at a glance in dense lists.
const DOT: Record<string, string> = {
  draft: "bg-muted-foreground",
  extracting: "bg-info",
  discovering: "bg-info",
  awaiting_approval: "bg-warning",
  collecting: "bg-warning",
  decided: "bg-success",
  failed: "bg-destructive",
};

export function StatusPill({ status }: { status: string }) {
  return (
    <Badge variant={VARIANTS[status] ?? "muted"}>
      <span
        aria-hidden="true"
        className={cn("h-1.5 w-1.5 rounded-full", DOT[status] ?? "bg-muted-foreground")}
      />
      {LABELS[status] ?? status.replace(/_/g, " ")}
    </Badge>
  );
}

export function StatusDot({ status }: { status: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block h-2 w-2 rounded-full",
        DOT[status] ?? "bg-muted-foreground",
      )}
    />
  );
}
