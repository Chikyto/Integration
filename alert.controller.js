const auditService = require("../audit/audit.service");
const alertService = require("./alert.service");
const logger = require("../../utils/logger");
const asyncHandler = require("../../utils/async-handler");
const { sendSuccess } = require("../../utils/http-response");
const {
  buildPaginationMeta,
  parseDateRange,
  parsePagination,
  parseSort,
} = require("../../utils/list-query");
const { resolveTenantScope } = require("../../utils/tenant-access");

const getAlerts = asyncHandler(async (req, res) => {
  const pagination = parsePagination(req.query);
  const sort = parseSort(req.query, ["createdAt", "status", "alertType"], "createdAt");
  const dateRange = parseDateRange(req.query);
  const hospitalId =
    resolveTenantScope(req.user) ||
    (req.user.role === "root" ? req.query.hospitalId : undefined);
  const alerts = await alertService.listAlerts({
    hospitalId,
    status: req.query.status,
    type: req.query.type,
    dateRange,
    pagination,
    sort,
  });

  return sendSuccess(res, {
    message: "Lista de alertas",
    data: alerts.items,
    pagination: buildPaginationMeta({
      page: pagination.page,
      limit: pagination.limit,
      total: alerts.total,
    }),
  });
});

const resolveAlert = asyncHandler(async (req, res) => {
  const alert = await alertService.resolveAlert(req.params.id, {
    hospitalId: req.user.role === "root" ? undefined : req.user.hospitalId,
  });

  await auditService.createAuditLog({
    action: "alert.resolved",
    resourceType: "alert",
    resourceId: alert.id,
    actorUserId: req.user?.sub,
    hospitalId: alert.hospitalId,
    metadata: {
      requestId: req.requestId,
      deviceId: alert.deviceId,
      alertType: alert.alertType,
    },
  });

  logger.info("alert_resolved", {
    requestId: req.requestId,
    alertId: alert.id,
    hospitalId: alert.hospitalId,
    actorUserId: req.user?.sub,
    alertType: alert.alertType,
  });

  return sendSuccess(res, {
    message: "Alerta resuelta",
    data: alert,
  });
});

module.exports = { getAlerts, resolveAlert };
