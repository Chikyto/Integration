const AppError = require("../../../utils/app-error");
const {
  getOptionalString,
  getRequiredString,
  getRequiredTimestampString,
} = require("../../../utils/validation");

const TAG_EVENT_PREFIX = "tag";

const getOptionalInteger = (source, fieldName) => {
  const value = source[fieldName];

  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Number.isInteger(value)) {
    throw new AppError(400, `El campo ${fieldName} es invalido`, "VALIDATION_ERROR");
  }

  return value;
};

const getOptionalObject = (source, fieldName) => {
  const value = source[fieldName];

  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(400, `El campo ${fieldName} es invalido`, "VALIDATION_ERROR");
  }

  return value;
};

const isTagEvent = (eventType) => {
  return eventType.toLowerCase().startsWith(TAG_EVENT_PREFIX);
};

const validateAgentEventPayload = (payload) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AppError(400, "Payload invalido", "VALIDATION_ERROR");
  }

  const event = {
    agentId: getOptionalString(payload, "agentId"),
    hospitalId: getOptionalString(payload, "hospitalId"),
    readerId: getRequiredString(payload, "readerId"),
    antennaId: getOptionalString(payload, "antennaId"),
    chipId: getOptionalString(payload, "chipId"),
    eventType: getRequiredString(payload, "eventType"),
    timestamp: getRequiredTimestampString(payload, "timestamp"),
    rssi: getOptionalInteger(payload, "rssi"),
    zoneId: getOptionalString(payload, "zoneId"),
    zoneName: getOptionalString(payload, "zoneName"),
    port: getOptionalInteger(payload, "port"),
    rawTag: getOptionalString(payload, "rawTag"),
    antennaLabel: getOptionalString(payload, "antennaLabel"),
    returnLossDb: getOptionalInteger(payload, "returnLossDb"),
    message: getOptionalString(payload, "message"),
    rawData: getOptionalObject(payload, "rawData"),
  };

  if (isTagEvent(event.eventType) && !event.chipId) {
    throw new AppError(
      400,
      "El campo chipId es obligatorio para eventos de tag",
      "VALIDATION_ERROR"
    );
  }

  return event;
};

module.exports = {
  validateAgentEventPayload,
};
