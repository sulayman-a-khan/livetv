import { notFound } from "next/navigation";
import { getPublicPremiumChannel } from "@/lib/premiumStore";
import { listCardChannelsFor } from "@/lib/fixtureSources";
import PremiumPlayer from "@/components/premium/PremiumPlayer";

export const dynamic = "force-dynamic";

/**
 * The premium watch route: a separate address from `app/watch/[id]` on purpose.
 *
 * The Direct HLS watch page builds a source ladder, ranks mirrors, probes health and fails over.
 * A box-signed premium stream has none of that to do — one lane, one signed playlist, and a
 * refusal that means the source was never pushed or the box is unreachable. Keeping this page in
 * its own file is what lets the premium tier be built without touching a byte of the working
 * Direct HLS path, and the player it renders is the tier's own component for the same reason.
 */
export default async function PremiumWatchPage({ params }: { params: { id: string } }) {
  const channel = await getPublicPremiumChannel(params.id);
  if (!channel) notFound();

  // The other channels of the match card that names this one, in the order the admin set them.
  // A channel that cannot play moves to the next in that order, so the order has to be read here
  // rather than guessed at in the player. A card that cannot be read is not a reason to refuse the
  // page — the channel this page is for can still play on its own — so the list is simply empty.
  let cardChannels: { channelId: string; sourceType: "secured" | "direct" }[] = [];
  try {
    cardChannels = await listCardChannelsFor(channel._id);
  } catch (error: any) {
    console.error(
      "Premium page: could not read the card's channels",
      error?.message || error
    );
  }

  return (
    <main className="max-w-5xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-5 flex flex-col gap-3">
      {channel.active ? (
        <PremiumPlayer channelId={channel._id} channels={cardChannels} />
      ) : (
        <p className="text-xs font-bold text-slate-300 rounded-2xl border border-slate-800/80 bg-[#0a1222] p-4">
          এই চ্যানেলটি এখন অফ-এয়ার।
        </p>
      )}
    </main>
  );
}
