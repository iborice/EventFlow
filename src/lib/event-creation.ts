import { z } from "zod";

const requiredText = (max: number, label: string) =>
  z.string().trim().min(1, `${label} is required.`).max(
    max,
    `${label} must be ${max} characters or fewer.`,
  );

const optionalText = z.string().max(5000, "Use 5,000 characters or fewer.");
const priceText = z
  .string()
  .regex(/^\d{1,8}(?:\.\d{1,2})?$/, "Enter a price with up to two decimals.")
  .refine((value) => Number(value) <= 99_999_999.99, "Price is too high.");
const capacityText = z
  .string()
  .regex(/^[1-9]\d*$/, "Enter a whole number greater than zero.")
  .transform(Number)
  .pipe(z.number().int().min(1).max(1_000_000));

export const eventBasicsSchema = z.object({
  title: requiredText(180, "Event name"),
  description: optionalText,
});

export const eventScheduleSchema = z.object({
  starts_at: z
    .string()
    .min(1, "Choose a start date and time.")
    .refine((value) => {
      const timestamp = new Date(value).getTime();
      return Number.isFinite(timestamp) && timestamp > Date.now();
    }, "The event must start in the future."),
  venue: requiredText(240, "Venue"),
});

const tierDraftSchema = z.object({
  name: requiredText(120, "Tier name"),
  price: priceText,
  capacity: capacityText,
});

export const eventTicketSchema = z
  .object({
    ticket_name: requiredText(120, "Ticket name"),
    ticket_description: optionalText,
    price: priceText,
    capacity: capacityText,
    status: z.enum(["draft", "published"]),
    use_price_tiers: z.boolean(),
    price_tiers: z.array(z.unknown()).max(20, "Add no more than 20 price tiers."),
  })
  .superRefine((draft, context) => {
    if (!draft.use_price_tiers) return;
    if (draft.price_tiers.length === 0) {
      context.addIssue({
        code: "custom",
        message: "Add at least one price tier.",
        path: ["price_tiers"],
      });
      return;
    }

    let totalCapacity = 0;
    let allTiersValid = true;
    draft.price_tiers.forEach((tier, index) => {
      const parsed = tierDraftSchema.safeParse(tier);
      if (!parsed.success) {
        allTiersValid = false;
        parsed.error.issues.forEach((issue) =>
          context.addIssue({
            ...issue,
            path: ["price_tiers", index, ...issue.path],
          }),
        );
        return;
      }
      totalCapacity += parsed.data.capacity;
    });
    if (allTiersValid && totalCapacity !== draft.capacity) {
      context.addIssue({
        code: "custom",
        message: "Price tier capacities must add up to ticket capacity.",
        path: ["price_tiers"],
      });
    }
  });

export interface EventDraft {
  title: string;
  description: string;
  starts_at: string;
  venue: string;
  ticket_name: string;
  ticket_description: string;
  price: string;
  capacity: string;
  status: "draft" | "published";
  use_price_tiers: boolean;
  price_tiers: { name: string; price: string; capacity: string }[];
}

export interface EventCreatePayload {
  title: string;
  description: string;
  starts_at: string;
  venue: string;
  ticket_name: string;
  ticket_description: string;
  price: string;
  capacity: number;
  status: "draft" | "published";
  price_tiers: { name: string; price: string; capacity: number }[];
}

const steps = [
  eventBasicsSchema,
  eventScheduleSchema,
  eventTicketSchema,
] as const;

export function validateEventStep(
  draft: EventDraft,
  step: number,
): Record<string, string> {
  const schema = steps[step];
  if (!schema) return {};
  const result = schema.safeParse(draft);
  if (result.success) return {};
  return Object.fromEntries(
    result.error.issues.map((issue) => [
      String(issue.path[0] ?? "form"),
      issue.message,
    ]),
  );
}

export function toEventCreatePayload(
  draft: EventDraft,
):
  | { success: true; data: EventCreatePayload }
  | { success: false; errors: Record<string, string> } {
  const basics = eventBasicsSchema.safeParse(draft);
  const schedule = eventScheduleSchema.safeParse(draft);
  const tickets = eventTicketSchema.safeParse(draft);
  if (!basics.success || !schedule.success || !tickets.success) {
    const errors = [
      basics.success ? [] : basics.error.issues,
      schedule.success ? [] : schedule.error.issues,
      tickets.success ? [] : tickets.error.issues,
    ]
      .flat()
      .map((issue) => [String(issue.path[0] ?? "form"), issue.message]);
    return { success: false, errors: Object.fromEntries(errors) };
  }

  const localStart = new Date(draft.starts_at);
  return {
    success: true,
    data: {
      title: basics.data.title,
      description: basics.data.description,
      starts_at: localStart.toISOString(),
      venue: schedule.data.venue,
      ticket_name: tickets.data.ticket_name,
      ticket_description: tickets.data.ticket_description,
      price: tickets.data.price,
      capacity: tickets.data.capacity,
      status: tickets.data.status,
      price_tiers: tickets.data.use_price_tiers
        ? tickets.data.price_tiers.map((tier) => tierDraftSchema.parse(tier))
        : [],
    },
  };
}
