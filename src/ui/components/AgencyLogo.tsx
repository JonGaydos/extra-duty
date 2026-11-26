import Image from "next/image";
import { containSize, logoSlot, type LogoPlace } from "@/lib/logo-fit";

export type AgencyLogoData = { fileId: string; width: number; height: number; transparent: boolean };

const PLATE: Record<Exclude<LogoPlace, "pdf">, string> = {
  signIn: "rounded-2xl border border-line p-2.5",
  header: "rounded-sm p-0.5",
};

/**
 * The agency logo in its slot: the square slot for round, square and tall logos, the wider one for logos about
 * 1.3:1 and wider. Always contained, never cropped or stretched. By day it sits on white. At night a logo with no
 * transparency (a JPG, or a PNG on an opaque background) keeps a light plate so its background does not glare as
 * a hard box edge; a transparent logo sits directly on the dark surface. The agency's name is printed beside it,
 * so the image itself is decorative unless `alt` names it (where the logo is shown on its own).
 */
export function AgencyLogo({ logo, place, alt = "" }: Readonly<{ logo: AgencyLogoData; place: Exclude<LogoPlace, "pdf">; alt?: string }>) {
  const slot = logoSlot(place, logo.width, logo.height);
  const size = containSize(logo.width, logo.height, slot);
  const plate = logo.transparent ? "bg-logo-clear" : "bg-logo-plate";
  return (
    <span data-logo-shape={slot.shape} data-logo-plate={logo.transparent ? "day" : "always"} className={`inline-flex shrink-0 items-center justify-center ${plate} ${PLATE[place]}`}>
      <Image src={`/api/v1/agency/logo?v=${logo.fileId}`} alt={alt} width={size.width} height={size.height} unoptimized priority={place === "signIn"} className="block object-contain" style={{ width: size.width, height: size.height }} />
    </span>
  );
}
