import { send } from "../utils/http.mjs";
import { sendInternalServerError } from "../utils/safe-errors.mjs";

export function withServerErrorBoundary(handleRequest) {
  return async function handleRequestWithErrorBoundary(req, res) {
    try {
      return await handleRequest(req, res);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      return sendInternalServerError(res, send, error);
    }
  };
}
