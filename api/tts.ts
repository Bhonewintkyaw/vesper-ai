import { handleTts } from './_geminiApp.js';
import type { ApiRequest, ApiResponse } from './_geminiApp.js';

export default async function handler(req: ApiRequest, res: ApiResponse) {
  return handleTts(req, res);
}
