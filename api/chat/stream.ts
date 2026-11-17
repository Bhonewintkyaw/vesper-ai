import { handleChatStream } from '../_geminiApp.js';
import type { ApiRequest, ApiResponse } from '../_geminiApp.js';

export default async function handler(req: ApiRequest, res: ApiResponse) {
  return handleChatStream(req, res);
}
