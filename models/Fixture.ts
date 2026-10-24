import mongoose, { Schema, Document, Model } from "mongoose";
import { FIXTURE_SPORTS, type FixtureSport } from "@/lib/premiumFixtures";

// The list lives in the pure validation module, so the schema and the API can
// never disagree about which sports a card may be entered for.
export { FIXTURE_SPORTS, type FixtureSport };

/**
 * A match the admin typed in by hand. There is no schedule feed behind this: an
 * unwanted match appearing on the homepage is what he asked to avoid, so every
 * card here is a deliberate entry, and a new one starts unpublished.
 */
export interface IFixture extends Document {
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
  /** The premium channel this match is watched on, or null when it is not tied to one. */
  premiumChannelId: string | null;
  /** Admin switch: an unpublished fixture stays invisible to viewers. */
  visible: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const FixtureSchema = new Schema<IFixture>(
  {
    sport: { type: String, enum: FIXTURE_SPORTS, required: true, index: true },
    teamA: { type: String, required: true, trim: true },
    teamB: { type: String, required: true, trim: true },
    teamALogo: { type: String, default: "", trim: true },
    teamBLogo: { type: String, default: "", trim: true },
    competition: { type: String, default: "", trim: true },
    startsAt: { type: Date, required: true, index: true },
    durationMinutes: { type: Number, default: 120 },
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
