import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import configsRouter from "./configs";
import nodesRouter from "./nodes";
import subtopicsRouter from "./subtopics";
import eventsRouter from "./events";
import adminRouter from "./admin";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(configsRouter);
router.use(nodesRouter);
router.use(subtopicsRouter);
router.use(eventsRouter);
router.use(adminRouter);

export default router;
