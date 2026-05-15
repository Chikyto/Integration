const parseCsvEnv = (value, fallback) => {
  if (!value || typeof value !== "string") {
    return fallback;
  }

  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return items.length > 0 ? items : fallback;
};

const ALERT_EMAIL_ENABLED = process.env.ALERT_EMAIL_ENABLED !== "false";
const ALERT_EMAIL_TYPES = parseCsvEnv(process.env.ALERT_EMAIL_TYPES, ["critical_zone", "exit_zone"]);
const ALERT_EMAIL_SEVERITIES = parseCsvEnv(process.env.ALERT_EMAIL_SEVERITIES, ["critical"]);
const ADMIN_RECIPIENT_ROLES = ["admin", "administrador"];

module.exports = {
  ADMIN_RECIPIENT_ROLES,
  ALERT_EMAIL_ENABLED,
  ALERT_EMAIL_SEVERITIES,
  ALERT_EMAIL_TYPES,
};
