/** Imported first by every process entry point, so later modules read the cleaned settings. See lib/env-clean. */
import { cleanEnv } from "../lib/env-clean";

cleanEnv();
