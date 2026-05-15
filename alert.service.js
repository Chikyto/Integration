const { prisma } = require("../../config/db");

// alertType values that belong to each category
const INFRA_ALERT_TYPES = ["agent_disconnected", "antenna_disconnected", "reader_offline", "temperature_high"];

// Mapea un registro Alert de Prisma al shape que espera el frontend.
// deviceName viene de la relación device; el resto de los campos de zona
// y estado de reconocimiento viven en metadata para evitar migración de schema.
const mapAlertForClient = (alert) => {
  const meta = alert.metadata || {};
  const base = {
    id: alert.id,
    alertType: alert.alertType,
    status: alert.status,
    message: alert.message,
    createdAt: alert.createdAt,
    deviceId: alert.deviceId,
    deviceName: alert.device?.name ?? meta.deviceName ?? null,
    tagId: meta.chipId ?? null,
    zoneId: meta.zoneId ?? null,
    zoneName: meta.zoneName ?? null,
    zoneCategory: meta.zoneCategory ?? null,
    isExitZone: meta.isExitZone ?? false,
    severity: meta.severity ?? (alert.alertType === "exit_zone" ? "critical" : "warning"),
    detectedAt: meta.lastDetectedAt ?? alert.createdAt,
    acknowledgedAt: meta.acknowledgedAt ?? null,
    acknowledgedBy: meta.acknowledgedBy ?? null,
    antennaPort: meta.antennaPort ?? null,
    antennaLabel: meta.antennaLabel ?? null,
  };

  // Campos específicos de alertas de infraestructura
  if (INFRA_ALERT_TYPES.includes(alert.alertType)) {
    base.agentId        = meta.agentId ?? null;
    base.agentName      = meta.agentName ?? null;
    base.lastOccurredAt = meta.lastOccurredAt ?? null;
    // resolvedAt: cuando el status es "resolved", updatedAt refleja cuándo se resolvió
    base.resolvedAt     = alert.status === "resolved" ? (alert.updatedAt ?? null) : null;
  }

  return base;
};

const SECURITY_ALERT_TYPES_EXCLUDE = INFRA_ALERT_TYPES; // security = everything that is NOT infra

const listAlerts = async ({ hospitalId, status, type, category, dateRange, pagination, sort }) => {
  // category: "security" | "infrastructure" | undefined (all)
  let alertTypeFilter = type ? { alertType: type } : {};
  if (!type && category === "infrastructure") {
    alertTypeFilter = { alertType: { in: INFRA_ALERT_TYPES } };
  } else if (!type && category === "security") {
    alertTypeFilter = { alertType: { notIn: SECURITY_ALERT_TYPES_EXCLUDE } };
  }

  const where = {
    ...(hospitalId ? { hospitalId } : {}),
    ...(status ? { status } : {}),
    ...alertTypeFilter,
    ...(dateRange ? { createdAt: dateRange } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.alert.findMany({
      where,
      include: { device: { select: { id: true, name: true, tag: true } } },
      orderBy: sort.orderBy,
      skip: pagination.skip,
      take: pagination.limit,
    }),
    prisma.alert.count({ where }),
  ]);

  return { items, total };
};

// Versión de listAlerts que devuelve el shape plano esperado por el frontend.
const listAlertsMapped = async (options) => {
  const result = await listAlerts(options);
  return {
    items: result.items.map(mapAlertForClient),
    total: result.total,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Alertas de infraestructura (sin deviceId): agent_disconnected,
// antenna_disconnected, reader_offline.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Crea (o reutiliza si ya existe una open/acknowledged) una alerta de infra.
 *
 * @param {object} opts
 * @param {string} opts.hospitalId
 * @param {string} opts.agentId   - ID lógico del agente (no el credential id)
 * @param {string} opts.alertType - "agent_disconnected" | "antenna_disconnected" | "reader_offline"
 * @param {string} opts.message
 * @param {object} [opts.metadata]
 * @param {string} [opts.scopeKey] - Clave de dedup adicional. Para antenna_disconnected se
 *   pasa "port:<N>" para que cada puerto tenga su propia alerta independiente.
 *   Defaults a agentId cuando no se especifica.
 */
const createInfraAlert = async ({ hospitalId, agentId, alertType, message, metadata = {}, scopeKey }) => {
  // La clave real de dedup combina agentId con el scopeKey opcional.
  const dedupeKey = scopeKey ? `${agentId}:${scopeKey}` : agentId;

  // Dedup: si ya hay una alerta abierta del mismo tipo para este scope, la refreshamos.
  // Buscamos por dedupeKey (nuevo campo) o por agentId (alertas antiguas sin dedupeKey).
  const existing = await prisma.alert.findFirst({
    where: {
      hospitalId,
      alertType,
      status: { in: ["open", "acknowledged"] },
      OR: [
        { metadata: { path: ["dedupeKey"], equals: dedupeKey } },
        // Compatibilidad hacia atrás: alertas sin dedupeKey, solo cuando no hay scopeKey
        ...(!scopeKey ? [{ metadata: { path: ["agentId"], equals: agentId } }] : []),
      ],
    },
    select: { id: true, metadata: true },
  });

  if (existing) {
    await prisma.alert.update({
      where: { id: existing.id },
      data: {
        // Actualizar también el message para que refleje la info más reciente
        message,
        metadata: {
          ...(existing.metadata || {}),
          ...metadata,
          dedupeKey,
          lastOccurredAt: new Date().toISOString(),
        },
      },
    });
    return { alertCreated: false, alertId: existing.id, reason: "duplicate_refreshed" };
  }

  const alert = await prisma.alert.create({
    data: {
      hospitalId,
      alertType,
      message,
      status: "open",
      metadata: {
        agentId,
        dedupeKey,
        ...metadata,
        createdAt: new Date().toISOString(),
      },
    },
  });
  return { alertCreated: true, alertId: alert.id };
};

/**
 * Resuelve alertas abiertas del tipo indicado para este agente.
 * Si se pasa scopeKey, resuelve solo la del puerto/scope específico.
 */
const resolveInfraAlert = async ({ hospitalId, agentId, alertType, scopeKey }) => {
  const dedupeKey = scopeKey ? `${agentId}:${scopeKey}` : agentId;

  const alerts = await prisma.alert.findMany({
    where: {
      hospitalId,
      alertType,
      status: { in: ["open", "acknowledged"] },
      OR: [
        { metadata: { path: ["dedupeKey"], equals: dedupeKey } },
        ...(!scopeKey ? [{ metadata: { path: ["agentId"], equals: agentId } }] : []),
      ],
    },
    select: { id: true },
  });

  if (alerts.length === 0) return { resolved: 0 };

  await prisma.alert.updateMany({
    where: { id: { in: alerts.map((a) => a.id) } },
    data: { status: "resolved" },
  });
  return { resolved: alerts.length };
};

// Marca una alerta como "acknowledged" y guarda quién la reconoció.
// No elimina la alerta — sigue visible en el panel pero con estado reconocido.
const acknowledgeAlert = async (id, options = {}) => {
  const alert = await prisma.alert.findFirst({
    where: {
      id,
      ...(options.hospitalId ? { hospitalId: options.hospitalId } : {}),
    },
  });

  if (!alert) {
    const notFoundError = new Error("ALERT_NOT_FOUND");
    notFoundError.code = "P2025";
    throw notFoundError;
  }

  const updatedAlert = await prisma.alert.update({
    where: { id },
    data: {
      status: "acknowledged",
      metadata: {
        ...(alert.metadata || {}),
        acknowledgedAt: new Date().toISOString(),
        acknowledgedBy: options.actorUserId ?? null,
      },
    },
    include: { device: { select: { id: true, name: true, tag: true } } },
  });

  return mapAlertForClient(updatedAlert);
};

// Devuelve las detecciones RFID del chip asociado a la alerta en una ventana
// de ±2h alrededor de cuando se disparó, ordenadas cronológicamente.
const getAlertTrail = async (alertId, options = {}) => {
  const alert = await prisma.alert.findFirst({
    where: {
      id: alertId,
      ...(options.hospitalId ? { hospitalId: options.hospitalId } : {}),
    },
    select: { metadata: true, hospitalId: true, createdAt: true, deviceId: true },
  });

  if (!alert) {
    const err = new Error("ALERT_NOT_FOUND");
    err.statusCode = 404;
    throw err;
  }

  // chipId puede faltar en alertas antiguas — buscar en TagRfid del dispositivo.
  let chipId = alert.metadata?.chipId ?? null;
  if (!chipId && alert.deviceId) {
    const tagRecord = await prisma.tagRfid.findFirst({
      where: { assignedDeviceId: alert.deviceId },
      select: { tag: true },
      orderBy: { createdAt: "desc" },
    });
    chipId = tagRecord?.tag ?? null;
  }

  if (!chipId) return [];

  // Últimas 200 detecciones (DESC = más reciente primero), luego se colapsan.
  const raw = await prisma.rfidEvent.findMany({
    where: { hospitalId: alert.hospitalId, chipId },
    orderBy: { timestamp: "desc" },
    take: 200,
    select: { id: true, timestamp: true, zoneId: true, zoneName: true, port: true, antennaLabel: true },
  });

  const events = raw.map((e) => ({ ...e, id: String(e.id) })); // ya viene DESC

  // Colapsar detecciones consecutivas en la misma zona+antena en una sola fila.
  if (events.length === 0) return [];
  const collapsed = [events[0]];
  for (let i = 1; i < events.length; i++) {
    const prev = collapsed[collapsed.length - 1];
    const curr = events[i];
    const sameLocation =
      curr.zoneId === prev.zoneId &&
      curr.port === prev.port &&
      curr.antennaLabel === prev.antennaLabel;
    if (!sameLocation) {
      collapsed.push(curr);
    }
  }

  // Marcar cada fila como crítica si su antena coincide con la que disparó
  // esta alerta (zoneId + antennaPort guardados en metadata).
  const alertZoneId    = alert.metadata?.zoneId ?? null;
  const alertPort      = alert.metadata?.antennaPort ?? null;
  const alertIsExit    = alert.metadata?.isExitZone ?? false;
  const alertCategory  = alert.metadata?.zoneCategory ?? null;

  return collapsed.map((e) => ({
    ...e,
    isCritical:
      alertIsExit || alertCategory === "critical"
        ? e.zoneId === alertZoneId && (alertPort === null || e.port === alertPort)
        : false,
  }));
};

const createAlerts = async (tx, alerts) => {
  if (alerts.length === 0) {
    return [];
  }

  const createdAlerts = [];

  for (const alert of alerts) {
    const createdAlert = await tx.alert.create({
      data: alert,
    });

    createdAlerts.push(createdAlert);
  }

  return createdAlerts;
};

const resolveAlert = async (id, options = {}) => {
  const alert = await prisma.alert.findFirst({
    where: {
      id,
      hospitalId: options.hospitalId,
    },
  });

  if (!alert) {
    const notFoundError = new Error("ALERT_NOT_FOUND");
    notFoundError.code = "P2025";
    throw notFoundError;
  }

  return prisma.alert.update({
    where: { id },
    data: {
      status: "resolved",
    },
  });
};

module.exports = {
  listAlerts,
  listAlertsMapped,
  createAlerts,
  resolveAlert,
  acknowledgeAlert,
  getAlertTrail,
  createInfraAlert,
  resolveInfraAlert,
  INFRA_ALERT_TYPES,
};
