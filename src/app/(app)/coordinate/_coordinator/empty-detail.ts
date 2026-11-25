import type { DetailFormOptions } from "@/domain/coordinator/views";
import type { DetailWire } from "./detail-input";

/** A blank detail form: the first job type and the default position, one person. */
export function emptyDetail(o: DetailFormOptions): DetailWire {
  return {
    vendorId: "",
    locationId: "",
    typeId: o.types[0]?.id ?? "",
    title: "",
    description: "",
    notes: "",
    startTime: "",
    endTime: "",
    rate: "",
    positions: [{ positionTypeId: o.defaultPositionTypeId ?? o.positionTypes[0]?.id ?? "", count: 1 }],
    opsPlanRequired: false,
    contactName: "",
    contactPhone: "",
    held: false,
    flex: null,
    safetyNotes: "",
    safetyAddresses: [],
  };
}
