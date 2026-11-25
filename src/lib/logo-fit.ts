/**
 * Where the agency logo goes and how big: a square slot for round, square and tall logos, and a wider slot of the
 * same height for wide ones (about 1.3:1 and wider), where the logo is as wide as its ratio needs up to the slot's
 * width. The logo is always contained, never cropped or stretched.
 */

export type LogoShape = "square" | "wide";
export type LogoPlace = "signIn" | "header" | "pdf";
type Box = { width: number; height: number };

/** About 1.3:1: anything this wide or wider takes the wide slot. */
export const WIDE_RATIO = 1.3;

/** CSS pixels on screen, points on the PDF. */
export const LOGO_SLOTS: Record<LogoPlace, Record<LogoShape, Box>> = {
  signIn: { square: { width: 88, height: 88 }, wide: { width: 240, height: 88 } },
  header: { square: { width: 40, height: 40 }, wide: { width: 96, height: 40 } },
  pdf: { square: { width: 56, height: 56 }, wide: { width: 150, height: 56 } },
};

export function logoShape(width: number | null | undefined, height: number | null | undefined): LogoShape {
  if (!width || !height) return "square";
  return width / height >= WIDE_RATIO ? "wide" : "square";
}

/** The largest size of a width by height image that fits in the box with its ratio kept (CSS object-fit: contain). */
export function containSize(width: number, height: number, box: Box): Box {
  const scale = Math.min(box.width / width, box.height / height);
  return { width: Math.min(box.width, Math.round(width * scale)), height: Math.min(box.height, Math.round(height * scale)) };
}

export function logoSlot(place: LogoPlace, width: number | null | undefined, height: number | null | undefined): Box & { shape: LogoShape } {
  const shape = logoShape(width, height);
  return { shape, ...LOGO_SLOTS[place][shape] };
}
