// Vercel entry: every path is rewritten here (see vercel.json); lib/app.mjs does the routing.
import { handle } from "../lib/app.mjs";

export default { fetch: handle };
