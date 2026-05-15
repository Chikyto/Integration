const auditService = require("../audit/audit.service");
const authService = require("./auth.service");
const asyncHandler = require("../../utils/async-handler");
const { sendSuccess } = require("../../utils/http-response");
const {
  getRequiredEmail,
  getRequiredString,
} = require("../../utils/validation");

const login = asyncHandler(async (req, res) => {
  const email = getRequiredEmail(req.body, "email");
  const password = getRequiredString(req.body, "password");
  const result = await authService.login({ email, password });

  await auditService.createAuditLog({
    action: "auth.login.response_sent",
    resourceType: "user",
    resourceId: result.user.id,
    actorUserId: result.user.id,
    hospitalId: result.user.hospitalId,
    metadata: { requestId: req.requestId },
  });

  return sendSuccess(res, {
    message: "Login exitoso",
    data: result,
  });
});

module.exports = { login };
