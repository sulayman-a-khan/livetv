import mongoose, { Schema, Document, Model } from "mongoose";
import {
  FIXTURE_SPORTS,
  FIXTURE_SOURCE_TYPES,
  type FixtureChannelRef,
  type FixtureSport,
} from "@/lib/premiumFixtures";

// The lists live in the pure validation module, so the schema and the API can
// never disagree about which sports a card may be entered for, or which tiers it may
// name a channel from.
export { FIXTURE_SPORTS, FIXTURE_SOURCE_TYPES, type FixtureSport, type FixtureChannelRef };

/**
 * A match the admin typed in by hand. There is no schedule feed behind this: an
 * unwanted match appearing on the homepage is what he asked to avoid, so every
 * card here is a deliberate entry, and a new one starts unpublished.
 */
export interface IFixture extends Document {
  /**
   * The card's title, as the admin wrote it: "Bangladesh vs India", "BAN vs IND".
   *
   * It is kept beside the two team fields rather than instead of them: the card shows the
   * teams it recognised and the flags that go with them, and the title is what the admin
   * typed and what a card is called in the panel's own list.
   */
  title: string;
  sport: FixtureSport;
  teamA: string;
  teamB: string;
  teamALogo: string;
  teamBLogo: string;
  competition: string;
  /** Kickoff, stored in UTC. */
  startsAt: Date;
  /** How long the match is expected to hold the "LIVE NOW" badge. */
  durationMinutes: number;
  /**
   * Every channel this match can be watched on, each with the tier it comes from. Written by
   * the fixture editor; the reference stores nothing else, so no source line, header or token
   * can be attached to a card here.
   */
  channels: FixtureChannelRef[];
  /**
   * The one premium channel this match was tied to, before a card could name several. Reads
   * still honour it (see `toFixtureRecord`), writes never set it, and nothing reads it back.
   */
  premiumChannelId: string | null;
  /** Admin switch: an unpublished fixture stays invisible to viewers. */
  visible: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const FixtureSchema = new Schema<IFixture>(
  {
    sport: { type: String, enum: FIXTURE_SPORTS, required: true, index: true },
    title: { type: String, default: "", trim: true },
    teamA: { type: String, required: true, trim: true },
    teamB: { type: String, required: true, trim: true },
    teamALogo: { type: String, default: "", trim: true },
    teamBLogo: { type: String, default: "", trim: true },
    competition: { type: String, default: "", trim: true },
    startsAt: { type: Date, required: true, index: true },
    durationMinutes: { type: Number, default: 120 },
    channels: {
      type: [
        {
          _id: false,
          channelId: { type: String, required: true },
          sourceType: { type: String, enum: [...FIXTURE_SOURCE_TYPES], required: true },
        },
      ],
      default: [],
    },
    premiumChannelId: { type: String, default: null },
    visible: { type: Boolean, default: false, index: true },
  },
  { timestamps: true, collection: "fixtures" }
);

if (mongoose.models && mongoose.models.Fixture) {
  delete mongoose.models.Fixture;
}

const Fixture: Model<IFixture> = mongoose.model<IFixture>("Fixture", FixtureSchema);
export default Fixture;
