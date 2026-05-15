const auditService = require("../audit/audit.service");
const AppError = require("../../utils/app-error");
const asyncHandler = require("../../utils/async-handler");
const { sendSuccess } = require("../../utils/http-response");
const { buildPaginationMeta, parseBooleanQuery, parsePagination, parseSort } = require("../../utils/list-query");
const { getOptionalBoolean, getOptionalString } = require("../../utils/validation");
const tagRfidService = require("./tag-rfid.service");
const { normalizeTagRfid, validateTagRfidStatus } = require("./tag-rfid.utils");

const ensureInventoryEnabled = async () => {
  if (!(await tagRfidService.isTagRfidInventoryEnabled())) {
    throw new AppError(503, "La migracion de Tag_rfid todavia no fue aplicada", "TAG_RFID_MIGRATION_PENDING");
  }
};

const normalizeBulkTagItem = (item) => {
  if (typeof item === "string") {
    return {
      tag: normalizeTagRfid(item),
      status: "available",
      notes: undefined,
      isActive: true,
    };
  }

  return {
    tag: normalizeTagRfid(item?.tag),
    status: item?.status ? validateTagRfidStatus(item.status) : "available",
    notes: getOptionalString(item ?? {}, "notes"),
    isActive: getOptionalBoolean(item ?? {}, "isActive") ?? true,
  };
};

const createTagRfidBulk = asyncHandler(async (req, res) => {
  await ensureInventoryEnabled();
  if (!Array.isArray(req.body.tags) || req.body.tags.length === 0) {
    throw new AppError(400, "El campo tags es obligatorio", "VALIDATION_ERROR");
  }

  const tags = req.body.tags.map(normalizeBulkTagItem);
  const uniqueTags = new Set(tags.map((item) => item.tag));

  if (uniqueTags.size !== tags.length) {
    throw new AppError(409, "Hay tags duplicados en la carga", "TAG_RFID_DUPLICATED_INPUT");
  }

  const created = await tagRfidService.createTagRfidBulk({
    tags,
    actorUserId: req.user?.sub,
  });

  await auditService.createAuditLog({
    action: "tag_rfid.bulk_created",
    resourceType: "tag_rfid",
    actorUserId: req.user?.sub,
    hospitalId: req.user?.hospitalId,
    metadata: { requestId: req.requestId, count: created.length },
  });

  return sendSuccess(res, { statusCode: 201, message: "Tags RFID cargados", data: created });
});

const getTagRfids = asyncHandler(async (req, res) => {
  await ensureInventoryEnabled();
  const pagination = parsePagination(req.query);
  const sort = parseSort(req.query, ["id", "tag", "status", "createdAt", "updatedAt"], "createdAt");
  const result = await tagRfidService.listTagRfids({
    status: req.query.status,
    isActive: parseBooleanQuery(req.query.isActive, "isActive"),
    assigned: parseBooleanQuery(req.query.assigned, "assigned"),
    pagination,
    sort,
  });

  return sendSuccess(res, {
    message: "Lista de tags RFID",
    data: result.items,
    pagination: buildPaginationMeta({ page: pagination.page, limit: pagination.limit, total: result.total }),
  });
});

const updateTagRfid = asyncHandler(async (req, res) => {
  await ensureInventoryEnabled();
  const id = Number.parseInt(req.params.id, 10);
  const updates = {};
  const notes = getOptionalString(req.body, "notes");
  const isActive = getOptionalBoolean(req.body, "isActive");

  if (notes !== undefined) updates.notes = notes;
  if (isActive !== undefined) updates.isActive = isActive;
  if (req.body.status !== undefined) updates.status = validateTagRfidStatus(req.body.status);

  if (Object.keys(updates).length === 0) {
    throw new AppError(400, "No hay campos para actualizar", "VALIDATION_ERROR");
  }

  if (!Number.isInteger(id) || id < 1) {
    throw new AppError(400, "Id invalido", "VALIDATION_ERROR");
  }

  const tagRfid = await tagRfidService.updateTagRfid(id, updates, {
    actorUserId: req.user?.sub,
  });

  await auditService.createAuditLog({
    action: "tag_rfid.updated",
    resourceType: "tag_rfid",
    resourceId: String(tagRfid.id),
    actorUserId: req.user?.sub,
    hospitalId: req.user?.hospitalId,
    metadata: { requestId: req.requestId, updatedFields: Object.keys(updates) },
  });

  return sendSuccess(res, { message: "Tag RFID actualizado", data: tagRfid });
});

module.exports = { createTagRfidBulk, getTagRfids, updateTagRfid };
