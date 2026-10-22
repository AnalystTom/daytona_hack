import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LandingIntro, shouldShowIntro } from "./Intro";

afterEach(() => vi.unstubAllGlobals());

function visit({
  seen = false,
  reducedMotion = false,
  hash = "",
  mobile = false,
} = {}) {
  const getItem = vi.fn(() => (seen ? "1" : null));
  vi.stubGlobal("window", {
    location: { hash },
    matchMedia: (query: string) => ({
      matches: query.includes("prefers-reduced-motion")
        ? reducedMotion
        : mobile,
    }),
    sessionStorage: { getItem },
  });
  return getItem;
}

describe("landing intro", () => {
  it("autoplays the approved video silently and inline for a first visitor", () => {
    visit();
    const html = renderToStaticMarkup(
      <LandingIntro>
        <h1>Reversy</h1>
      </LandingIntro>,
    );
    expect(html).toContain('src="/intro/reversy-intro.mp4"');
    expect(html).toContain('poster="/intro/daytona-poster.jpg"');
    expect(html).toContain("Skip intro");
    expect(html).toMatch(/autoplay/i);
    expect(html).toMatch(/muted/i);
    expect(html).toMatch(/playsinline/i);
    expect(html).not.toContain("intro-trigger");
  });

  it("loads the portrait video and poster instead of the desktop assets on mobile", () => {
    visit({ mobile: true });
    const html = renderToStaticMarkup(
      <LandingIntro>
        <h1>Reversy</h1>
      </LandingIntro>,
    );
    expect(html).toContain('src="/intro/reversy-intro-mobile.mp4"');
    expect(html).toContain('poster="/intro/daytona-poster-mobile.jpg"');
    expect(html).toContain("intro-video-mobile");
    expect(html).not.toContain('src="/intro/reversy-intro.mp4"');
  });

  it("keeps one live landing page mounted beneath the video for the reveal", () => {
    visit();
    const html = renderToStaticMarkup(
      <LandingIntro>
        <a href="/app">Start a project</a>
      </LandingIntro>,
    );
    expect(html.match(/Start a project/g)).toHaveLength(1);
    expect(html.indexOf('href="/app"')).toBeLessThan(html.indexOf("<dialog"));
  });
  it.each([{ seen: true }, { reducedMotion: true }, { hash: "#how-it-works" }])(
    "goes straight to the site for %j",
    (options) => {
      visit(options);
      expect(shouldShowIntro()).toBe(false);
    },
  );

  it("keeps the site available when session storage is blocked", () => {
    const getItem = visit();
    getItem.mockImplementation(() => {
      throw new DOMException("Storage blocked", "SecurityError");
    });
    expect(shouldShowIntro()).toBe(false);
  });

  it("renders the landing content without a browser", () => {
    expect(shouldShowIntro()).toBe(false);
    expect(
      renderToStaticMarkup(
        <LandingIntro>
          <h1>Reversy</h1>
        </LandingIntro>,
      ),
    ).toBe("<h1>Reversy</h1>");
  });
});
