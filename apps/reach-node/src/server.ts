import { loadConfig } from "./config.js";
import { errorMessage } from "./errors.js";
import { startHttpServer } from "./http-server.js";
import { createServices } from "./mcp-server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const services = createServices(config);
  const running = await startHttpServer(config, services);
  const endpointUrl = config.publicUrl
    ? `${config.publicUrl}${config.endpoint}`
    : `http://${config.host}:${config.port}${config.endpoint}`;

  console.log(`KORA Reach listening at ${endpointUrl}`);
  if (config.reachConsoleEnabled) {
    console.log(`Reach Console: http://${config.host}:${config.port}${config.reachConsolePath}`);
  }
  console.log(`default cwd: ${config.defaultCwd}`);
  console.log(services.fileService.policy?.enabled
    ? "execution mode: workspace admission policy; shell execution " +
      (services.fileService.policy.allowExecution ? "allowed with host permissions" : "disabled")
    : "execution mode: unrestricted host access");
  console.log(
    config.allowNoAuth && !config.authToken && !config.oauthEnabled
      ? "authentication: disabled"
      : config.oauthEnabled
        ? config.authToken
          ? "authentication: static bearer + OAuth 2.1 (DCR/PKCE)"
          : "authentication: OAuth 2.1 (DCR/PKCE)"
        : "authentication: bearer token",
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`received ${signal}; shutting down`);
    try {
      await running.close();
      process.exitCode = 0;
    } catch (error) {
      console.error("shutdown failed:", errorMessage(error));
      process.exitCode = 1;
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("KORA Reach failed to start:", errorMessage(error));
  process.exitCode = 1;
});
