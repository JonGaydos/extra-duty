import { redirect } from "next/navigation";

/** Alert and email links name /settings; a person's own settings live in Profile. */
export default function SettingsPage() {
  redirect("/profile#alerts");
}
