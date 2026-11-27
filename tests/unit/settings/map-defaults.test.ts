import { describe, expect, test } from "vitest";
import { DEFAULT_SETTINGS, settingsDefaults } from "@/domain/settings/defaults";

describe("map tile defaults from the server environment", () => {
  test("unset: OpenStreetMap's tile server and attribution", () => {
    const d = settingsDefaults({});
    expect(d.mapTileUrl).toBe("https://tile.openstreetmap.org/{z}/{x}/{y}.png");
    expect(d.mapAttribution).toBe("© OpenStreetMap contributors");
    expect(d).toEqual(DEFAULT_SETTINGS);
  });

  test("MAP_TILE_URL and MAP_TILE_ATTRIBUTION replace the defaults", () => {
    const d = settingsDefaults({ MAP_TILE_URL: "https://tiles.example.org/{z}/{x}/{y}.png", MAP_TILE_ATTRIBUTION: "© Example Tiles" });
    expect(d.mapTileUrl).toBe("https://tiles.example.org/{z}/{x}/{y}.png");
    expect(d.mapAttribution).toBe("© Example Tiles");
  });

  test("blank values keep the defaults", () => {
    const d = settingsDefaults({ MAP_TILE_URL: "  ", MAP_TILE_ATTRIBUTION: "" });
    expect(d.mapTileUrl).toBe(DEFAULT_SETTINGS.mapTileUrl);
    expect(d.mapAttribution).toBe(DEFAULT_SETTINGS.mapAttribution);
  });
});
