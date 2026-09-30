#!/usr/bin/env node

import { runSmoke } from "./smoke-live.mjs";

await runSmoke("connect");
