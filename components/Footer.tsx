/**
 * Footer — dark navy bar at the bottom of every page, matching the navbar color.
 *
 * Server Component (no "use client") — purely presentational, no interactivity.
 * Plain <a> tags are used throughout because all links are external URLs.
 */
export default function Footer() {
  return (
    <footer className="bg-brand-navy px-6 py-8">
      <div className="mx-auto flex max-w-2xl flex-col items-center gap-5">
        {/* Legal links — placeholder routes; point these at your own pages */}
        <div className="flex items-center gap-6 text-sm font-medium text-white/70">
          <a href="/terms" className="transition-colors hover:text-white">
            Terms and Conditions
          </a>
          <span className="text-white/30">|</span>
          <a href="/privacy" className="transition-colors hover:text-white">
            Privacy Policy
          </a>
        </div>

        {/* Text wordmark — same treatment as the navbar */}
        <span className="text-sm font-semibold tracking-tight text-white/70">
          Creator Match
        </span>
      </div>
    </footer>
  );
}
