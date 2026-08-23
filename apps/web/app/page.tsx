'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { useAccess } from '@/lib/access';

const publicBasePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
const welcomeVideo = `${publicBasePath}/welcome/memex-welcome-1080p.mp4`;
const welcomePoster = `${publicBasePath}/welcome/memex-welcome-poster.jpg`;

/**
 * Первый экран для человека без аккаунта.
 *
 * В ролике показан настоящий интерфейс MEMEX: GEMS, живой график и
 * значения ATH. Контролов у видео нет, поэтому единственным действием
 * на странице остаётся начало регистрации.
 */
export default function HomePage() {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const { access, anonymous, loading } = useAccess();

  useEffect(() => {
    if (loading || anonymous) return;

    const hasProductAccess =
      access?.serviceAccess === true ||
      access?.status === 'active' ||
      access?.status === 'trial' ||
      access?.status === 'service';

    router.replace(hasProductAccess ? '/terminal' : '/onboarding');
  }, [access, anonymous, loading, router]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const syncPlayback = () => {
      const video = videoRef.current;
      if (!video) return;

      if (media.matches) {
        video.pause();
        video.currentTime = 0;
        return;
      }

      void video.play().catch(() => {
        // Постер остаётся полноценным первым кадром, если браузер
        // запретил автоматическое воспроизведение.
      });
    };

    syncPlayback();
    media.addEventListener('change', syncPlayback);
    return () => media.removeEventListener('change', syncPlayback);
  }, []);

  return (
    <section className="relative isolate flex min-h-[100svh] overflow-hidden bg-bg text-text">
      <video
        ref={videoRef}
        className="absolute inset-0 h-full w-full object-cover object-[60%_center] sm:object-center"
        src={welcomeVideo}
        poster={welcomePoster}
        autoPlay
        muted
        loop
        playsInline
        preload="metadata"
        aria-hidden="true"
      />

      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,11,15,.3)_0%,rgba(8,11,15,.1)_34%,rgba(8,11,15,.9)_82%,#080b0f_100%)]" />
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(8,11,15,.65)_0%,transparent_55%)] max-sm:bg-[linear-gradient(90deg,rgba(8,11,15,.25),rgba(8,11,15,.08))]" />

      <div className="relative z-10 mx-auto flex min-h-[100svh] w-full max-w-[1440px] flex-col px-5 pb-[max(28px,env(safe-area-inset-bottom))] pt-[max(24px,env(safe-area-inset-top))] sm:px-10 sm:pb-12 sm:pt-9 lg:px-16">
        <div className="text-xl font-bold tracking-tight drop-shadow-[0_2px_10px_rgba(0,0,0,.7)] sm:text-2xl">
          me<span className="text-accent">mex</span>
        </div>

        <div className="mt-auto max-w-[640px] pb-3 sm:pb-6">
          <p className="mb-3 font-mono text-[11px] font-medium uppercase tracking-[0.2em] text-up sm:text-xs">
            Live signal intelligence
          </p>
          <h1 className="text-balance text-4xl font-semibold leading-[1.02] tracking-[-0.04em] drop-shadow-[0_4px_24px_rgba(0,0,0,.65)] sm:text-6xl lg:text-7xl">
            See the signal.
            <br />
            Make your move.
          </h1>
          <p className="mt-4 max-w-[500px] text-sm leading-relaxed text-white/75 drop-shadow-[0_2px_12px_rgba(0,0,0,.8)] sm:mt-5 sm:text-base">
            GEMS, live prices, charts and ATH tracking in one terminal.
          </p>

          <Link
            href="/login?mode=register"
            className="mt-7 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-accent px-7 py-3 text-sm font-semibold text-white shadow-[0_14px_40px_rgba(139,92,246,.35)] transition duration-200 hover:-translate-y-0.5 hover:bg-[#7C3AED] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent motion-reduce:transform-none sm:w-auto sm:min-w-48"
          >
            Get Started
            <span aria-hidden="true">→</span>
          </Link>

          <p className="mt-4 text-[10px] leading-relaxed text-white/45 sm:text-[11px]">
            Crypto assets are highly volatile. No result is guaranteed.
          </p>
        </div>
      </div>
    </section>
  );
}
