require("dotenv").config({ path: ".env.local" });
require("dotenv").config();
const mongoose = require("mongoose");

async function verify() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI is not set. Add it to .env.local / .env (run from the repo root) or export it first.");
    process.exit(1);
  }
  await mongoose.connect(uri);

  const Channel = mongoose.models.Channel || mongoose.model("Channel", new mongoose.Schema({}, { strict: false }));
  const StreamLink = mongoose.models.StreamLink || mongoose.model("StreamLink", new mongoose.Schema({}, { strict: false }));

  const channels = await Channel.find({}).sort({ isPinned: -1, priorityOrder: 1, name: 1 }).lean();
  console.log("Channels found in freetv:", channels.length);

  const channelIds = channels.map((c) => c._id);
  const channelIdStrings = channelIds.map((c) => c.toString());

  const streams = await StreamLink.find({
    channelId: { $in: [...channelIds, ...channelIdStrings] },
  }).lean();
  console.log("Streams found in freetv:", streams.length);

  const streamMap = new Map();
  for (const s of streams) {
    const key = String(s.channelId);
    if (!streamMap.has(key)) streamMap.set(key, []);
    streamMap.get(key).push(s);
  }

  let channelsWithStreams = 0;
  for (const c of channels) {
    const cand = streamMap.get(String(c._id)) || [];
    if (cand.length > 0 || c.streamUrl || c.url) channelsWithStreams++;
  }
  console.log("Channels with active/usable stream links:", channelsWithStreams);

  console.log("First 5 Channels Preview:");
  for (let i = 0; i < Math.min(5, channels.length); i++) {
    const ch = channels[i];
    const cand = streamMap.get(String(ch._id)) || [];
    console.log(` - [${ch.category} | ${ch.country}] ${ch.name} -> ${cand.length} streams (e.g. ${cand[0]?.url?.slice(0, 60)}...)`);
  }

  await mongoose.disconnect();
}

verify().catch(console.error);
