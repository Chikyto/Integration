const crypto = require("crypto");
const { Prisma } = require("@prisma/client");
const { prisma } = require("../../config/db");
const hospitalService = require("../hospitals/hospital.service");
const { notifyCriticalAlertById } = require("../alerts/alert-notification.service");
const AppError = require("../../utils/app-error");
const { compareHash, hashValue } = require("../../utils/hash");
const logger = require("../../utils/logger");

const DEFAULT_READER_CONFIG = {
  host: "192.168.0.178",
  port: 4001,
  reader_address: 243,
  timeout: 3,
};

const toFiniteNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeAntennaPortKey = (portKey) => {
  if (typeof portKey === "number" && Number.isInteger(portKey) && portKey > 0) {
    return String(portKey);
  }

  if (typeof portKey !== "string") {
    return null;
  }

  const numericPort = Number.parseInt(portKey.replace(/\D/g, ""), 10);
  return Number.isInteger(numericPort) && numericPort > 0 ? String(numericPort) : null;
};

const buildDefaultRuntimeConfig = (credential) => {
  const zoneId = `zone_${credential.agentId}`;

  return {
    zones: [
      {
        zone_id: zoneId,
        zone_name: credential.name,
        enabled: true,
        reader: { ...DEFAULT_READER_CONFIG },
        antennas: {
          "1": {
            enabled: true,
            name: "Antena 1",
            location: "port_1",
            description: "",
            power_dbm: 27,
          },
          "2": {
            enabled: false,
            name: "Antena 2",
            location: "port_2",
            description: "",
            power_dbm: 27,
          },
          "3": {
            enabled: false,
            name: "Antena 3",
            location: "port_3",
            description: "",
            power_dbm: 27,
          },
          "4": {
            enabled: false,
            name: "Antena 4",
            location: "port_4",
            description: "",
            power_dbm: 27,
          },
        },
        power_dbm: 27,
        scan_interval_ms: 200,
      },
    ],
  };
};

const normalizeRuntimeConfig = (config, credential) => {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new AppError(400, "La configuracion del agente es invalida", "VALIDATION_ERROR");
  }

  const zones = Array.isArray(config.zones) ? config.zones : [];

  if (zones.length === 0) {
    throw new AppError(400, "Debe existir al menos una zona configurada", "VALIDATION_ERROR");
  }

  return {
    zones: zones.map((zone, index) => {
      const zoneId = typeof zone?.zone_id === "string" && zone.zone_id.trim()
        ? zone.zone_id.trim()
        : `zone_${credential.agentId}_${index + 1}`;
      const zoneName = typeof zone?.zone_name === "string" && zone.zone_name.trim()
        ? zone.zone_name.trim()
        : `${credential.name} ${index + 1}`;
      const antennasObject = zone?.antennas && typeof zone.antennas === "object"
        ? zone.antennas
        : {};
      const normalizedAntennasEntries = Object.entries(antennasObject)
        .map(([portKey, antenna]) => {
          const normalizedPortKey = normalizeAntennaPortKey(portKey);

          if (!normalizedPortKey) {
            return null;
          }

          const validCategories = ["pending", "safe", "transit", "critical"];
          const antennaCategory =
            typeof antenna?.category === "string" && validCategories.includes(antenna.category)
              ? antenna.category
              : null;
          const antennaIsExit =
            antenna?.is_exit === true ? true : antenna?.is_exit === false ? false : null;

          return [
            normalizedPortKey,
            {
              enabled: antenna?.enabled !== false,
              name: typeof antenna?.name === "string" ? antenna.name.trim() : `Antena ${normalizedPortKey}`,
              location:
                typeof antenna?.location === "string" && antenna.location.trim()
                  ? antenna.location.trim()
                  : `port_${normalizedPortKey}`,
              description: typeof antenna?.description === "string" ? antenna.description.trim() : "",
              power_dbm:
                antenna?.power_dbm === null || antenna?.power_dbm === undefined || antenna?.power_dbm === ""
                  ? null
                  : toFiniteNumber(antenna.power_dbm, null),
              category: antennaCategory,
              is_exit: antennaIsExit,
            },
          ];
        })
        .filter(Boolean);
      const normalizedAntennas =
        normalizedAntennasEntries.length > 0
          ? Object.fromEntries(normalizedAntennasEntries)
          : {
              "1": {
                enabled: true,
                name: "Antena 1",
                location: "port_1",
                description: "",
                power_dbm: 27,
                category: null,
                is_exit: null,
              },
            };

      return {
        zone_id: zoneId,
        zone_name: zoneName,
        enabled: zone?.enabled !== false,
        reader: {
          host: typeof zone?.reader?.host === "string" && zone.reader.host.trim()
            ? zone.reader.host.trim()
            : DEFAULT_READER_CONFIG.host,
          port: toFiniteNumber(zone?.reader?.port, DEFAULT_READER_CONFIG.port),
          reader_address: toFiniteNumber(
            zone?.reader?.reader_address,
            DEFAULT_READER_CONFIG.reader_address
          ),
          timeout: toFiniteNumber(zone?.reader?.timeout, DEFAULT_READER_CONFIG.timeout),
        },
        antennas: normalizedAntennas,
        power_dbm: toFiniteNumber(zone?.power_dbm, 27),
        scan_interval_ms: toFiniteNumber(zone?.scan_interval_ms, 200),
      };
    }),
  };
};

const mapRowToAgentEvent = (row) => {
  return {
    id: typeof row.id === "bigint" ? row.id.toString() : String(row.id),
    agentId: row.agentId,
    hospitalId: row.hospitalId,
    readerId: row.readerId,
    antennaId: row.antennaId,
    chipId: row.chipId,
    eventType: row.eventType,
    timestamp: row.timestamp instanceof Date ? row.timestamp.toISOString() : row.timestamp,
    rssi: row.rssi,
    zoneId: row.zoneId,
    zoneName: row.zoneName,
    port: row.port,
    rawTag: row.rawTag,
    antennaLabel: row.antennaLabel,
    returnLossDb: row.returnLossDb,
    message: row.message,
    rawData: row.rawData,
    createdAt:
      row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  };
};

const buildAgentCredentialSelect = () => {
  return {
    id: true,
    name: true,
    agentId: true,
    tokenId: true,
    isActive: true,
    lastSeenAt: true,
    hospitalId: true,
    createdAt: true,
    updatedAt: true,
    hospital: {
      select: {
        id: true,
        code: true,
        name: true,
        slug: true,
      },
    },
  };
};

const generateTokenId = () => {
  return `agt_${crypto.randomBytes(8).toString("hex")}`;
};

const generateTokenSecret = () => {
  return crypto.randomBytes(24).toString("hex");
};

const buildIssuedAgentToken = ({ tokenId, secret }) => {
  return `${tokenId}.${secret}`;
};

const getHospitalOrFail = async (hospitalId) => {
  const hospital = await prisma.hospital.findUnique({
    where: { id: hospitalId },
    select: {
      id: true,
      code: true,
      name: true,
      slug: true,
    },
  });

  if (!hospital) {
    throw new AppError(400, "hospitalId no es valido", "VALIDATION_ERROR");
  }

  return hospital;
};

const getAgentCredentialOrFail = async (id, options = {}) => {
  const credential = await prisma.agentCredential.findFirst({
    where: {
      id,
      ...(options.hospitalId ? { hospitalId: options.hospitalId } : {}),
    },
    select: buildAgentCredentialSelect(),
  });

  if (!credential) {
    throw new AppError(404, "Agente no encontrado", "AGENT_NOT_FOUND");
  }

  return credential;
};

const parseAgentBearerToken = (token) => {
  const separatorIndex = token.indexOf(".");

  if (separatorIndex <= 0 || separatorIndex === token.length - 1) {
    throw new AppError(401, "Token invalido", "AGENT_AUTH_INVALID");
  }

  return {
    tokenId: token.slice(0, separatorIndex),
    secret: token.slice(separatorIndex + 1),
  };
};

const authenticateAgentToken = async (token) => {
  const { tokenId, secret } = parseAgentBearerToken(token);
  const agent = await prisma.agentCredential.findUnique({
    where: { tokenId },
    select: {
      id: true,
      name: true,
      agentId: true,
      tokenHash: true,
      isActive: true,
      hospitalId: true,
      hospital: {
        select: {
          id: true,
          isActive: true,
          serviceStatus: true,
          licenseStatus: true,
          licenseExpiresAt: true,
          userLimit: true,
          deviceLimit: true,
        },
      },
    },
  });

  if (!agent) {
    throw new AppError(401, "Token invalido", "AGENT_AUTH_INVALID");
  }

  const isValidSecret = await compareHash(secret, agent.tokenHash);

  if (!isValidSecret) {
    throw new AppError(401, "Token invalido", "AGENT_AUTH_INVALID");
  }

  if (!agent.isActive) {
    throw new AppError(403, "Agente deshabilitado", "AGENT_DISABLED");
  }

  hospitalService.assertHospitalOperational(agent.hospital);

  await prisma.agentCredential.update({
    where: { id: agent.id },
    data: {
      lastSeenAt: new Date(),
    },
  });

  return {
    id: agent.id,
    name: agent.name,
    agentId: agent.agentId,
    hospitalId: agent.hospitalId,
  };
};

const createAgentCredential = async ({ name, agentId, hospitalId }) => {
  await getHospitalOrFail(hospitalId);

  const tokenId = generateTokenId();
  const secret = generateTokenSecret();
  const tokenHash = await hashValue(secret);

  const credential = await prisma.agentCredential.create({
    data: {
      name,
      agentId,
      hospitalId,
      tokenId,
      tokenHash,
    },
    select: buildAgentCredentialSelect(),
  });

  return {
    credential,
    token: buildIssuedAgentToken({ tokenId, secret }),
  };
};

const listAgentCredentials = async ({ hospitalId, isActive, pagination, sort }) => {
  const where = {
    ...(hospitalId ? { hospitalId } : {}),
    ...(typeof isActive === "boolean" ? { isActive } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.agentCredential.findMany({
      where,
      select: buildAgentCredentialSelect(),
      orderBy: sort.orderBy,
      skip: pagination.skip,
      take: pagination.limit,
    }),
    prisma.agentCredential.count({ where }),
  ]);

  return { items, total };
};

const listAgentEvents = async ({ hospitalId, type, dateRange, pagination, sort }) => {
  const where = {
    ...(hospitalId ? { hospitalId } : {}),
    ...(type ? { eventType: type } : {}),
    ...(dateRange ? { timestamp: dateRange } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.rfidEvent.findMany({
      where,
      orderBy: sort.orderBy,
      skip: pagination.skip,
      take: pagination.limit,
    }),
    prisma.rfidEvent.count({ where }),
  ]);

  return {
    items: items.map(mapRowToAgentEvent),
    total,
  };
};

const getAgentRuntimeConfig = async (id, options = {}) => {
  const credential = await getAgentCredentialOrFail(id, options);
  const row = await prisma.agentRuntimeConfig.findUnique({
    where: { agentCredentialId: credential.id },
    select: {
      agentCredentialId: true,
      hospitalId: true,
      version: true,
      config: true,
      updatedAt: true,
    },
  });

  return {
    agentCredentialId: credential.id,
    hospitalId: credential.hospitalId,
    version: row ? Number(row.version) : 0,
    config: row?.config ?? buildDefaultRuntimeConfig(credential),
    updatedAt: row?.updatedAt ?? credential.updatedAt,
  };
};

const upsertAgentRuntimeConfig = async (id, config, options = {}) => {
  const credential = await getAgentCredentialOrFail(id, options);
  const normalizedConfig = normalizeRuntimeConfig(config, credential);
  const row = await prisma.agentRuntimeConfig.upsert({
    where: { agentCredentialId: credential.id },
    update: {
      hospitalId: credential.hospitalId,
      config: normalizedConfig,
      version: {
        increment: 1,
      },
    },
    create: {
      agentCredentialId: credential.id,
      hospitalId: credential.hospitalId,
      version: 1,
      config: normalizedConfig,
    },
    select: {
      agentCredentialId: true,
      hospitalId: true,
      version: true,
      config: true,
      updatedAt: true,
    },
  });

  await hospitalService.syncHospitalZonesFromAgentConfig({
    hospitalId: credential.hospitalId,
    agentCredentialId: credential.id,
    zones: normalizedConfig.zones,
  });

  return {
    agentCredentialId: row.agentCredentialId,
    agentId: credential.agentId,
    hospitalId: row.hospitalId,
    version: Number(row.version),
    config: row.config,
    updatedAt: row.updatedAt,
  };
};

const updateAgentCredential = async (id, data, options = {}) => {
  const credential = await prisma.agentCredential.findFirst({
    where: {
      id,
      ...(options.hospitalId ? { hospitalId: options.hospitalId } : {}),
    },
    select: buildAgentCredentialSelect(),
  });

  if (!credential) {
    throw new AppError(404, "Agente no encontrado", "AGENT_NOT_FOUND");
  }

  const updateData = {};
  let issuedToken;

  if (data.name !== undefined) {
    updateData.name = data.name;
  }

  if (data.isActive !== undefined) {
    updateData.isActive = data.isActive;
  }

  if (data.rotateToken) {
    const secret = generateTokenSecret();
    updateData.tokenHash = await hashValue(secret);
    issuedToken = buildIssuedAgentToken({
      tokenId: credential.tokenId,
      secret,
    });
  }

  const updatedCredential = await prisma.agentCredential.update({
    where: { id },
    data: updateData,
    select: buildAgentCredentialSelect(),
  });

  return {
    credential: updatedCredential,
    token: issuedToken,
  };
};

const deleteAgentCredential = async (id, options = {}) => {
  const credential = await prisma.agentCredential.findFirst({
    where: {
      id,
      ...(options.hospitalId ? { hospitalId: options.hospitalId } : {}),
    },
    select: buildAgentCredentialSelect(),
  });

  if (!credential) {
    throw new AppError(404, "Agente no encontrado", "AGENT_NOT_FOUND");
  }

  await prisma.agentCredential.delete({
    where: { id },
  });

  return credential;
};

const createAgentEvent = async ({ payload, authenticatedAgent }) => {
  const payloadAgentId = payload.agentId;
  const payloadHospitalId = payload.hospitalId;

  if (payloadAgentId && payloadAgentId !== authenticatedAgent.agentId) {
    throw new AppError(
      403,
      "El payload no coincide con el agente autenticado",
      "AGENT_SCOPE_MISMATCH"
    );
  }

  if (payloadHospitalId && payloadHospitalId !== authenticatedAgent.hospitalId) {
    throw new AppError(
      403,
      "El payload no coincide con el hospital autenticado",
      "AGENT_SCOPE_MISMATCH"
    );
  }

  await hospitalService.syncHospitalZoneSignal({
    hospitalId: authenticatedAgent.hospitalId,
    zoneId: payload.zoneId,
    zoneName: payload.zoneName,
  });

  const rows = await prisma.$queryRaw(
    Prisma.sql`
      INSERT INTO "rfid_events" (
        "agentId",
        "hospitalId",
        "readerId",
        "antennaId",
        "chipId",
        "eventType",
        "timestamp",
        "rssi",
        "zoneId",
        "zoneName",
        "port",
        "rawTag",
        "antennaLabel",
        "returnLossDb",
        "message",
        "rawData"
      )
      VALUES (
        ${authenticatedAgent.agentId},
        ${authenticatedAgent.hospitalId},
        ${payload.readerId},
        ${payload.antennaId ?? null},
        ${payload.chipId},
        ${payload.eventType},
        ${new Date(payload.timestamp)},
        ${payload.rssi ?? null},
        ${payload.zoneId ?? null},
        ${payload.zoneName ?? null},
        ${payload.port ?? null},
        ${payload.rawTag ?? null},
        ${payload.antennaLabel ?? null},
        ${payload.returnLossDb ?? null},
        ${payload.message ?? null},
        ${payload.rawData ? JSON.stringify(payload.rawData) : null}::jsonb
      )
      RETURNING
        "id",
        "agentId",
        "hospitalId",
        "readerId",
        "antennaId",
        "chipId",
        "eventType",
        "timestamp",
        "rssi",
        "zoneId",
        "zoneName",
        "port",
        "rawTag",
        "antennaLabel",
        "returnLossDb",
        "message",
        "rawData",
        "createdAt"
    `
  );

  return mapRowToAgentEvent(rows[0]);
};

// Crea una alerta de zona cuando el agente detecta un tag en una zona
// clasificada como critical o exit. Solo crea la alerta si el chip está
// asignado a un dispositivo conocido del hospital.
const createAgentZoneAlert = async ({ payload, authenticatedAgent }) => {
  const { zoneId, zoneName, chipId, category, isExit, antennaPort, antennaLabel } = payload;

  // Buscar el dispositivo por el tag RFID dentro del hospital autenticado.
  // El tag puede estar en Device.tag (campo directo) o en TagRfid.tag (asignación).
  // El tracker envía el ID corto del TagParser (primeros 4 bytes del EPC, ej: "E2801170").
  // El frontend USB puede guardar el EPC completo ("E28011700000020123456789").
  // Se intenta primero exact match, luego prefix match (EPC completo que empiece
  // con el ID corto) para manejar ambos formatos sin forzar una conversión.
  let device = await prisma.device.findFirst({
    where: { hospitalId: authenticatedAgent.hospitalId, tag: chipId },
    select: { id: true, name: true },
  });

  if (!device) {
    // Exact match en TagRfid
    let tagRecord = await prisma.tagRfid.findFirst({
      where: {
        tag: chipId,
        assignedDevice: { hospitalId: authenticatedAgent.hospitalId },
      },
      select: { assignedDevice: { select: { id: true, name: true } } },
    });

    // Fallback: el EPC guardado en el front es el completo y el tracker manda
    // solo el prefijo (primeros 4 bytes). Válido cuando chipId.length <= 8.
    if (!tagRecord && chipId && chipId.length <= 8) {
      tagRecord = await prisma.tagRfid.findFirst({
        where: {
          tag: { startsWith: chipId, mode: "insensitive" },
          assignedDevice: { hospitalId: authenticatedAgent.hospitalId },
        },
        select: { assignedDevice: { select: { id: true, name: true } } },
      });
      if (tagRecord) {
        logger.info("alert_tag_prefix_match", {
          chipId,
          agentId: authenticatedAgent.agentId,
          hospitalId: authenticatedAgent.hospitalId,
        });
      }
    }

    device = tagRecord?.assignedDevice ?? null;
  }

  if (!device) {
    logger.warn("alert_device_not_found", {
      chipId,
      agentId: authenticatedAgent.agentId,
      hospitalId: authenticatedAgent.hospitalId,
      hint: "Verificar que el chip esté asignado a un dispositivo del hospital y que el formato del tag coincida",
    });
  }

  const alertType = isExit ? "exit_zone" : "critical_zone";
  const severity = isExit || category === "critical" ? "critical" : "warning";

  // Dedup: si ya hay una alerta abierta/reconocida del mismo tipo para este
  // dispositivo, refrescarla con los datos de la detección actual en lugar de
  // crear una nueva. Así el panel muestra la hora y antena más recientes.
  const existing = await prisma.alert.findFirst({
    where: {
      hospitalId: authenticatedAgent.hospitalId,
      alertType,
      status: { in: ["open", "acknowledged"] },
      ...(device
        ? { deviceId: device.id }
        : { metadata: { path: ["chipId"], equals: chipId } }),
    },
    select: { id: true, metadata: true },
  });

  if (existing) {
    await prisma.alert.update({
      where: { id: existing.id },
      data: {
        metadata: {
          ...(existing.metadata || {}),
          lastDetectedAt: new Date().toISOString(),
          antennaPort: antennaPort ?? null,
          antennaLabel: antennaLabel ?? null,
          zoneId: zoneId ?? null,
          zoneName: zoneName ?? null,
        },
      },
    });
    return { alertCreated: false, reason: "duplicate_refreshed", alertId: existing.id };
  }

  if (!device) {
    return { alertCreated: false, reason: "device_not_found", chipId };
  }

  const message = isExit
    ? `Equipo detectado en zona de salida: ${zoneName || zoneId}`
    : `Equipo detectado en zona critica: ${zoneName || zoneId}`;

  const alert = await prisma.alert.create({
    data: {
      alertType,
      message,
      status: "open",
      hospitalId: authenticatedAgent.hospitalId,
      deviceId: device.id,
      metadata: {
        zoneId: zoneId ?? null,
        zoneName: zoneName ?? null,
        zoneCategory: category ?? "critical",
        isExitZone: isExit ?? false,
        chipId: chipId ?? null,
        severity,
        deviceName: device.name,
        antennaPort: antennaPort ?? null,
        antennaLabel: antennaLabel ?? null,
      },
    },
    select: { id: true },
  });

  try {
    await notifyCriticalAlertById(alert.id);
  } catch (error) {
    logger.error("critical_alert_email_failed", {
      alertId: alert.id,
      hospitalId: authenticatedAgent.hospitalId,
      error: error.message,
    });
  }

  return { alertCreated: true, alertId: alert.id };
};

module.exports = {
  authenticateAgentToken,
  createAgentCredential,
  createAgentEvent,
  createAgentZoneAlert,
  deleteAgentCredential,
  listAgentCredentials,
  listAgentEvents,
  getAgentRuntimeConfig,
  upsertAgentRuntimeConfig,
  updateAgentCredential,
};
