import { router } from "../../../trpc.js";
import { authorizedProcedure } from "../../../procedures.js";
import { scanArbitrage } from "./scan/handler.js";
import { ZArbitrageScanInputSchema } from "./scan/schema.js";

export const arbitrageRouter = router({
  /** Read-only cross-venue scan. Public order books, no keys, no orders. */
  scan: authorizedProcedure.input(ZArbitrageScanInputSchema).query(scanArbitrage),
});
