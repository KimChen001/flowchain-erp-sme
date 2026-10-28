import { send } from "../utils/http.mjs";
import { createErrorReporter, logOnlyEnv } from "../observability/error-reporter.mjs";
import { logServerError, sendInternalServerError } from "../utils/safe-errors.mjs";
import { requestIdOf } from "./request-logging.mjs";

// The reporter defaults to the one createHttpRequestHandler gives its routes,
// so thrown errors and route-level reports share one alert rate limit.
export function withServerErrorBoundary(handleRequest, { logger, reporter } = {}) {
  const errors = reporter || handleRequest.errorReporter || createErrorReporter({ logger, env: logOnlyEnv() });
  return async function handleRequestWithErrorBoundary(req, res) {
    // A route that answers 500 by itself without reporting is still recorded.
    res.once?.("finish", () => {
      if (res.statusCode === 500) errors.reportUnreported(req, res.statusCode);
    });
    try {
      return await handleRequest(req, res);
    } catch (error) {
      const requestId = requestIdOf(req);
      if (res.headersSent) {
        // The status line is already out, so the caller cannot be told; the
        // failure must still be recorded.
        logServerError(error, { reporter: errors, req, requestId, status: res.statusCode, phase: "after_headers" });
        res.end();
        return;
      }
      return sendInternalServerError(res, send, error, { reporter: errors, req, requestId, phase: "boundary" });
    }
  };
}
