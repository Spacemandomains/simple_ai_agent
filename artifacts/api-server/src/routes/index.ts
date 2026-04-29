import { Router, type IRouter } from "express";
import healthRouter from "./health";
import chatRouter from "./chat";
import mcpProxyRouter from "./mcp-proxy";
import walletRouter from "./wallet";

const router: IRouter = Router();

router.use(healthRouter);
router.use(chatRouter);
router.use(mcpProxyRouter);
router.use(walletRouter);

export default router;
