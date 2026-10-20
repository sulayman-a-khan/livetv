import Header from "@/components/Header";
import LiveSportsTwentyFourSeven from "@/components/LiveSportsTwentyFourSeven";

/**
 * A shareable home for the 24/7 section, so a channel can be linked without going
 * through the rails. It renders the same isolated component the homepage mounts —
 * one data path, one player, nothing shared with the arena or the catalogue pages.
 */
export default function TwentyFourSevenPage() {
  return (
    <div className="flex min-h-screen flex-col bg-[#060b13] text-slate-100">
      <Header />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-5 sm:px-6 sm:py-8 lg:px-8">
        <LiveSportsTwentyFourSeven />
      </main>
    </div>
  );
}
