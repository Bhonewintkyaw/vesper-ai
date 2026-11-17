import { handleHealth } from './_geminiApp.js';
import type { ApiRequest, ApiResponse } from './_geminiApp.js';

export default function handler(req: ApiRequest, res: ApiResponse) {
  return handleHealth(req, res);
}
