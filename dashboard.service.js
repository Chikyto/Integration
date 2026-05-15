const { prisma } = require("../config/db");

const getDashboardState = async ({ hospitalId }) => {
  const [devices, alerts, recentEvents] = await Promise.all([
    prisma.device.findMany({
      where: hospitalId ? { hospitalId } : undefined,
      orderBy: {
        updatedAt: "desc",
      },
      take: 20,
    }),
    prisma.alert.findMany({
      where: hospitalId ? { hospitalId } : undefined,
      orderBy: {
        createdAt: "desc",
      },
      take: 20,
    }),
    prisma.event.findMany({
      where: hospitalId ? { hospitalId } : undefined,
      orderBy: {
        timestamp: "desc",
      },
      take: 20,
    }),
  ]);

  return {
    devices,
    alerts,
    recentEvents,
  };
};

module.exports = { getDashboardState };
