
import Link from "next/link";

export default function Pool3DPage() {
  return (
    <main className="fixed inset-0 flex min-h-0 flex-col overflow-hidden bg-[#03050b] text-white">
      <header className="z-20 flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-black/80 px-2 py-2 sm:gap-3 sm:px-4 sm:py-3">
        <Link
          href="/"
          className="min-h-10 shrink-0 rounded-lg border border-white/20 px-2 py-2 text-xs hover:bg-white/10 sm:px-3 sm:text-sm"
        >
          ← Back to SquadBet
        </Link>

        <h1 className="min-w-0 flex-1 text-center text-xs font-semibold sm:text-lg">
          Cinematic 8-Ball Pool
        </h1>

        <a
          href="/cinematic-pool/index.html"
          target="_blank"
          rel="noopener noreferrer"
          className="min-h-10 shrink-0 rounded-lg border border-white/20 px-2 py-2 text-[11px] hover:bg-white/10 sm:px-3 sm:text-sm"
        >
          Open game ↗
        </a>
      </header>

      <iframe
        title="Original Cinematic 8-Ball Pool"
        src="/cinematic-pool/index.html"
        className="min-h-0 w-full flex-1 touch-manipulation border-0 bg-[#03050b]"
        allow="fullscreen; autoplay"
      />
    </main>
  );
}
