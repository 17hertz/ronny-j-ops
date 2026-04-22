/**
 * Human-facing labels + descriptions for the `vendor_service_category`
 * enum defined in db/schema.sql. Keep the ids in sync with the enum.
 *
 * Ordering here drives the order in the intake form's category picker.
 * Keep the most common categories at the top (security + photography are
 * the majority of payouts for stream nights).
 */

export type ServiceCategoryId =
  | "security"
  | "photography"
  | "video_equipment"
  | "stream_engineer"
  | "video_editor"
  | "graphic_designer"
  | "rentals"
  | "cars"
  | "yachts"
  | "deposits"
  | "sponsorship"
  | "other";

export type ServiceCategory = {
  id: ServiceCategoryId;
  label: string;
  hint: string;
};

export const SERVICE_CATEGORIES: ServiceCategory[] = [
  {
    id: "security",
    label: "Security",
    hint: "On-site security / crowd control for streams and events.",
  },
  {
    id: "photography",
    label: "Photography",
    hint: "Stills, set photos, press shots.",
  },
  {
    id: "video_equipment",
    label: "Video equipment",
    hint: "Cameras, lighting, capture rigs, AV rentals with operator.",
  },
  {
    id: "stream_engineer",
    label: "Stream / audio engineer",
    hint: "OBS operator, Twitch production lead, FOH / broadcast audio.",
  },
  {
    id: "video_editor",
    label: "Video editor",
    hint: "Post, highlights, clips, YouTube uploads.",
  },
  {
    id: "graphic_designer",
    label: "Graphic designer",
    hint: "Stream overlays, thumbnails, branding, merch art.",
  },
  {
    id: "rentals",
    label: "Studio / venue rentals",
    hint: "Rooms, stages, rehearsal spaces booked for Ronny J shoots.",
  },
  {
    id: "cars",
    label: "Cars / drivers",
    hint: "Black car, sprinter, tour driver.",
  },
  {
    id: "yachts",
    label: "Yachts / boats",
    hint: "Charter + crew for on-water shoots or content.",
  },
  {
    id: "deposits",
    label: "Deposits",
    hint: "Refundable or advance deposits on venues / equipment.",
  },
  {
    id: "sponsorship",
    label: "Sponsorship payout",
    hint: "Pass-through payments to sponsored talent or collaborators.",
  },
  {
    id: "other",
    label: "Other",
    hint: "Anything else — please describe in the notes field.",
  },
];

export function labelFor(id: ServiceCategoryId | null | undefined): string {
  if (!id) return "—";
  return SERVICE_CATEGORIES.find((c) => c.id === id)?.label ?? id;
}
