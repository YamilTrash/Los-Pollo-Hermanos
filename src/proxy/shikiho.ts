import { Request, RequestHandler, Router } from "express";
import * as http from "http";
import { createProxyMiddleware } from "http-proxy-middleware";
import { logger } from "../logger";
import { createQueueMiddleware } from "./queue";
import { ipLimiter } from "./rate-limit";
import { handleProxyError } from "./middleware/common";
import {
  blockZoomers,
  createPreprocessorMiddleware,
  finalizeBody,
} from "./middleware/request";
import { createOnProxyResHandler } from "./middleware/response";
import { keyPool } from "../key-management";

const getModelsResponse = () => {
  const variants = ["shikiho-v1"];
  const models = variants.map((id) => ({
    id,
    object: "model",
    created: new Date().getTime(),
    owned_by: "shikiho",
    permission: [],
    root: "claude",
    parent: null,
  }));
  return { object: "list", data: models };
};

const handleModelRequest: RequestHandler = (_req, res) => {
  res.status(200).json(getModelsResponse());
};

const rewriteShikihoRequest = (
  proxyReq: http.ClientRequest,
  req: Request,
  res: http.ServerResponse
) => {
  const rewriterPipeline = [blockZoomers, finalizeBody];

  // shikiho doesn't use api keys but most of the code expects one to be present
  req.key = keyPool.get("claude-v1");

  // shikiho always uses SSE
  req.isStreaming = true;

  try {
    for (const rewriter of rewriterPipeline) {
      rewriter(proxyReq, req, res, {});
    }
  } catch (error) {
    req.log.error(error, "Error while executing proxy rewriter");
    proxyReq.destroy(error as Error);
  }
};

const shikihoProxy = createQueueMiddleware(
  createProxyMiddleware({
    target:
      "https://api-server.langchain.rozetta-deveopment-beta.rozetta-dxtravel.com",
    changeOrigin: true,
    on: {
      proxyReq: rewriteShikihoRequest,
      proxyRes: createOnProxyResHandler([]),
      error: handleProxyError,
    },
    selfHandleResponse: true,
    logger,
    pathRewrite: {
      // Send OpenAI-compat requests to the Shikiho API.
      "^/v1/chat/completions": "api/anth",
    },
  })
);

const shikihoRouter = Router();
// Fix paths because clients don't consistently use the /v1 prefix.
shikihoRouter.use((req, _res, next) => {
  if (!req.path.startsWith("/v1/")) {
    req.url = `/v1${req.url}`;
  }
  next();
});
shikihoRouter.get("/v1/models", handleModelRequest);
// OpenAI-to-Shikiho compatibility endpoint.
shikihoRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware({ inApi: "openai", outApi: "shikiho" }),
  shikihoProxy
);
// Redirect browser requests to the homepage.
shikihoRouter.get("*", (req, res, next) => {
  const isBrowser = req.headers["user-agent"]?.includes("Mozilla");
  if (isBrowser) {
    res.redirect("/");
  } else {
    next();
  }
});

export const shikiho = shikihoRouter;
