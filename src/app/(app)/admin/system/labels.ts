import type { AgencySettings } from "@/domain/settings/settings";

export const PROVIDER_LABEL: Record<AgencySettings["email"]["provider"], string> = {
  smtp: "SMTP server",
  postmark: "Postmark",
  ses: "Amazon SES",
  sendgrid: "SendGrid",
  mailgun: "Mailgun",
};
