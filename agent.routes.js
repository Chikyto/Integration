const express = require("express");
const asyncHandler = require("../../utils/async-handler");
const authMiddleware = require("../../middlewares/auth.middleware");
const roleMiddleware = require("../../middlewares/role.middleware");
const {
  createAgentAlert,
  createAgentCredential,
  createAgentEvent,
  createAgentInfraEvent,
  deleteAgentCredential,
  getAgentCredentialConfig,
  getAgentCredentials,
  getAgentConnections,
  getAgentEvents,
  getAgentHealth,
  getAuthenticatedAgentRuntimeConfig,
  sendAgentCommand,
  updateAgentCredential,
  updateAgentCredentialConfig,
} = require("./agent.controller");
const agentAuthMiddleware = require("./middlewares/agent-auth.middleware");

const router = express.Router();

router.post(
  "/credentials",
  authMiddleware,
  roleMiddleware("admin"),
  createAgentCredential
);
router.get(
  "/credentials",
  authMiddleware,
  roleMiddleware("admin"),
  getAgentCredentials
);
router.get(
  "/events",
  authMiddleware,
  roleMiddleware("admin", "monitor"),
  getAgentEvents
);
router.get(
  "/credentials/:id/config",
  authMiddleware,
  roleMiddleware("admin"),
  getAgentCredentialConfig
);
router.put(
  "/credentials/:id/config",
  authMiddleware,
  roleMiddleware("admin"),
  updateAgentCredentialConfig
);
router.patch(
  "/credentials/:id",
  authMiddleware,
  roleMiddleware("admin"),
  updateAgentCredential
);
router.delete(
  "/credentials/:id",
  authMiddleware,
  roleMiddleware("admin"),
  deleteAgentCredential
);
router.get("/runtime-config", agentAuthMiddleware, asyncHandler(getAuthenticatedAgentRuntimeConfig));
router.get("/health", agentAuthMiddleware, asyncHandler(getAgentHealth));
router.post("/events", agentAuthMiddleware, asyncHandler(createAgentEvent));
router.post("/alerts", agentAuthMiddleware, asyncHandler(createAgentAlert));
router.post("/infra-events", agentAuthMiddleware, asyncHandler(createAgentInfraEvent));

// Conexiones WebSocket activas y envío de comandos remotos
router.get(
  "/connections",
  authMiddleware,
  roleMiddleware("admin"),
  getAgentConnections,
);
router.post(
  "/connections/:agentId/command",
  authMiddleware,
  roleMiddleware("admin"),
  sendAgentCommand,
);

module.exports = router;
