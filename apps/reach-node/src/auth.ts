import { timingSafeEqual } from "node:crypto";

import type { RequestHandler } from "express";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";

import type { AppConfig } from "./config.js";

export function tokensEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function oauthResourceMetadataUrl(config: AppConfig): string {
  const resource = new URL(config.oauthResourceUrl!);
  const suffix = resource.pathname === "/" ? "" : resource.pathname;
  return new URL(`/.well-known/oauth-protected-resource${suffix}`, resource).href;
}

export function createBearerAuth(
  config: AppConfig,
  oauthVerifier?: OAuthTokenVerifier,
): RequestHandler {
  return async (request, response, next) => {
    if (config.allowNoAuth && !config.authToken && !oauthVerifier) {
      next();
      return;
    }

    const authorization = request.header("authorization");
    const match = authorization?.match(/^Bearer\s+(.+)$/i);
    const suppliedToken = match?.[1];
    if (suppliedToken && config.authToken && tokensEqual(suppliedToken, config.authToken)) {
      next();
      return;
    }

    if (suppliedToken && oauthVerifier && config.oauthResourceUrl) {
      try {
        const authInfo = await oauthVerifier.verifyAccessToken(suppliedToken);
        const expectedResource = new URL(config.oauthResourceUrl).href;
        if (
          authInfo.expiresAt !== undefined &&
          authInfo.expiresAt >= Date.now() / 1000 &&
          authInfo.resource?.href === expectedResource &&
          authInfo.scopes.includes("mcp:tools")
        ) {
          next();
          return;
        }
      } catch {
        // Return the same challenge for every invalid token.
      }
    }

    const challenge = config.oauthEnabled
      ? `Bearer realm="krako-reach", error="invalid_token", scope="mcp:tools", resource_metadata="${oauthResourceMetadataUrl(config)}"`
      : 'Bearer realm="krako-reach"';
    response.status(401).set("WWW-Authenticate", challenge).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
  };
}

export function createHostValidation(config: AppConfig): RequestHandler {
  return (request, response, next) => {
    if (!config.allowedHosts || config.allowedHosts.length === 0) {
      next();
      return;
    }
    const rawHost = request.header("host");
    let hostname = "";
    try {
      hostname = new URL(`http://${rawHost ?? ""}`).hostname.toLowerCase();
    } catch {
      // The empty value is rejected below.
    }
    if (!config.allowedHosts.includes(hostname)) {
      response.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32002, message: "Host header is not allowed" },
        id: null,
      });
      return;
    }
    next();
  };
}
