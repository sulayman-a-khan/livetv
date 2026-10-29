import mongoose, { Schema, Document, Model } from "mongoose";

/**
 * How the site stands with a box.
 *
 *   - `pending` — an enrollment was asked for; the box has not exchanged its code yet.
 *   - `enrolled` — the box proved it holds the code, and the site will talk to it.
 *   - `revoked` — the site withdrew that box. Its tokens are no longer derived for it and
 *     its registrations are refused.
 */
export type ProxyBoxState = "pending" | "enrolled" | "revoked";

/**
 * A box the site knows.
 *
 * One row per box, keyed by the box's own id, so a box that restarts with a new address
 * replaces its own row rather than adding another one. The row carries two things that
 * change on different clocks: the address, which a quick tunnel changes on every start,
 * and the enrollment, which is decided once and lasts until it is revoked.
 */
export interface IProxyBox extends Document {
  /** The box's own name. A label, not a credential. */
  boxId: string;
  /** The address the site must reach the box at. Empty until the box registers. */
  baseUrl: string;
  /** When the box last said where it is. */
  registeredAt: Date | null;
  /** Whether the site still admits this box. */
  state: ProxyBoxState;
  /** When the box exchanged its enrollment code. */
  enrolledAt: Date | null;
  /** When the site withdrew the box. */
  revokedAt: Date | null;
  /** The hash of the enrollment code. Empty once the code has been used. */
  enrollmentCodeHash: string;
  /** When the enrollment code stops working. */
  enrollmentCodeExpiresAt: Date | null;
  /** When the enrollment code was exchanged. */
  enrollmentCodeUsedAt: Date | null;
}

const ProxyBoxSchema = new Schema<IProxyBox>(
  {
    boxId: { type: String, required: true, trim: true, unique: true, index: true },
    baseUrl: { type: String, required: false, trim: true, default: "" },
    registeredAt: { type: Date, required: false, default: null },
    state: {
      type: String,
      required: true,
      enum: ["pending", "enrolled", "revoked"],
      default: "pending",
    },
    enrolledAt: { type: Date, required: false, default: null },
    revokedAt: { type: Date, required: false, default: null },
    enrollmentCodeHash: { type: String, required: false, default: "" },
    enrollmentCodeExpiresAt: { type: Date, required: false, default: null },
    enrollmentCodeUsedAt: { type: Date, required: false, default: null },
  },
  { timestamps: true, collection: "proxyboxes" }
);

if (mongoose.models && mongoose.models.ProxyBox) {
  delete mongoose.models.ProxyBox;
}

const ProxyBox: Model<IProxyBox> = mongoose.model<IProxyBox>("ProxyBox", ProxyBoxSchema);
export default ProxyBox;
