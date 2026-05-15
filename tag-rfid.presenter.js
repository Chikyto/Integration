const toTagRfidResponse = (tagRfid) => {
  if (!tagRfid) {
    return null;
  }

  return {
    id: tagRfid.id,
    tag: tagRfid.tag,
    status: tagRfid.status,
    notes: tagRfid.notes,
    isActive: tagRfid.isActive,
    createdByUserId: tagRfid.createdByUserId,
    updatedByUserId: tagRfid.updatedByUserId,
    assignedDeviceId: tagRfid.assignedDeviceId,
    assignedAt: tagRfid.assignedAt,
    lastSeenAt: tagRfid.lastSeenAt,
    createdAt: tagRfid.createdAt,
    updatedAt: tagRfid.updatedAt,
    device: tagRfid.assignedDevice
      ? {
          id: tagRfid.assignedDevice.id,
          name: tagRfid.assignedDevice.name,
          type: tagRfid.assignedDevice.type,
          status: tagRfid.assignedDevice.status,
        }
      : null,
  };
};

module.exports = { toTagRfidResponse };
