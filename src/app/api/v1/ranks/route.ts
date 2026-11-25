import { listRanks } from "@/domain/ranks/ranks";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const GET = apiHandler(routes["GET /ranks"], async ({ run }) => run((tx) => listRanks(tx)));
