const AppError = require("../../utils/app-error");

const TAG_RFID_STATUSES = ["available", "assigned", "inactive", "damaged", "lost"];

const normalizeTagRfid = (value) => {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new AppError(400, "tag invalido", "VALIDATION_ERROR");
  }

  const normalizedValue = value.trim().toUpperCase();

  if (!normalizedValue) {
    throw new AppError(400, "tag invalido", "VALIDATION_ERROR");
  }

  return normalizedValue;
};

const validateTagRfidStatus = (status) => {
  if (!TAG_RFID_STATUSES.includes(status)) {
    throw new AppError(400, "status invalido", "VALIDATION_ERROR");
  }

  return status;
};

module.exports = { TAG_RFID_STATUSES, normalizeTagRfid, validateTagRfidStatus };
