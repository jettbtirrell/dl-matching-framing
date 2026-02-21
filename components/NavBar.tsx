/**
 * NavBar — fixed top navigation bar present on every page.
 *
 * This is a Server Component (no "use client") because it has no interactivity.
 *
 * Why fixed instead of sticky?
 * "fixed" positions relative to the viewport regardless of scroll, so the
 * navbar stays visible as the user scrolls through long results pages.
 * "sticky" would disappear once the user scrolls past the top of the
 * container — not what we want here.
 */

export default function NavBar() {
  return (
    <nav className="fixed left-0 right-0 top-0 z-50 flex h-16 items-center justify-between bg-drumbeat-navy px-17">
      {/* ── Logo ──────────────────────────────────────────────────────────── */}
      {/*
       * PRODUCTION NOTE: This image is served from Softr's CDN, which creates
       * a runtime dependency on their infrastructure. Before going to production,
       * download this asset and serve it from /public/drumbeat-logo.png instead.
       * That way the logo works even if Softr's CDN is down or rate-limits us.
       */}
      {/* biome-ignore lint/performance/noImgElement: logo from external CDN, see production note above */}
      <img
        src="https://assets.softr-files.com/applications/a2198f88-ff1f-43d0-a0c0-801d0b2cff06/assets/5d12bd26-4811-4840-8d80-bc8ceddefd87.png"
        alt="Drumbeat"
        style={{ height: 32, width: "auto" }}
      />

      {/* ── Return Home button ────────────────────────────────────────────── */}
      {/*
       * Plain <a> instead of Next.js <Link> because this is an external URL.
       * <Link> is for internal Next.js routes — using it for external URLs
       * bypasses its prefetching/routing logic in unexpected ways.
       */}
      <a
        href="https://hellodrumbeat.com/"
        className="flex items-center gap-1.5 rounded-full border border-white/20 bg-white px-4 py-2 text-sm font-medium text-drumbeat-navy transition-colors hover:bg-fill-hover"
      >
        {/* Inline SVG — no file dependency, inherits text color via currentColor */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          width="1em"
          height="1em"
          aria-hidden="true"
        >
          <path
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            d="M9 21v-7.4c0-.5601 0-.8401.109-1.054a1 1 0 0 1 .437-.437C9.76 12 10.04 12 10.6 12h2.8c.5601 0 .8401 0 1.054.109a1 1 0 0 1 .437.437c.109.2139.109.4939.109 1.054V21M2 9.5l9.04-6.78c.3443-.2582.5164-.3873.7054-.437a1 1 0 0 1 .5092 0c.189.0497.3611.1788.7054.437L22 9.5M4 8v9.8c0 1.1201 0 1.6802.218 2.108.1917.3763.4977.6823.874.874C5.52 21 6.08 21 7.2 21h9.6c1.1201 0 1.6802 0 2.108-.218a2 2 0 0 0 .874-.874C20 19.4802 20 18.9201 20 17.8V8l-6.08-4.56c-.6885-.5164-1.0328-.7746-1.4109-.8741a2 2 0 0 0-1.0182 0c-.3781.0995-.7224.3577-1.4109.8741z"
          />
        </svg>
        Return Home
      </a>
    </nav>
  );
}
