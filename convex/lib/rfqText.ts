// RFQ wording lives here so discovery and the send gate compose the identical
// message. A supplier should never receive two differently-worded requests
// depending on which code path drafted it.

export function composeRfqBody(args: {
  supplierName: string;
  title: string;
  items: Array<{ description: string; quantity: number }>;
  deliverTo: string;
  deliveryWindowDays?: number;
  budget?: string;
}): string {
  const lines = args.items
    .map((item) => `  • ${item.quantity} × ${item.description}`)
    .join("\n");

  return [
    `Hello ${args.supplierName},`,
    "",
    "We are sourcing the following and would like a quotation:",
    "",
    lines,
    "",
    `Deliver to: ${args.deliverTo}`,
    args.deliveryWindowDays
      ? `Required within: ${args.deliveryWindowDays} days`
      : null,
    args.budget ? `Indicative budget: ${args.budget}` : null,
    "",
    "Please include unit price, total, whether VAT is included, lead time, and",
    "warranty terms. A reply to this email reaches us directly.",
    "",
    "Thank you,",
    "Quotebook",
    "",
    "—",
    // Compliance footer (PLAN.md §8): a real reply-to, a way out, and a
    // postal address are what keep cold outbound out of the spam bucket.
    "You received this because your business is listed as a supplier of this",
    "equipment. Reply STOP and we will not contact you again.",
    "TODO(build day): add the registered postal address before the first send.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
