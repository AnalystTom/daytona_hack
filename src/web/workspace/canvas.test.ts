import { describe, expect, it } from "vitest";
import { fitCamera, zoomAt } from "./Canvas";

describe("zoomAt", () => {
  it("keeps the point under the cursor in place", () => {
    const camera = zoomAt({ x: 10, y: 20, zoom: 1 }, { x: 110, y: 220 }, 2);
    expect(camera).toEqual({ x: -90, y: -180, zoom: 2 });
    // Canvas point (100, 200) was at screen (110, 220) and still is.
    expect(100 * camera.zoom + camera.x).toBe(110);
    expect(200 * camera.zoom + camera.y).toBe(220);
  });

  it("stops at the zoom limits", () => {
    expect(zoomAt({ x: 0, y: 0, zoom: 1 }, { x: 0, y: 0 }, 100).zoom).toBe(2);
    expect(zoomAt({ x: 0, y: 0, zoom: 1 }, { x: 0, y: 0 }, 0.01).zoom).toBe(
      0.25,
    );
  });
});

describe("fitCamera", () => {
  it("zooms out to show everything, centred", () => {
    const camera = fitCamera(
      { x: 0, y: 0, width: 2000, height: 500 },
      { width: 1064, height: 800 },
    );
    expect(camera.zoom).toBe(0.5);
    expect(camera).toMatchObject({ x: 32, y: 275 });
  });

  it("never zooms in past 100%", () => {
    const camera = fitCamera(
      { x: 40, y: 40, width: 100, height: 100 },
      { width: 1000, height: 800 },
    );
    expect(camera).toEqual({ zoom: 1, x: 410, y: 310 });
  });
});
