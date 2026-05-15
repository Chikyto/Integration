const { prisma } = require("../../config/db");
const auditService = require("../audit/audit.service");
const hospitalService = require("../hospitals/hospital.service");
const { compareHash } = require("../../utils/hash");
const AppError = require("../../utils/app-error");
const { generateToken } = require("../../utils/jwt");
const logger = require("../../utils/logger");

function isGlobalRole(role) {
  return role === "root" || role === "root_comercial";
}

const login = async ({ email, password }) => {
  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      code: true,
      email: true,
      password: true,
      role: true,
      isActive: true,
      hospitalId: true,
    },
  });

  if (!user || !user.password) {
    logger.warn("auth_login_failed", {
      email,
      reason: "user_not_found_or_without_password",
    });

    await auditService.createAuditLog({
      action: "auth.login.failed",
      resourceType: "auth",
      metadata: { email },
    });

    throw new AppError(401, "Credenciales invalidas", "AUTH_INVALID_CREDENTIALS");
  }

  if (!user.isActive) {
    logger.warn("auth_login_failed", {
      userId: user.id,
      hospitalId: user.hospitalId,
      email: user.email,
      reason: "user_disabled",
    });

    await auditService.createAuditLog({
      action: "auth.login.failed",
      resourceType: "user",
      resourceId: user.id,
      actorUserId: user.id,
      hospitalId: user.hospitalId,
      metadata: { email, reason: "disabled" },
    });

    throw new AppError(401, "Usuario deshabilitado", "AUTH_USER_DISABLED");
  }

  const isValidPassword = await compareHash(password, user.password);

  if (!isValidPassword) {
    logger.warn("auth_login_failed", {
      userId: user.id,
      hospitalId: user.hospitalId,
      email: user.email,
      reason: "invalid_password",
    });

    await auditService.createAuditLog({
      action: "auth.login.failed",
      resourceType: "user",
      resourceId: user.id,
      actorUserId: user.id,
      hospitalId: user.hospitalId,
      metadata: { email },
    });

    throw new AppError(401, "Credenciales invalidas", "AUTH_INVALID_CREDENTIALS");
  }

  if (!isGlobalRole(user.role)) {
    const hospital = await hospitalService.getHospitalOperationalContext(user.hospitalId);

    try {
      hospitalService.assertHospitalOperational(hospital);
    } catch (error) {
      await auditService.createAuditLog({
        action: "auth.login.failed",
        resourceType: "hospital",
        resourceId: user.hospitalId,
        actorUserId: user.id,
        hospitalId: user.hospitalId,
        metadata: { email, reason: error.code },
      });

      throw error;
    }
  }

  const token = generateToken({
    sub: user.id,
    email: user.email,
    role: user.role,
    hospitalId: user.hospitalId,
  });

  await auditService.createAuditLog({
    action: "auth.login.succeeded",
    resourceType: "user",
    resourceId: user.id,
    actorUserId: user.id,
    hospitalId: user.hospitalId,
  });

  logger.info("auth_login_succeeded", {
    userId: user.id,
    hospitalId: user.hospitalId,
    role: user.role,
  });

  return {
    token,
    user: {
      id: user.id,
      code: user.code,
      email: user.email,
      role: user.role,
      hospitalId: user.hospitalId,
    },
  };
};

module.exports = { login };
