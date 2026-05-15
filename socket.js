const { Server } = require("socket.io");
const { prisma } = require("../config/db");
const hospitalService = require("../modules/hospitals/hospital.service");
const { setIo, getHospitalRoom, ROOT_ROOM } = require("./broadcaster");
const { getDashboardState } = require("./dashboard.service");
const logger = require("../utils/logger");
const { verifyToken } = require("../utils/jwt");

function isGlobalRole(role) {
  return role === "root" || role === "root_comercial";
}

const getTokenFromHandshake = (socket) => {
  const authToken = socket.handshake.auth?.token;

  if (authToken) {
    return authToken;
  }

  const authHeader = socket.handshake.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }

  return authHeader.split(" ")[1];
};

const initSocket = (server) => {
  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST", "PATCH"],
    },
    pingInterval: 60000,
    pingTimeout: 30000,
  });

  io.use((socket, next) => {
    Promise.resolve()
      .then(async () => {
      const token = getTokenFromHandshake(socket);

      if (!token) {
        throw new Error("Socket token requerido");
      }

      const payload = verifyToken(token);
      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: {
          id: true,
          email: true,
          role: true,
          hospitalId: true,
          isActive: true,
        },
      });

      if (!user || !user.isActive) {
        throw new Error("Socket usuario no valido");
      }

      socket.data.user = {
        sub: user.id,
        email: user.email,
        role: user.role,
        hospitalId: user.hospitalId,
      };

      if (!isGlobalRole(user.role)) {
        const hospital = await hospitalService.getHospitalOperationalContext(user.hospitalId);
        hospitalService.assertHospitalOperational(hospital);
      }

      next();
      })
      .catch((error) => {
        if (error.name === "TokenExpiredError") {
          return next(new Error("Socket token vencido"));
        }

        return next(new Error(error.message || "Socket token invalido"));
      });
  });

  setIo(io);

  io.on("connection", async (socket) => {
    const hospitalId = socket.data.user?.hospitalId;
    const scopedHospitalId = isGlobalRole(socket.data.user?.role) ? undefined : hospitalId;

    if (isGlobalRole(socket.data.user?.role)) {
      socket.join(ROOT_ROOM);
    } else {
      socket.join(getHospitalRoom(hospitalId));
    }

    logger.info("socket_connected", {
      socketId: socket.id,
      hospitalId,
      userId: socket.data.user?.sub,
    });

    const dashboardState = await getDashboardState({
      hospitalId: scopedHospitalId,
    });

    socket.emit("dashboard:state", dashboardState);

    socket.on("dashboard:subscribe", async () => {
      const state = await getDashboardState({
        hospitalId: scopedHospitalId,
      });
      socket.emit("dashboard:state", state);
    });
  });

  return io;
};

module.exports = { initSocket };
