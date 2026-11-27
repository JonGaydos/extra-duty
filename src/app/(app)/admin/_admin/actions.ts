"use server";

import { eq } from "drizzle-orm";
import { qualifications, ranks as ranksTable } from "@/db/schema";
import type { Role } from "@/domain/actor";
import { createInvite } from "@/domain/auth/invites";
import { assertCan } from "@/domain/auth/policy";
import { createSeason, deleteSeason, updateSeason } from "@/domain/caps/seasons";
import { ValidationError } from "@/domain/errors";
import { activeApiKeysOf } from "@/domain/api-keys/api-keys";
import {
  createJobType,
  createNotePreset,
  createPaymentMethod,
  createPositionType,
  createVendorType,
  deletePositionType,
  NOTE_PRESET_CONTEXTS,
  setJobTypeActive,
  setNotePresetActive,
  setPaymentMethodActive,
  setPositionTypeActive,
  setVendorTypeActive,
  updateJobType,
  updateNotePreset,
  updatePaymentMethod,
  updatePositionType,
  updateVendorType,
  type NotePresetContext,
  type PositionTypeInput,
} from "@/domain/jobs/job-types";
import {
  createQualification,
  decideQualificationRequest,
  grantQualification,
  renameQualification,
  revokeQualification,
  setQualificationActive,
} from "@/domain/jobs/qualifications";
import { saveAgencyNotifications } from "@/domain/notifications/agency";
import { CATALOG, GROUP_LABEL, type RecipientGroup } from "@/domain/notifications/catalog";
import { applyRankChange, deleteRank, previewRankChange, renameRank, setRankActive, type RankChange } from "@/domain/ranks/ranks";
import { removeAgencyLogo } from "@/domain/settings/logo";
import { agencyDateOnly } from "@/domain/time/agency-time";
import { decideAccessReviewItem, startAccessReview, type ReviewDecision } from "@/domain/users/access-review";
import { liftSuspension, suspendUser } from "@/domain/users/suspension";
import { writeOffDetail, type DepartureChecklist } from "@/domain/users/departure";
import { createUser, deactivateUser, departureChecklist, getUserOrThrow, reactivateUser, updateUser } from "@/domain/users/users";
import { reviewW9 } from "@/domain/w9/w9";
import { createW9Request } from "@/domain/w9/requests";
import type { W9RequestAudience } from "@/db/schema";
import { parseDollars } from "../../coordinate/_coordinator/detail-input";
import { plural } from "../../_personnel/format";
import { act, type ActionResult } from "../../_personnel/result";
import { GROUPS, PAGE_GROUPS, type GroupValues } from "./settings-groups";
import { saveGroup } from "./settings-save";

/** Server actions for the Management screens: each checks the person, calls one service and reports back. */

const blank = (v: string | undefined) => (v ?? "").trim() || null;
const STAFF_ROLES: readonly Role[] = ["admin", "coordinator", "personnel"];

// Users

export type UserFields = { name: string; email: string; phone: string; role: Role; rankId: string; badgeNumber: string };

export async function inviteUserAction(input: UserFields & { qualificationIds: string[] }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    if (!STAFF_ROLES.includes(input.role)) throw new ValidationError("Choose a role.");
    const u = await createUser(actor, tx, {
      name: input.name,
      email: input.email,
      phone: blank(input.phone),
      role: input.role,
      rankId: blank(input.rankId),
      badgeNumber: blank(input.badgeNumber),
      qualificationIds: input.qualificationIds,
    });
    return { ok: true, value: u.id, message: `Invite sent to ${u.email}.` };
  });
}

export async function updateUserAction(input: Omit<UserFields, "email"> & { id: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    if (!STAFF_ROLES.includes(input.role)) throw new ValidationError("Choose a role.");
    await updateUser(actor, tx, input.id, { name: input.name, phone: blank(input.phone), role: input.role, rankId: blank(input.rankId), badgeNumber: blank(input.badgeNumber) });
    return { ok: true, message: "Account saved." };
  });
}

export async function suspendUserAction(input: { id: string; reason: string; until: string; removeFutureAssignments: boolean }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    let until: Date | null = null;
    if (input.until) {
      until = agencyDateOnly(input.until, "start");
      if (!until) throw new ValidationError("Choose the date the suspension ends, or leave it blank.");
    }
    await suspendUser(actor, tx, input.id, { reason: input.reason, until, removeFutureAssignments: input.removeFutureAssignments });
    return { ok: true, message: "Suspended. They were told why." };
  });
}

/** Approve a pending W-9 with its signature date and form revision, or reject it with a reason. */
export async function reviewW9Action(input: { w9Id: string; decision: "approve" | "reject"; signedOn?: string; formRevision?: string; reason?: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const review = input.decision === "approve" ? { decision: "approve" as const, signedOn: input.signedOn ?? "", formRevision: input.formRevision ?? "" } : { decision: "reject" as const, reason: input.reason ?? "" };
    const row = await reviewW9(actor, tx, input.w9Id, review);
    return { ok: true, message: row.status === "approved" ? "W-9 approved. They were told." : "W-9 not approved. They were told why and asked for a new one." };
  });
}

/** Ask everyone, a rank, a special flag or one person for a new W-9 by a due date. */
export async function createW9RequestAction(input: { kind: "everyone" | "rank" | "flag" | "person"; id: string; dueOn: string; note: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const audiences: Record<typeof input.kind, () => W9RequestAudience> = {
      everyone: () => ({ kind: "everyone" }),
      rank: () => ({ kind: "rank", rankId: input.id }),
      flag: () => ({ kind: "flag", qualificationId: input.id }),
      person: () => ({ kind: "users", userIds: [input.id] }),
    };
    const make = audiences[input.kind];
    if (!make) throw new ValidationError("Choose who to ask.");
    const row = await createW9Request(actor, tx, { audience: make(), dueOn: input.dueOn, note: input.note });
    return { ok: true, message: `Request sent: ${row.audienceLabel}. They were told the due date.` };
  });
}

export async function liftSuspensionAction(id: string): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await liftSuspension(actor, tx, id);
    return { ok: true, message: "Suspension lifted." };
  });
}

/** The checklist shown before someone is turned off: nothing changes. */
/** The checklist shown before someone is turned off, as JSON in `value` (see DepartureChecklist). Nothing changes. */
export async function departureChecklistAction(input: { id: string; lastDay: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const list: DepartureChecklist = await departureChecklist(actor, tx, input.id, input.lastDay);
    return { ok: true, value: JSON.stringify(list) };
  });
}

/** `keysStopConfirmed`: the admin saw that this account's active API keys will stop working, and went ahead. */
export async function deactivateUserAction(input: { id: string; reason: string; lastDay: string; keysStopConfirmed?: boolean }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    if (!input.keysStopConfirmed && actor.role === "admin" && (await activeApiKeysOf(actor, tx, input.id)).length > 0) {
      throw new ValidationError("This admin has active API keys that will stop working. Confirm that before turning the account off.");
    }
    const r = await deactivateUser(actor, tx, input.id, { reason: input.reason, lastDay: input.lastDay });
    const removed = r.removed.length ? ` ${plural(r.removed.length, "sign-up")} removed.` : "";
    return { ok: true, message: `Account turned off. Their history stays.${removed}` };
  });
}

export async function reactivateUserAction(input: { id: string; reason: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await reactivateUser(actor, tx, input.id, input.reason);
    return { ok: true, message: "Account turned back on. They sign in with their password, or reset it." };
  });
}

export async function writeOffDetailAction(input: { assignmentId: string; reason: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await writeOffDetail(actor, tx, input.assignmentId, input.reason);
    return { ok: true, message: "Written off. It no longer waits to be billed." };
  });
}

export async function resendInviteAction(id: string): Promise<ActionResult> {
  return act(async (actor, tx) => {
    assertCan(actor, "user.manage");
    const u = await getUserOrThrow(tx, id);
    await createInvite(actor, tx, id);
    return { ok: true, message: `Invite sent to ${u.email}. Any earlier link still works until it expires.` };
  });
}

// Special flags

export async function grantFlagAction(input: { userId: string; qualificationId: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    if (!input.userId) throw new ValidationError("Choose a person.");
    if (!input.qualificationId) throw new ValidationError("Choose a flag.");
    await grantQualification(actor, tx, input.userId, input.qualificationId);
    const u = await getUserOrThrow(tx, input.userId);
    const [q] = await tx.select({ name: qualifications.name }).from(qualifications).where(eq(qualifications.id, input.qualificationId));
    return { ok: true, message: `${q.name} granted to ${u.name}.` };
  });
}

export async function revokeFlagAction(input: { userId: string; qualificationId: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await revokeQualification(actor, tx, input.userId, input.qualificationId);
    return { ok: true, message: "Revoked." };
  });
}

export async function decideFlagRequestAction(input: { id: string; approve: boolean; reason: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    if (!input.approve && !input.reason.trim()) throw new ValidationError("Give a reason so the person knows what to do next.");
    await decideQualificationRequest(actor, tx, input.id, { approve: input.approve, reason: input.reason });
    return { ok: true, message: input.approve ? "Approved. The flag is granted." : "Denied. They will see your reason." };
  });
}

export async function createFlagAction(name: string): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const q = await createQualification(actor, tx, { name });
    return { ok: true, value: q.id, message: "Flag added." };
  });
}

export async function renameFlagAction(input: { id: string; name: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await renameQualification(actor, tx, input.id, { name: input.name });
    return { ok: true, message: "Renamed." };
  });
}

export async function flagActiveAction(input: { id: string; active: boolean }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await setQualificationActive(actor, tx, input.id, input.active);
    return { ok: true, message: input.active ? "Turned on." : "Turned off. People keep it, but it is no longer offered." };
  });
}

// Ranks

/** One rewritten position type, as the Ranks page's confirm step shows it. */
export type RankChangeEffect = { name: string; added: string[]; removed: string[]; upcomingDetails: number };

/** What a ladder change would do to who can fill each position type; `value` is the list as JSON. */
export async function previewRankChangeAction(change: RankChange): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const effects: RankChangeEffect[] = (await previewRankChange(actor, tx, change)).map(({ name, added, removed, upcomingDetails }) => ({ name, added, removed, upcomingDetails }));
    return { ok: true, value: JSON.stringify(effects) };
  });
}

const RANK_DONE: Record<RankChange["kind"], string> = { move: "Order saved.", ladder: "Ladder saved.", create: "Rank added." };

export async function applyRankChangeAction(change: RankChange): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const { positions } = await applyRankChange(actor, tx, change);
    const updated = positions.length ? ` ${plural(positions.length, "position type")} updated.` : "";
    return { ok: true, message: `${RANK_DONE[change.kind]}${updated}` };
  });
}

export async function renameRankAction(input: { id: string; name: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const r = await renameRank(actor, tx, input.id, input.name);
    return { ok: true, message: `Renamed to ${r.name}.` };
  });
}

export async function rankActiveAction(input: { id: string; active: boolean }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const r = await setRankActive(actor, tx, input.id, input.active);
    return { ok: true, message: `${r.name} turned ${input.active ? "on" : "off"}.` };
  });
}

export async function deleteRankAction(id: string): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const [r] = await tx.select({ name: ranksTable.name }).from(ranksTable).where(eq(ranksTable.id, id));
    await deleteRank(actor, tx, id);
    return { ok: true, message: `${r?.name ?? "Rank"} deleted.` };
  });
}

// Seasons

export type SeasonFields = { name: string; start: string; end: string; rolling: string; week: string; month: string };

/** Hours as typed ("16" or "16.5") to whole minutes; blank means no cap. */
function capMinutes(v: string, label: string): number | null {
  const t = v.trim();
  if (!t) return null;
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(t) || Number(t) <= 0) throw new ValidationError(`${label}: enter hours greater than zero, or leave it blank for no cap.`);
  return Math.round(Number(t) * 60);
}

export async function saveSeasonAction(input: SeasonFields & { id?: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const v = {
      name: input.name,
      startMonthDay: input.start.trim(),
      endMonthDay: input.end.trim(),
      rollingCapMinutes: capMinutes(input.rolling, "Rolling cap"),
      weekCapMinutes: capMinutes(input.week, "Week cap"),
      monthCapMinutes: capMinutes(input.month, "Month cap"),
    };
    if (input.id) await updateSeason(actor, tx, input.id, v);
    else await createSeason(actor, tx, v);
    return { ok: true, message: input.id ? "Season saved." : "Season added." };
  });
}

export async function deleteSeasonAction(id: string): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await deleteSeason(actor, tx, id);
    return { ok: true, message: "Season deleted. Dates it covered have no caps until another season covers them." };
  });
}

// Settings

const MANAGEMENT_GROUPS: readonly string[] = [...PAGE_GROUPS, "agency", "access-review"];

export async function saveSettingsAction(slug: string, values: GroupValues): Promise<ActionResult> {
  return act(async (actor, tx) => {
    assertCan(actor, "settings.update.rules");
    if (!MANAGEMENT_GROUPS.includes(slug)) throw new ValidationError("Unknown settings group.");
    return saveGroup(actor, tx, GROUPS[slug as keyof typeof GROUPS], values);
  });
}

// Notifications

/** One agency switch: Email or Push of one notification type for one recipient group. */
export async function setAgencyChannelAction(input: { type: string; group: string; channel: string; on: boolean }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    if (input.channel !== "email" && input.channel !== "push") throw new ValidationError("Choose email or push.");
    if (typeof input.on !== "boolean") throw new ValidationError("Choose on or off.");
    await saveAgencyNotifications(actor, tx, { [input.type]: { [input.group]: { [input.channel]: input.on } } });
    const entry = (CATALOG as Record<string, { label: string } | undefined>)[input.type];
    const group = GROUP_LABEL[input.group as RecipientGroup] ?? input.group;
    return { ok: true, message: `${input.channel === "email" ? "Email" : "Push"} to ${group.toLowerCase()} for ${entry?.label ?? input.type} turned ${input.on ? "on" : "off"}.` };
  });
}

// Lists: job types, vendor types, payment methods

const LISTS = {
  "job-types": { create: createJobType, update: updateJobType, setActive: setJobTypeActive },
  "vendor-types": { create: createVendorType, update: updateVendorType, setActive: setVendorTypeActive },
  "payment-methods": { create: createPaymentMethod, update: updatePaymentMethod, setActive: setPaymentMethodActive },
} as const;
type ListSlug = keyof typeof LISTS;

function list(slug: string) {
  const l = LISTS[slug as ListSlug];
  if (!l) throw new ValidationError("Unknown list.");
  return l;
}

export async function listCreateAction(input: { list: string; name: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await list(input.list).create(actor, tx, { name: input.name });
    return { ok: true, message: "Added." };
  });
}

export async function listRenameAction(input: { list: string; id: string; name: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await list(input.list).update(actor, tx, input.id, { name: input.name });
    return { ok: true, message: "Renamed." };
  });
}

export async function listActiveAction(input: { list: string; id: string; active: boolean }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await list(input.list).setActive(actor, tx, input.id, input.active);
    return { ok: true, message: input.active ? "Turned on." : "Turned off. Records that use it keep it." };
  });
}

// Position types

/** `differential` is dollars an hour as typed ("25" or "25.50"); blank is $0. */
export async function savePositionTypeAction(input: Omit<PositionTypeInput, "rateDifferentialCents"> & { id?: string; differential: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const v: PositionTypeInput = {
      name: input.name,
      eligibleRankIds: input.eligibleRankIds,
      requiredQualificationIds: input.requiredQualificationIds,
      isIncidentCommander: input.isIncidentCommander,
      vendorRequestable: input.vendorRequestable,
      rateDifferentialCents: parseDollars(input.differential ?? "", "The pay differential") ?? 0,
    };
    if (input.id) await updatePositionType(actor, tx, input.id, v);
    else await createPositionType(actor, tx, v);
    return { ok: true, message: input.id ? "Position type saved." : "Position type added." };
  });
}

export async function deletePositionTypeAction(id: string): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await deletePositionType(actor, tx, id);
    return { ok: true, message: "Position type deleted." };
  });
}

export async function positionActiveAction(input: { id: string; active: boolean }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await setPositionTypeActive(actor, tx, input.id, input.active);
    return { ok: true, message: input.active ? "Turned on." : "Turned off. Existing details keep it." };
  });
}

// Note presets

export async function createPresetAction(input: { context: string; text: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    if (!NOTE_PRESET_CONTEXTS.includes(input.context as NotePresetContext)) throw new ValidationError("Choose where the note is used.");
    await createNotePreset(actor, tx, { context: input.context as NotePresetContext, text: input.text });
    return { ok: true, message: "Preset added." };
  });
}

export async function updatePresetAction(input: { id: string; text: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await updateNotePreset(actor, tx, input.id, { text: input.text });
    return { ok: true, message: "Preset saved." };
  });
}

export async function presetActiveAction(input: { id: string; active: boolean }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await setNotePresetActive(actor, tx, input.id, input.active);
    return { ok: true, message: input.active ? "Turned on." : "Turned off." };
  });
}

// Agency logo

export async function removeLogoAction(): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await removeAgencyLogo(actor, tx);
    return { ok: true, message: "Logo removed." };
  });
}

// Access review

export async function startReviewAction(): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const r = await startAccessReview(tx, new Date(), actor);
    if (!r) throw new ValidationError("A review is already open. Finish it first.");
    return { ok: true, message: "Access review started. Decide each account below." };
  });
}

export async function decideReviewItemAction(input: { itemId: string; decision: ReviewDecision; note: string; lastDay?: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await decideAccessReviewItem(actor, tx, input.itemId, { decision: input.decision, note: input.note.trim() || undefined, lastDay: input.lastDay });
    return { ok: true, message: input.decision === "deactivate" ? "Recorded. The account is turned off and their sign-ups after the last day are removed." : "Recorded." };
  });
}
