import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LandingIntro, shouldShowIntro } from "./Intro";

afterEach(() => vi.unstubAllGlobals());

function visit({ seen = false, reducedMotion = false, hash = "" } = {}) {
  const getItem = vi.fn(() => (seen ? "1" : null));
  vi.stubGlobal("window", {
    location: { hash },
    matchMedia: () => ({ matches: reducedMotion }),
    sessionStorage: { getItem },
  });
  return getItem;
}

describe("landing intro", () => {
  it("offers the approved video to a first visitor without autoplay", () => {
    visit();
    const html = renderToStaticMarkup(
      <LandingIntro>
        <h1>Reversy</h1>
      </LandingIntro>,
    );
    expect(html).toContain('src="/intro/reversy-intro.mp4"');
    expect(html).toContain('poster="/intro/daytona-poster.jpg"');
    expect(html).toContain("Play Reversy intro");
    expect(html).toContain("Skip intro");
    expect(html).not.toContain("autoPlay");
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
