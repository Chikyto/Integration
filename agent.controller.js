const auditService = require("../audit/audit.service");
const asyncHandler = require("../../utils/async-handler");
const AppError = require("../../utils/app-error");
const { sendSuccess } = require("../../utils/http-response");
const logger = require("../../utils/logger");
const {
  buildPaginationMeta,
  parseDateRange,
  parseBooleanQuery,
  parsePagination,
  parseSort,
} = require("../../utils/list-query");
const { resolveTenantScope } = require("../../utils/tenant-access");
const { validateAgentEventPayload } = require("./validators/agent-event.validator");
const agentService = require("./agent.service");
const hospitalService = require("../hospitals/hospital.service");
const {
  getOptionalBoolean,
  getOptionalString,
  getRequiredString,
} = require("../../utils/validation");
const { createInfraAlert, resolveInfraAlert } = require("../alerts/alert.service");
const {
  sendCommand,
  isAgentConnected,
  getConnectedAgents,
} = require("../../realtime/agent-socket");

const getAgentHealth = async (req, res) => {
  return sendSuccess(res, {
    message: "Agent API disponible",
    data: {
      status: "ok",
      authenticated: true,
      agent: req.agent,
    },
  });
};

const createAgentEvent = async (req, res) => {
  const payload = validateAgentEventPayload(req.body);
  const event = await agentService.createAgentEvent({
    payload,
    authenticatedAgent: req.agent,
  });

  logger.info("agent_event_created", {
    requestId: req.requestId,
    agentId: event.agentId,
    hospitalId: event.hospitalId,
    readerId: event.readerId,
    chipId: event.chipId,
    port: event.port,
    eventType: event.eventType,
    eventId: event.id,
  });

  return sendSuccess(res, {
    statusCode: 201,
    message: "Evento RFID registrado",
    data: event,
  });
};

const createAgentCredential = asyncHandler(async (req, res) => {
  const name = getRequiredString(req.body, "name");
  const agentId = getRequiredString(req.body, "agentId");
  const hospitalId =
    resolveTenantScope(req.user) ||
    (req.user.role === "root" ? getRequiredString(req.body, "hospitalId") : undefined);

  const result = await agentService.createAgentCredential({
    name,
    agentId,
    hospitalId,
  });

  await auditService.createAuditLog({
    action: "agent.credential.created",
    resourceType: "agent_credential",
    resourceId: result.credential.id,
    actorUserId: req.user?.sub,
    hospitalId: result.credential.hospitalId,
    metadata: {
      requestId: req.requestId,
      agentId: result.credential.agentId,
      tokenId: result.credential.tokenId,
    },
  });

  logger.info("agent_credential_created", {
    requestId: req.requestId,
    credentialId: result.credential.id,
    hospitalId: result.credential.hospitalId,
    actorUserId: req.user?.sub,
    agentId: result.credential.agentId,
  });

  return sendSuccess(res, {
    statusCode: 201,
    message: "Credencial de agente creada",
    data: {
      ...result.credential,
      token: result.token,
    },
  });
});

const getAgentCredentials = asyncHandler(async (req, res) => {
  const pagination = parsePagination(req.query);
  const sort = parseSort(req.query, ["createdAt", "name", "agentId"], "createdAt");
  const isActive =
    req.query.isActive !== undefined
      ? parseBooleanQuery(req.query.isActive, "isActive")
      : undefined;
  const hospitalId =
    resolveTenantScope(req.user) ||
    (req.user.role === "root" ? req.query.hospitalId : undefined);
  const credentials = await agentService.listAgentCredentials({
    hospitalId,
    isActive,
    pagination,
    sort,
  });
  const availableHospitals = await hospitalService.listHospitalOptions({
    hospitalId,
    isActive: true,
  });

  return sendSuccess(res, {
    message: "Lista de agentes RFID",
    data: credentials.items,
    pagination: buildPaginationMeta({
      page: pagination.page,
      limit: pagination.limit,
      total: credentials.total,
    }),
    meta: {
      availableHospitals,
    },
  });
});

const getAgentEvents = asyncHandler(async (req, res) => {
  const pagination = parsePagination(req.query);
  const sort = parseSort(req.query, ["timestamp", "createdAt", "eventType"], "timestamp");
  const hospitalId =
    resolveTenantScope(req.user) ||
    (req.user.role === "root" ? req.query.hospitalId : undefined);
  const dateRange = parseDateRange(req.query);
  const events = await agentService.listAgentEvents({
    hospitalId,
    type: req.query.type,
    dateRange,
    pagination,
    sort,
  });

  return sendSuccess(res, {
    message: "Lista de eventos RFID",
    data: events.items,
    pagination: buildPaginationMeta({
      page: pagination.page,
      limit: pagination.limit,
      total: events.total,
    }),
  });
});

const getAgentCredentialConfig = asyncHandler(async (req, res) => {
  const result = await agentService.getAgentRuntimeConfig(req.params.id, {
    hospitalId: req.user.role === "root" ? undefined : req.user.hospitalId,
  });

  return sendSuccess(res, {
    message: "Configuracion de agente",
    data: result,
  });
});

const updateAgentCredentialConfig = asyncHandler(async (req, res) => {
  if (!req.body?.config || typeof req.body.config !== "object" || Array.isArray(req.body.config)) {
    throw new AppError(400, "El cuerpo debe incluir un objeto config valido", "VALIDATION_ERROR");
  }

  const result = await agentService.upsertAgentRuntimeConfig(req.params.id, req.body.config, {
    hospitalId: req.user.role === "root" ? undefined : req.user.hospitalId,
  });

  await auditService.createAuditLog({
    action: "agent.config.updated",
    resourceType: "agent_runtime_config",
    resourceId: result.agentCredentialId,
    actorUserId: req.user?.sub,
    hospitalId: result.hospitalId,
    metadata: {
      requestId: req.requestId,
      version: result.version,
    },
  });

  logger.info("agent_runtime_config_updated", {
    requestId: req.requestId,
    agentCredentialId: result.agentCredentialId,
    hospitalId: result.hospitalId,
    version: result.version,
    actorUserId: req.user?.sub,
  });

  // Push inmediato al agente si está conectado via WebSocket
  const commandId = sendCommand(
    { hospitalId: result.hospitalId, agentId: result.agentId },
    "update_config",
    { config: result.config, version: result.version },
  );
  if (commandId) {
    logger.info("agent_config_pushed_via_ws", {
      agentId: result.agentId,
      version: result.version,
      commandId,
    });
  }

  return sendSuccess(res, {
    message: "Configuracion de agente actualizada",
    data: result,
  });
});

const getAuthenticatedAgentRuntimeConfig = asyncHandler(async (req, res) => {
  const result = await agentService.getAgentRuntimeConfig(req.agent.id);

  return sendSuccess(res, {
    message: "Configuracion runtime del agente",
    data: result,
  });
});

const updateAgentCredential = asyncHandler(async (req, res) => {
  const updates = {};
  const name = getOptionalString(req.body, "name");
  const isActive = getOptionalBoolean(req.body, "isActive");
  const rotateToken = getOptionalBoolean(req.body, "rotateToken");

  if (name !== undefined) {
    updates.name = name;
  }

  if (isActive !== undefined) {
    updates.isActive = isActive;
  }

  if (rotateToken !== undefined) {
    updates.rotateToken = rotateToken;
  }

  if (Object.keys(updates).length === 0) {
    throw new AppError(400, "No hay campos para actualizar", "VALIDATION_ERROR");
  }

  const result = await agentService.updateAgentCredential(req.params.id, updates, {
    hospitalId: req.user.role === "root" ? undefined : req.user.hospitalId,
  });

  await auditService.createAuditLog({
    action: "agent.credential.updated",
    resourceType: "agent_credential",
    resourceId: result.credential.id,
    actorUserId: req.user?.sub,
    hospitalId: result.credential.hospitalId,
    metadata: {
      requestId: req.requestId,
      updatedFields: Object.keys(updates),
      tokenRotated: Boolean(result.token),
    },
  });

  logger.info("agent_credential_updated", {
    requestId: req.requestId,
    credentialId: result.credential.id,
    hospitalId: result.credential.hospitalId,
    actorUserId: req.user?.sub,
    updatedFields: Object.keys(updates),
    tokenRotated: Boolean(result.token),
  });

  return sendSuccess(res, {
    message: "Credencial de agente actualizada",
    data: {
      ...result.credential,
      ...(result.token ? { token: result.token } : {}),
    },
  });
});

const deleteAgentCredential = asyncHandler(async (req, res) => {
  const credential = await agentService.deleteAgentCredential(req.params.id, {
    hospitalId: req.user.role === "root" ? undefined : req.user.hospitalId,
  });

  await auditService.createAuditLog({
    action: "agent.credential.deleted",
    resourceType: "agent_credential",
    resourceId: credential.id,
    actorUserId: req.user?.sub,
    hospitalId: credential.hospitalId,
    metadata: {
      requestId: req.requestId,
      agentId: credential.agentId,
      tokenId: credential.tokenId,
    },
  });

  logger.info("agent_credential_deleted", {
    requestId: req.requestId,
    credentialId: credential.id,
    hospitalId: credential.hospitalId,
    actorUserId: req.user?.sub,
    agentId: credential.agentId,
  });

  return sendSuccess(res, {
    message: "Credencial de agente eliminada",
    data: null,
  });
});

const getAgentConnections = asyncHandler(async (req, res) => {
  const hospitalId =
    resolveTenantScope(req.user) ||
    (req.user.role === "root" ? req.query.hospitalId : undefined);
  const connectedAgents = getConnectedAgents({ hospitalId });
  return sendSuccess(res, {
    message: "Agentes conectados vía WebSocket",
    data: { connectedAgents, count: connectedAgents.length },
  });
});

const sendAgentCommand = asyncHandler(async (req, res) => {
  const { agentId } = req.params;
  const type = getRequiredString(req.body, "type");
  const hospitalId =
    resolveTenantScope(req.user) ||
    (req.user.role === "root" ? getRequiredString(req.body, "hospitalId") : undefined);
  const payload = req.body.payload ?? {};

  if (!isAgentConnected({ hospitalId, agentId })) {
    throw new AppError(409, "El agente no está conectado", "AGENT_NOT_CONNECTED");
  }

  const commandId = sendCommand({ hospitalId, agentId }, type, payload);

  logger.info("agent_command_dispatched", {
    requestId: req.requestId,
    hospitalId,
    agentId,
    type,
    commandId,
    actorUserId: req.user?.sub,
  });

  return sendSuccess(res, {
    message: "Comando enviado al agente",
    data: { hospitalId, agentId, type, commandId },
  });
});

// POST /api/agent/infra-events
// Recibe eventos de infraestructura del tracker: antenna_disconnected,
// antenna_ok, reader_offline, reader_online.
// El tracker autentica con el mismo token de agente (agentAuthMiddleware).
const createAgentInfraEvent = asyncHandler(async (req, res) => {
  const { hospitalId, agentId, name: agentName } = req.agent;

  const eventType = req.body?.eventType;
  const metadata  = { ...( req.body?.metadata ?? {}), agentName };

  // Para alertas de antena, el scopeKey incluye el puerto para que
  // cada antena tenga su propia alerta independiente (port:1, port:2, etc.)
  const antennaPort = metadata.antennaPort ?? null;
  const antennaScopeKey = antennaPort != null ? `port:${antennaPort}` : null;

  const RESOLVE_TYPES = {
    antenna_ok:      "antenna_disconnected",
    reader_online:   "reader_offline",
    temperature_ok:  "temperature_high",
  };
  const CREATE_TYPES  = {
    antenna_disconnected: {
      alertType: "antenna_disconnected",
      message: `Antena desconectada${metadata.antennaLabel ? ` — ${metadata.antennaLabel}` : (antennaPort != null ? ` (puerto ${antennaPort})` : "")}${metadata.zoneName ? ` en ${metadata.zoneName}` : ""}`,
      scopeKey: antennaScopeKey,
    },
    reader_offline: {
      alertType: "reader_offline",
      message: `Lector RFID sin respuesta${metadata.zoneName ? ` — ${metadata.zoneName}` : ""}`,
      scopeKey: null,
    },
    temperature_high: {
      alertType: "temperature_high",
      message: metadata.message ?? `Temperatura elevada del lector${metadata.zoneName ? ` — ${metadata.zoneName}` : ""}`,
      scopeKey: "temperature",
    },
  };

  if (RESOLVE_TYPES[eventType]) {
    const alertType = RESOLVE_TYPES[eventType];
    // Cada tipo de resolución tiene su propio scopeKey:
    // antenna_ok → resolver puerto específico; temperature_ok → "temperature"; reader_online → sin scope
    let scopeKey = null;
    if (eventType === "antenna_ok") scopeKey = antennaScopeKey;
    else if (eventType === "temperature_ok") scopeKey = "temperature";
    const result = await resolveInfraAlert({ hospitalId, agentId, alertType, scopeKey });
    logger.info("agent_infra_event_resolve", { agentId, hospitalId, eventType, scopeKey, ...result });
    return sendSuccess(res, { statusCode: 200, message: "Alerta de infra resuelta", data: result });
  }

  if (CREATE_TYPES[eventType]) {
    const { alertType, message, scopeKey } = CREATE_TYPES[eventType];
    const result = await createInfraAlert({ hospitalId, agentId, alertType, message, metadata, scopeKey });
    logger.info("agent_infra_event_create", { agentId, hospitalId, eventType, scopeKey, ...result });
    return sendSuccess(res, { statusCode: result.alertCreated ? 201 : 200, message: result.alertCreated ? "Alerta de infra creada" : "Alerta ya existente, refreshed", data: result });
  }

  return sendSuccess(res, { statusCode: 200, message: "Evento de infra ignorado (tipo desconocido)", data: { eventType } });
});

// POST /api/agent/alerts
// Recibe una notificación del agente cuando detecta un tag en una zona
// clasificada como critical o exit. Crea una alerta si el dispositivo existe.
const createAgentAlert = asyncHandler(async (req, res) => {
  const result = await agentService.createAgentZoneAlert({
    payload: req.body,
    authenticatedAgent: req.agent,
  });

  logger.info("agent_zone_alert", {
    ...result,
    agentId: req.agent?.agentId,
    hospitalId: req.agent?.hospitalId,
    zoneId: req.body?.zoneId,
    chipId: req.body?.chipId,
  });

  return sendSuccess(res, {
    statusCode: result.alertCreated ? 201 : 200,
    message: result.alertCreated ? "Alerta creada" : "Sin alerta creada",
    data: result,
  });
});

module.exports = {
  createAgentAlert,
  createAgentCredential,
  createAgentEvent,
  createAgentInfraEvent,
  deleteAgentCredential,
  getAgentConnections,
  getAgentCredentialConfig,
  getAgentCredentials,
  getAgentEvents,
  getAgentHealth,
  getAuthenticatedAgentRuntimeConfig,
  sendAgentCommand,
  updateAgentCredential,
  updateAgentCredentialConfig,
};
