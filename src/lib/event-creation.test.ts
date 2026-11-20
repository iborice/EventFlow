import { describe, expect, it } from "vitest";
import {
  toEventCreatePayload,
  validateEventStep,
  type EventDraft,
} from "./event-creation";

function validDraft(): EventDraft {
  return {
    title: "Community night",
    description: "An evening together.",
    starts_at: new Date(Date.now() + 86_400_000).toISOString().slice(0, 16),
    venue: "Main Hall",
    ticket_name: "General admission",
    ticket_description: "",
    price: "25.00",
    capacity: "100",
    status: "draft",
    use_price_tiers: false,
    price_tiers: [],
  };
}

describe("event creation form validation", () => {
  it("requires tier capacities to equal the ticket capacity", () => {
    const draft = validDraft();
    draft.use_price_tiers = true;
    draft.price_tiers = [
      { name: "Early", price: "20.00", capacity: "40" },
      { name: "Standard", price: "25.00", capacity: "50" },
    ];

    expect(validateEventStep(draft, 2).price_tiers).toBe(
      "Price tier capacities must add up to ticket capacity.",
    );
    expect(toEventCreatePayload(draft).success).toBe(false);
  });

  it("converts a valid local date to an API timezone-aware timestamp", () => {
    const result = toEventCreatePayload(validDraft());

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.starts_at).toMatch(/Z$/);
    expect(Date.parse(result.data.starts_at)).toBeGreaterThan(Date.now());
    expect(result.data.price_tiers).toEqual([]);
  });

  it("omits tier drafts when sequential pricing is turned off", () => {
    const draft = validDraft();
    draft.price_tiers = [{ name: "", price: "", capacity: "" }];

    const result = toEventCreatePayload(draft);

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.price_tiers).toEqual([]);
  });
});
