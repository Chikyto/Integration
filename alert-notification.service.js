const { prisma } = require("../../config/db");
const { sendEmail } = require("../../services/email.service");
const logger = require("../../utils/logger");
const auditService = require("../audit/audit.service");
const {
  ADMIN_RECIPIENT_ROLES,
  ALERT_EMAIL_ENABLED,
  ALERT_EMAIL_SEVERITIES,
  ALERT_EMAIL_TYPES,
} = require("./alert-notification.config");
const {
  buildAlertEmailHtml,
  buildAlertEmailSubject,
  buildAlertEmailText,
} = require("./alert-notification.template");

const isCriticalAlert = (alert) =>
  ALERT_EMAIL_TYPES.includes(alert?.alertType) ||
  ALERT_EMAIL_SEVERITIES.includes(alert?.metadata?.severity);

const notifyCriticalAlertById = async (alertId) => {
  if (!ALERT_EMAIL_ENABLED) return { notified: false, reason: "disabled" };

  const alert = await prisma.alert.findUnique({
    where: { id: alertId },
    select: {
      id: true,
      alertType: true,
      message: true,
      hospitalId: true,
      createdAt: true,
      metadata: true,
      device: { select: { id: true, name: true } },
      hospital: { select: { id: true, name: true } },
    },
  });

  if (!alert || !isCriticalAlert(alert)) {
    return { notified: false, reason: "not_critical_or_missing" };
  }

  const recipients = await prisma.user.findMany({
    where: { hospitalId: alert.hospitalId, isActive: true, role: { in: ADMIN_RECIPIENT_ROLES } },
    select: { email: true },
  });
  const emails = recipients.map((recipient) => recipient.email?.trim()).filter(Boolean);

  if (emails.length === 0) {
    logger.warn("critical_alert_email_skipped", {
      alertId: alert.id,
      hospitalId: alert.hospitalId,
      reason: "no_admin_recipients",
    });
    return { notified: false, reason: "no_admin_recipients" };
  }

  const severityLabel = alert.metadata?.severity || "critical";
  const mailPayload = {
    hospitalName: alert.hospital.name,
    alertType: alert.alertType,
    message: alert.message,
    deviceName: alert.device?.name || alert.metadata?.deviceName || "Equipo sin nombre",
    zoneName: alert.metadata?.zoneName || alert.metadata?.zoneId || "Sin zona",
    detectedAt: new Date(alert.metadata?.lastDetectedAt || alert.createdAt).toLocaleString("es-AR"),
    severityLabel,
  };
  const subject = buildAlertEmailSubject(alert.hospital.name, severityLabel);
  const html = buildAlertEmailHtml(mailPayload);
  const text = buildAlertEmailText(mailPayload);
  const results = await Promise.allSettled(emails.map((to) => sendEmail({ to, subject, html, text })));
  const sent = results.filter((result) => result.status === "fulfilled").length;
  const failed = results.length - sent;

  await auditService.createAuditLog({
    action: "alert.critical_email_sent",
    resourceType: "alert",
    resourceId: alert.id,
    hospitalId: alert.hospitalId,
    metadata: { subject, recipients: emails, sent, failed, severity: severityLabel, alertType: alert.alertType },
  });

  logger.info("critical_alert_email_processed", {
    alertId: alert.id,
    hospitalId: alert.hospitalId,
    sent,
    failed,
    recipients: emails,
  });

  return { notified: sent > 0, sent, failed, recipients: emails };
};

module.exports = { isCriticalAlert, notifyCriticalAlertById };
