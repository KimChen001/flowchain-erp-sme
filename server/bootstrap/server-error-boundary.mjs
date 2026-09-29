import { send } from "../utils/http.mjs";
import { logServerError, sendInternalServerError } from "../utils/safe-errors.mjs";
import { requestIdOf } from "./request-logging.mjs";

export function withServerErrorBoundary(handleRequest, { logger } = {}) {
  return async function handleRequestWithErrorBoundary(req, res) {
    try {
      return await handleRequest(req, res);
    } catch (error) {
      const requestId = requestIdOf(req);
      if (res.headersSent) {
        // The status line is already out, so the caller cannot be told; the
        // failure must still be recorded.
        logServerError(error, { logger, requestId });
        res.end();
        return;
      }
      return sendInternalServerError(res, send, error, { logger, requestId });
    }
  };
}
