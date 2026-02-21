"use client";

import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";
import { useEffect, Suspense } from "react";
import { usePathname, useSearchParams } from "next/navigation";

function PageView() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (posthog.__loaded) posthog.capture("$pageview");
  }, [pathname, searchParams]);

  return null;
}

export function PHProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (!key || posthog.__loaded) return;
    posthog.init(key, {
      api_host: "https://us.i.posthog.com",
      capture_pageview: false, // handled manually by PageView on each pathname change
      capture_pageleave: true,
      disable_session_recording: true, // recorder script is cross-origin; events-only mode
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
