const AppError = require("../../utils/app-error");
const { prisma } = require("../../config/db");
const { toTagRfidResponse } = require("./tag-rfid.presenter");

const tagRfidInclude = {
  assignedDevice: {
    select: {
      id: true,
      name: true,
      type: true,
      status: true,
      hospitalId: true,
      hospital: { select: { id: true, name: true } },
    },
  },
};

const isTagRfidInventoryEnabled = async () => {
  const result = await prisma.$queryRawUnsafe("SELECT to_regclass('public.\"Tag_rfid\"')::text AS name");
  return Boolean(result?.[0]?.name);
};

const findOrCreateTagRfidForAssignment = async (tx, { tag, actorUserId }) => {
  const existingTagRfid = await tx.tagRfid.findFirst({
    where: { tag: { equals: tag, mode: "insensitive" } },
    include: tagRfidInclude,
  });

  if (existingTagRfid) {
    return existingTagRfid;
  }

  try {
    return await tx.tagRfid.create({
      data: {
        tag,
        status: "available",
        isActive: true,
        createdByUserId: actorUserId,
        updatedByUserId: actorUserId,
      },
      include: tagRfidInclude,
    });
  } catch (error) {
    if (error.code !== "P2002") {
      throw error;
    }

    const createdByAnotherRequest = await tx.tagRfid.findFirst({
      where: { tag: { equals: tag, mode: "insensitive" } },
      include: tagRfidInclude,
    });

    if (createdByAnotherRequest) {
      return createdByAnotherRequest;
    }

    throw error;
  }
};

const createTagRfidBulk = async ({ tags, actorUserId }) => {
  try {
    return await prisma.$transaction(async (tx) => {
      const createdItems = [];
      for (const item of tags) {
        const created = await tx.tagRfid.create({
          data: {
            tag: item.tag,
            status: item.status,
            notes: item.notes,
            isActive: item.isActive,
            createdByUserId: actorUserId,
            updatedByUserId: actorUserId,
          },
          include: tagRfidInclude,
        });
        createdItems.push(toTagRfidResponse(created));
      }
      return createdItems;
    });
  } catch (error) {
    if (error.code === "P2002") {
      throw new AppError(409, "Uno o mas tags ya existen en inventario", "TAG_RFID_ALREADY_EXISTS");
    }

    throw error;
  }
};

const listTagRfids = async ({ status, isActive, assigned, pagination, sort }) => {
  const where = {
    ...(status ? { status } : {}),
    ...(isActive === undefined ? {} : { isActive }),
    ...(assigned === undefined ? {} : assigned ? { assignedDeviceId: { not: null } } : { assignedDeviceId: null }),
  };
  const [items, total] = await Promise.all([
    prisma.tagRfid.findMany({
      where,
      include: tagRfidInclude,
      orderBy: sort.orderBy,
      skip: pagination.skip,
      take: pagination.limit,
    }),
    prisma.tagRfid.count({ where }),
  ]);

  return { items: items.map(toTagRfidResponse), total };
};

const updateTagRfid = async (id, data, options = {}) => {
  const tagRfid = await prisma.tagRfid.findUnique({ where: { id } });

  if (!tagRfid) {
    throw new AppError(404, "Tag RFID no encontrado", "TAG_RFID_NOT_FOUND");
  }

  const updated = await prisma.tagRfid.update({
    where: { id },
    data: { ...data, updatedByUserId: options.actorUserId },
    include: tagRfidInclude,
  });

  return toTagRfidResponse(updated);
};

const assignTagRfidToDevice = async ({ deviceId, tag, actorUserId }) => {
  return prisma.$transaction(async (tx) => {
    const tagRfid = await findOrCreateTagRfidForAssignment(tx, { tag, actorUserId });

    if (!tagRfid.isActive || ["inactive", "damaged", "lost"].includes(tagRfid.status)) {
      throw new AppError(409, "El tag no esta disponible para asignacion", "TAG_RFID_UNAVAILABLE");
    }

    if (tagRfid.assignedDeviceId && tagRfid.assignedDeviceId !== deviceId) {
      throw new AppError(409, "El tag ya esta asignado a otro equipo", "TAG_ALREADY_ASSIGNED");
    }

    await tx.tagRfid.updateMany({
      where: { assignedDeviceId: deviceId, NOT: { id: tagRfid.id } },
      data: {
        assignedDeviceId: null,
        assignedAt: null,
        status: "available",
        updatedByUserId: actorUserId,
      },
    });

    return tx.tagRfid.update({
      where: { id: tagRfid.id },
      data: {
        assignedDeviceId: deviceId,
        assignedAt: new Date(),
        status: "assigned",
        updatedByUserId: actorUserId,
      },
      include: tagRfidInclude,
    });
  });
};

const unassignTagRfidFromDevice = async ({ deviceId, actorUserId }) => {
  const tagRfid = await prisma.tagRfid.findFirst({
    where: { assignedDeviceId: deviceId },
    include: tagRfidInclude,
  });

  if (!tagRfid) {
    return null;
  }

  return prisma.tagRfid.update({
    where: { id: tagRfid.id },
    data: {
      assignedDeviceId: null,
      assignedAt: null,
      status: "available",
      updatedByUserId: actorUserId,
    },
    include: tagRfidInclude,
  });
};

module.exports = {
  assignTagRfidToDevice,
  createTagRfidBulk,
  isTagRfidInventoryEnabled,
  listTagRfids,
  unassignTagRfidFromDevice,
  updateTagRfid,
};
