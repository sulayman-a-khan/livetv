/**
 * SoluPlay Seed Script - Populates MongoDB with sample Live Channels & Stream Links
 *
 * Usage:
 *   node scripts/seed.js
 *
 * SAFETY: this script wipes the Channel and StreamLink collections before
 * reseeding. To stop it from ever being run by accident against a live/
 * production database, it refuses to run unless MONGODB_URI points at a
 * local database (127.0.0.1/localhost) OR you explicitly pass --force.
 */
require("dotenv").config({ path: ".env.local" });
const mongoose = require("mongoose");

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/freetv";
const FORCE = process.argv.includes("--force");
const looksLocal = /^(mongodb:\/\/)?(127\.0\.0\.1|localhost)([:/]|$)/i.test(MONGODB_URI);

if (!looksLocal && !FORCE) {
  console.error(
    "\nRefusing to run: MONGODB_URI does not look like a local database.\n" +
      "This script DELETES all channels & streams before reseeding with sample data,\n" +
      "so it must never be pointed at your live/production database by accident.\n\n" +
      "If you really want to wipe & reseed this database, re-run with --force:\n" +
      "  node scripts/seed.js --force\n"
  );
  process.exit(1);
}

const ChannelSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    normalizedName: { type: String, required: true, unique: true },
    logo: { type: String, default: "" },
    category: { type: String, default: "General" },
    subCategory: { type: String, default: "Others" },
    country: { type: String, default: "Global" },
  },
  { timestamps: true }
);

const StreamLinkSchema = new mongoose.Schema(
  {
    channelId: { type: mongoose.Schema.Types.ObjectId, ref: "Channel", required: true },
    url: { type: String, required: true },
    priority: { type: Number, default: 1 },
    status: { type: String, enum: ["active", "degraded", "broken"], default: "active" },
    failedAttempts: { type: Number, default: 0 },
    firstFailedAt: { type: Date, default: null },
    lastCheckedAt: { type: Date, default: null },
    latency: { type: Number, default: 150 },
  },
  { timestamps: true }
);

const Channel = mongoose.models.Channel || mongoose.model("Channel", ChannelSchema);
const StreamLink = mongoose.models.StreamLink || mongoose.model("StreamLink", StreamLinkSchema);

const SAMPLE_CHANNELS = [
  {
    name: "T Sports HD",
    normalizedName: "tsports",
    logo: "https://images.unsplash.com/photo-1540747913346-19e32dc3e97e?w=200&auto=format&fit=crop&q=80",
    category: "Live Sports",
    subCategory: "Cricket",
    country: "Bangladesh",
    urls: [
    ],
  },
  {
    name: "GTV (Gazi TV)",
    normalizedName: "gtv",
    logo: "https://images.unsplash.com/photo-1508098682722-e99c43a406b2?w=200&auto=format&fit=crop&q=80",
    category: "Live Sports",
    subCategory: "Cricket",
    country: "Bangladesh",
    urls: [
    ],
  },
  {
    name: "Star Sports 1 HD",
    normalizedName: "starsports1",
    logo: "https://images.unsplash.com/photo-1531415074968-036ba1b575da?w=200&auto=format&fit=crop&q=80",
    category: "Live Sports",
    subCategory: "Cricket",
    country: "India",
    urls: [
    ],
  },
  {
    name: "Sony Ten 1 HD",
    normalizedName: "sonyten1",
    logo: "https://images.unsplash.com/photo-1574629810360-7efbbe195018?w=200&auto=format&fit=crop&q=80",
    category: "Live Sports",
    subCategory: "Football",
    country: "India",
    urls: [
    ],
  },
  {
    name: "PTV Sports",
    normalizedName: "ptvsports",
    logo: "https://images.unsplash.com/photo-1579952363873-27f3bade9f55?w=200&auto=format&fit=crop&q=80",
    category: "Live Sports",
    subCategory: "Cricket",
    country: "Pakistan",
    urls: [
    ],
  },
  {
    name: "A Sports HD",
    normalizedName: "asports",
    logo: "https://images.unsplash.com/photo-1517649763962-0c623266010b?w=200&auto=format&fit=crop&q=80",
    category: "Live Sports",
    subCategory: "Football",
    country: "Pakistan",
    urls: [
    ],
  },
  {
    name: "Somoy News TV",
    normalizedName: "somoynews",
    logo: "https://images.unsplash.com/photo-1585829365295-ab7cd400c167?w=200&auto=format&fit=crop&q=80",
    category: "News",
    subCategory: "News",
    country: "Bangladesh",
    urls: [
    ],
  },
  {
    name: "Aaj Tak HD",
    normalizedName: "aajtak",
    logo: "https://images.unsplash.com/photo-1504711434969-e33886168f5c?w=200&auto=format&fit=crop&q=80",
    category: "News",
    subCategory: "News",
    country: "India",
    urls: [
    ],
  },
  {
    name: "GEO News",
    normalizedName: "geonews",
    logo: "https://images.unsplash.com/photo-1495020689067-958852a7765e?w=200&auto=format&fit=crop&q=80",
    category: "News",
    subCategory: "News",
    country: "Pakistan",
    urls: [
    ],
  },
];

async function seedDatabase() {
  try {
    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 2000 });
    console.log("Connected to MongoDB.");
  } catch (err) {
    console.warn(`[MongoDB Warning] Local MongoDB connection unavailable (${err.message}). Defaulting to In-Memory / Local JSON Store.`);
    process.exit(0);
  }

  // Clear existing channels & streams for clean re-seed
  await Channel.deleteMany({});
  await StreamLink.deleteMany({});
  console.log("Cleared existing collection data.");

  let channelCount = 0;
  let streamCount = 0;

  for (const item of SAMPLE_CHANNELS) {
    const channel = await Channel.create({
      name: item.name,
      normalizedName: item.normalizedName,
      logo: item.logo,
      category: item.category,
      subCategory: item.subCategory,
      country: item.country,
    });
    channelCount++;

    for (let i = 0; i < item.urls.length; i++) {
      await StreamLink.create({
        channelId: channel._id,
        url: item.urls[i],
        priority: i + 1,
        status: "active",
        failedAttempts: 0,
        latency: 120 + i * 45,
      });
      streamCount++;
    }
  }

  console.log(`\nSeed successful! Created ${channelCount} channels with ${streamCount} stream backup links.`);
  await mongoose.disconnect();
}

seedDatabase().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
