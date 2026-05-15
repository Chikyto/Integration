const AppError = require("../../../utils/app-error");
const agentService = require("../agent.service");

const agentAuthMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next(new AppError(401, "Token requerido", "AGENT_AUTH_REQUIRED"));
  }

  const providedToken = authHeader.slice("Bearer ".length).trim();

  if (!providedToken) {
    return next(new AppError(401, "Token requerido", "AGENT_AUTH_REQUIRED"));
  }

  try {
    req.agent = await agentService.authenticateAgentToken(providedToken);
    return next();
  } catch (error) {
    if (error instanceof AppError) {
      return next(error);
    }

    return next(new AppError(401, "Token invalido", "AGENT_AUTH_INVALID"));
  }
};

module.exports = agentAuthMiddleware;
