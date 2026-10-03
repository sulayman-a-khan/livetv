/**
 * Deletes the 3 dummy/seed sports events from MongoDB Atlas.
 * Run once: node scripts/purge-dummy-events.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env.local") });
const mongoose = require("mongoose");

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("MONGODB_URI not found in .env.local");
  process.exit(1);
}

const DUMMY_TITLES = [
  "Bangladesh vs Sri Lanka - Live ICC Match",
  "Real Madrid vs FC Barcelona - El Clasico Live HD",
  "India vs Australia - T20 International Series",
];

async function main() {
  console.log("Connecting to MongoDB Atlas...");
  await mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    dbName: "freetv",
  });
  console.log("Connected. Database:", mongoose.connection.db.databaseName);

  const collection = mongoose.connection.db.collection("sportsevents");

  // Show what's currently in there
  const allDocs = await collection.find({}).toArray();
  console.log(`\nTotal documents in sportsevents: ${allDocs.length}`);
  allDocs.forEach((doc, i) => {
    console.log(`  ${i + 1}. [${doc._id}] "${doc.matchTitle}" (${doc.status})`);
  });

  // Delete the dummy events by title match
  const result = await collection.deleteMany({
    matchTitle: { $in: DUMMY_TITLES },
  });
  console.log(`\nDeleted ${result.deletedCount} dummy event(s).`);

  // Show what remains
  const remaining = await collection.find({}).toArray();
  console.log(`\nRemaining documents: ${remaining.length}`);
  remaining.forEach((doc, i) => {
    console.log(`  ${i + 1}. [${doc._id}] "${doc.matchTitle}" (${doc.status})`);
  });

  await mongoose.disconnect();
  console.log("\nDone. MongoDB disconnected.");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
