"use client";

/**
 * PostHog client-side provider — page view tracking and web analytics.
 *
 * WHY A SEPARATE COMPONENT?
 * Next.js App Router layout.tsx is a Server Component. PostHog initialization
 * requires browser APIs (window, document), so it must run in a Client Component.
 * This provider wraps the layout children without forcing the entire layout
 * server-to-client.
 *
 * WHY capture_pageview: false?
 * posthog-js auto-captures only the initial page load by default, missing
 * client-side route changes in Next.js. PageView handles this manually by
 * calling posthog.capture("$pageview") whenever pathname changes.
 *
 * WHY Suspense around PageView?
 * useSearchParams() requires Suspense in Next.js App Router — without it the
 * build will warn and the component will be excluded from static rendering.
 */

import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";
import { useEffect, Suspense } from "react";
import { usePathname, useSearchParams } from "next/navigation";

function PageView() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    // posthog.__loaded is false until posthog.init() is called.
    // If NEXT_PUBLIC_POSTHOG_KEY is not set, init is skipped and we
    // don't want to queue events into posthog's internal buffer.
    if (posthog.__loaded) {
      posthog.capture("$pageview");
    }
  }, [pathname, searchParams]);

  return null;
}

export function PHProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (!key) return; // no-op in dev if key is not set
    posthog.init(key, {
      api_host:
        process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://app.posthog.com",
      capture_pageview: false, // handled manually by PageView below
      capture_pageleave: true,
    });
  }, []);

  return (
    <PostHogProvider client={posthog}>
      <Suspense fallback={null}>
        <PageView />
      </Suspense>
      {children}
    </PostHogProvider>
  );
}
