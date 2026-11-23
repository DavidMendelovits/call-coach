// Runs the WebLLM engine (Qwen) off the main thread so the transcript and meters stay smooth.
import { WebWorkerMLCEngineHandler } from "@mlc-ai/web-llm";
const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg) => handler.onmessage(msg);
