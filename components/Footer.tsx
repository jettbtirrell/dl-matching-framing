/**
 * Footer — dark navy bar at the bottom of every page, matching the navbar color.
 *
 * Server Component (no "use client") — purely presentational, no interactivity.
 * Plain <a> tags are used throughout because all links are external URLs.
 */
export default function Footer() {
  return (
    <footer className="bg-drumbeat-navy px-6 py-8">
      <div className="mx-auto flex max-w-2xl flex-col items-center gap-5">
        {/* Legal links */}
        <div className="flex items-center gap-6 text-sm font-medium text-white/70">
          <a
            href="https://hellodrumbeat.com/terms"
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-white"
          >
            Terms and Conditions
          </a>
          <span className="text-white/30">|</span>
          <a
            href="https://hellodrumbeat.com/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-white"
          >
            Privacy Policy
          </a>
        </div>

        {/* Drumbeat logo — same asset as the navbar */}
        {/* biome-ignore lint/performance/noImgElement: logo from external CDN, see NavBar production note */}
        <img
          src="https://assets.softr-files.com/applications/a2198f88-ff1f-43d0-a0c0-801d0b2cff06/assets/5d12bd26-4811-4840-8d80-bc8ceddefd87.png"
          alt="Drumbeat"
          style={{ height: 28, width: "auto" }}
        />
      </div>
    </footer>
  );
}
