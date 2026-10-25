import { notFound } from "next/navigation";
import { getPublicPremiumChannel } from "@/lib/premiumStore";
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

  return (
    <main className="max-w-5xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-5 flex flex-col gap-3">
      <header className="flex items-center gap-3 min-w-0">
        {channel.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={channel.logoUrl} alt="" className="w-10 h-10 rounded-lg object-contain bg-white/95 border border-slate-700 shrink-0" />
        ) : null}
        <div className="min-w-0">
          <h1 className="text-base font-black text-white truncate">{channel.name}</h1>
          <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wide truncate">{channel.category}</p>
        </div>
      </header>

      {channel.active ? (
        <PremiumPlayer channelId={channel._id} />
      ) : (
        <p className="text-xs font-bold text-slate-300 rounded-2xl border border-slate-800/80 bg-[#0a1222] p-4">
          এই চ্যানেলটি এখন অফ-এয়ার।
        </p>
      )}
    </main>
  );
}
