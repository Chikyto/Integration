let ioInstance = null;
const getHospitalRoom = (hospitalId) => `hospital:${hospitalId}`;
const ROOT_ROOM = "role:root";

const setIo = (io) => {
  ioInstance = io;
};

const emit = (event, payload) => {
  if (!ioInstance) {
    return;
  }

  ioInstance.emit(event, payload);
};

const emitToHospital = (hospitalId, event, payload) => {
  if (!ioInstance) {
    return;
  }

  if (hospitalId) {
    ioInstance.to(getHospitalRoom(hospitalId)).emit(event, payload);
  }

  ioInstance.to(ROOT_ROOM).emit(event, payload);
};

module.exports = { setIo, emit, emitToHospital, getHospitalRoom, ROOT_ROOM };
